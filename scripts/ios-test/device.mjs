import { copyFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appId, check, outputRoot, readJson, record, sha256, writeJson } from './common.mjs';
import { connectedDevice, deviceCommand, installedApp, verifySignedApp } from './apple.mjs';
import { runDeviceDriver } from './xctest.mjs';

const automatedCases = { website: 'fresh-website', pause: 'scheduled-pause' };

export function isAutomatedProfile(profile) {
    return Object.hasOwn(automatedCases, profile);
}

const cases = {
    'upgrade-continuity': ['smoke', 'Compare prior and current focus spaces, settings and one already-restricted/allowed Safari pair.'],
    'relaunch': ['smoke', 'Background and re-open, then swipe away and re-open. Verify Blocker launches and state is present.'],
    'scheduled-pause': ['automated', 'Run the pause profile to verify a saved scheduled pause, background reblocking and early resume.'],
    'fresh-website': ['automated', 'Run the website profile for a fresh Safari restriction and real expiry.'],
    '14.0-picker': ['full', 'Run picker protection and owned app shielding/removal in manual checklist §14.0.'],
    '14.1-allowlist': ['dedicated', 'Run the allowlist matrix in §14.1 on a dedicated configuration.'],
    '14.2-token-refresh': ['dedicated', 'Run §14.2 on a dedicated iOS 26.5+ device.'],
    '14.2-availability': ['full', 'Check startup and real schedule transitions on pre-26.5 iOS as specified in §14.2.'],
    '14.3-pause-resume': ['full', 'Complete the normal challenge on an owned fixture. Observe pause expiry in background and Resume now. Run timed manual and schedule cases in §14.3.'],
    '14.3-long-failure': ['dedicated', 'Run next-day, midnight, overlap, missed callback and forced registration failure cases in §14.3.'],
    '14.4-schedule-boundaries': ['full', 'Register a future owned website block. Observe start and end in Safari while Blocker is closed.'],
    '14.4-notifications': ['dedicated', 'Run onboarding, permission, delivery, wording, pause/stop warnings, edit and overlap cases in §14.4.'],
    '14.4-persistence': ['dedicated', 'Run the reboot and time zone cases in §14.4.'],
};

const finalStatuses = ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'];

function capture(run, label) {
    const file = `${label}-${Date.now()}.png`;
    deviceCommand(['device', 'capture', 'screenshot', '--device', run.report.device.udid,
        '--destination', join(dirname(run.file), file)]);
    if (!existsSync(join(dirname(run.file), file))) throw new Error('CoreDevice did not write a screenshot.');
    return file;
}

function launch(device, bundle, url) {
    deviceCommand(['device', 'process', 'launch', '--device', device.udid,
        ...(url ? ['--payload-url', url] : []), bundle]);
}

export function requiredCases(lane, profile) {
    if (isAutomatedProfile(profile)) return [automatedCases[profile]];
    return Object.keys(cases).filter(id => cases[id][0] === 'smoke' || (lane === 'device-full' && cases[id][0] === 'full'));
}

export function pendingCases(report) {
    return requiredCases(report.lane, report.profile).filter(id => !['PASS', 'NOT_APPLICABLE'].includes(report.cases[id]?.status));
}

function isModern(os) {
    const [major, minor] = os.split('.').map(Number);
    return major > 26 || (major === 26 && minor >= 5);
}

function initialise(run) {
    const modern = isModern(run.report.device.os);
    for (const [id, [lane, description]] of Object.entries(cases)) {
        const status = (id === '14.2-token-refresh' && !modern) || (id === '14.2-availability' && modern) ? 'NOT_APPLICABLE' : 'NOT_RUN';
        const reason = status === 'NOT_APPLICABLE' ? `This case does not apply to iOS/iPadOS ${run.report.device.os}.`
            : lane === 'dedicated' ? `Dedicated-device lane. ${description}` : description;
        run.report.cases[id] = { status, reason, evidence: [] };
    }
    writeJson(run.file, run.report);
}

function openBuild(path) {
    const file = realpathSync(path);
    const receipt = readJson(file);
    if (!file.startsWith(`${realpathSync(outputRoot)}/`) || receipt.schema !== 1 || receipt.lane !== 'build'
        || receipt.mode !== 'device' || receipt.cases?.['native-build']?.status !== 'PASS'
        || !receipt.artifact?.app || basename(receipt.artifact.app) !== receipt.artifact.app) {
        throw new Error('Use a successful device build report from this worktree.');
    }
    return { receipt, app: join(dirname(file), receipt.artifact.app) };
}

export function sameInstalledApp(first, current) {
    return Boolean(first?.url && current?.url && first.url === current.url
        && first.bundleId === current.bundleId && first.version === current.version
        && first.build === current.build && first.developerSigned === current.developerSigned);
}

function verifyInventory(app, expected) {
    if (!app || app.version !== expected.version || app.build !== expected.build || app.developerSigned !== true || !app.url) {
        throw new Error('CoreDevice inventory does not match the expected development installation.');
    }
}

function install(run, buildReport, baseline) {
    const { receipt, app } = openBuild(buildReport);
    if (receipt.device?.udid !== run.report.device.udid) throw new Error('Build preflight selected a different device.');
    if (!run.report.installedBefore) throw new Error('In-place smoke requires an existing installation. Use a dedicated test device for a fresh install.');
    if (!baseline && !isAutomatedProfile(run.report.profile)) throw new Error('An in-place update requires --baseline with the prior UI/rules/control observations.');
    const result = check(run, 'in-place-install', 'Verified the local signature and installed the same bundle ID in place', log => {
        const bundles = verifySignedApp(app, log);
        if (JSON.stringify(bundles) !== JSON.stringify(receipt.artifact.bundles)) {
            throw new Error('App or extensions differ from the build report.');
        }
        run.report.build = { revision: receipt.revision, configuration: receipt.configuration, bundles };
        run.report.baseline = baseline || 'CoreDevice app inventory only. Upgrade continuity was not tested.';
        run.report.installStartedAt = new Date().toISOString();
        writeJson(run.file, run.report);
        const result = deviceCommand(['device', 'install', 'app', '--device', run.report.device.udid, app]);
        writeJson(join(dirname(run.file), 'install.json'), result);
        run.report.installedAfter = installedApp(run.report.device);
        verifyInventory(run.report.installedAfter, bundles.find(bundle => bundle.id === appId));
    }, 'BLOCKED');
    return result.ok;
}

export function assertObservation(report, id, status, note, evidence) {
    if (!cases[id] || report.cases[id]?.status === 'NOT_APPLICABLE') throw new Error('Unknown or inapplicable assisted case.');
    if (cases[id][0] === 'dedicated') throw new Error('Record this dedicated-device case separately using the manual checklist.');
    if (isAutomatedProfile(report.profile) || cases[id][0] === 'automated') {
        throw new Error('The automated profile only accepts XCTest results.');
    }
    if (report.lane !== 'device-full' && cases[id][0] !== 'smoke') throw new Error('Use device-full for this case.');
    if (!finalStatuses.includes(status) || !note?.trim()) throw new Error('Supply --status PASS|FAIL|BLOCKED|NOT_RUN and a specific --note.');
    if (status !== 'PASS') return;
    if (!evidence.length) throw new Error('PASS requires observable evidence. Supply --evidence with a screenshot, video or contemporaneous observation log.');

}

function attachEvidence(run, paths) {
    return paths.map((source, index) => {
        const data = readFileSync(source);
        if (!data.length) throw new Error(`Evidence file is empty: ${source}`);
        const path = `evidence-${Date.now()}-${index}-${basename(source)}`;
        copyFileSync(source, join(dirname(run.file), path));
        return { path, sha256: sha256(data) };
    });
}

async function automatedDevice(run, args, resume) {
    if (args.case || args.capture) {
        throw new Error('The automated profile drives the app and records observations automatically.');
    }
    if (resume) {
        if (!args.recover || !run.report.fixture?.deadline || run.report.fixture.cleanup !== 'pending') {
            throw new Error('Use --recover with an automated report that has pending fixture cleanup.');
        }
    } else {
        run.report.fixture = {
            name: `Rbtest${randomUUID().slice(0, 8).replace(/[0-9a-f]/g, hex => 'abcdefghijklmnop'[Number.parseInt(hex, 16)])}`,
            target: 'example.org', control: 'example.com',
            plannedAt: new Date().toISOString(), cleanup: 'pending',
        };
        writeJson(run.file, run.report);
        console.log(`Owned fixture: ${run.report.fixture.name}`);
    }
    const ok = await runDeviceDriver(run, { provision: args['provision-driver'], recover: args.recover });
    run.report.installedCurrent = installedApp(run.report.device);
    if (!sameInstalledApp(run.report.installedAfter || run.report.installedBefore, run.report.installedCurrent)) {
        throw new Error('Installed app inventory changed during this run.');
    }
    return ok && (args.recover || pendingCases(run.report).length === 0);
}

export async function deviceRun(run, args, resume) {
    const selected = connectedDevice(args.device);
    if (resume && (selected.udid !== run.report.device?.udid || selected.os !== run.report.device.os)) {
        throw new Error('The report belongs to a different device or OS version.');
    }
    run.report.device = selected;
    if (!resume) {
        run.report.profile = args.profile || 'default';
        run.report.build = { revision: 'UNVERIFIED', reason: 'Existing install. No matching local artifact was supplied.' };
        initialise(run);
        run.report.installedBefore = installedApp(selected);
        writeJson(run.file, run.report);
        if (args.build && !install(run, args.build, args.baseline)) return false;
        if (!args.build && !run.report.installedBefore) throw new Error('Blocker is not installed on this device.');
        if (isAutomatedProfile(run.report.profile)) return automatedDevice(run, args, false);
        const launchCheck = check(run, 'launch', 'CoreDevice accepted foreground launch', () => {
            launch(selected, appId);
        }, 'BLOCKED');
        if (!launchCheck.ok) return false;
        await new Promise(resolve => setTimeout(resolve, 3_000));
        const screenshot = capture(run, 'launch');
        record(run, 'launch', 'PASS', 'CoreDevice accepted launch and wrote a screenshot. Review its contents separately.', [screenshot]);
    } else {
        run.report.installedCurrent = installedApp(selected);
        const expected = run.report.installedAfter || run.report.installedBefore;
        if (!sameInstalledApp(expected, run.report.installedCurrent)) {
            throw new Error('Installed app inventory changed since this run started. Start a new run and recover any previous owned fixture manually.');
        }
    }

    if (isAutomatedProfile(run.report.profile)) return automatedDevice(run, args, true);
    if (args.recover || args['provision-driver']) throw new Error('Use these options with an automated website or pause profile.');
    if (args.capture) console.log(`Captured: ${capture(run, 'assisted')}`);
    if (args.case) {
        assertObservation(run.report, args.case, args.status, args.note, args.evidence);
        record(run, args.case, args.status, args.note, attachEvidence(run, args.evidence));
    }
    run.report.installedCurrent = installedApp(selected);
    if (!sameInstalledApp(run.report.installedAfter || run.report.installedBefore, run.report.installedCurrent)) {
        throw new Error('Installed app inventory changed during this run.');
    }
    run.report.checkedAt = new Date().toISOString();
    writeJson(run.file, run.report);
    const pending = pendingCases(run.report);
    if (pending.length) console.log(`Required assisted results still open: ${pending.join(', ')}.`);
    return pending.length === 0;
}

export function reportPath(path) {
    if (!isAbsolute(path)) throw new Error('Supply an absolute report.json path.');
    const file = realpathSync(path);
    if (!file.startsWith(`${realpathSync(outputRoot)}/`) || basename(file) !== 'report.json') {
        throw new Error('Use a report from this worktree’s artifacts/ios-test directory.');
    }
    return file;
}
