import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { command, outputRoot, record, team, writeJson } from './common.mjs';
import { NavigationError, runWithNavigation } from './navigation.mjs';

const destination = run => `platform=iOS,id=${run.report.device.udid}`;
const project = 'scripts/ios-test/driver/Driver.xcodeproj';
const driverBuild = join(outputRoot, 'driver-device');

function buildDriver(run, log, provision) {
    command('xcodebuild', ['-project', project, '-scheme', 'Driver', '-destination', destination(run),
        '-derivedDataPath', driverBuild, `DEVELOPMENT_TEAM=${team}`,
        ...(provision ? ['-allowProvisioningUpdates'] : []), 'build-for-testing'], { log, timeout: 4 * 60_000 });
    const products = join(driverBuild, 'Build', 'Products');
    const name = readdirSync(products).find(file => /^Driver_iphoneos.*\.xctestrun$/.test(file));
    if (!name) throw new Error('Xcode did not produce the physical driver’s xctestrun file.');
    return join(products, name);
}

export function driverConfiguration(config, fixture, token, restoreDuration) {
    const target = config.Driver;
    if (!target?.IsUITestBundle || target.TestHostBundleIdentifier !== 'com.reddblock.testing.driver.xctrunner') {
        throw new Error('Unexpected Xcode test runner configuration.');
    }
    return { ...config, Driver: { ...target, EnvironmentVariables: {
        ...target.EnvironmentVariables, REDD_IOS_TEST_FIXTURE: fixture.name,
        REDD_IOS_TEST_END: fixture.deadline, REDD_IOS_NAV_TOKEN: token,
        ...(restoreDuration && { REDD_IOS_BREAK_TO_RESTORE: restoreDuration }),
    } } };
}

function resultsSummary(bundle) {
    return JSON.parse(command('xcrun', ['xcresulttool', 'get', 'test-results', 'summary', '--path', bundle]));
}

export function passedOneTest(result) {
    return result.totalTestCount === 1 && result.passedTests === 1 && result.failedTests === 0
        && result.skippedTests === 0;
}

export function failureVerdict(summary) {
    const issues = summary?.testFailures || [];
    if (issues.some(issue => /timed out while enabling automation mode/i.test(issue.failureText))) {
        return { status: 'BLOCKED', reason: 'iOS did not authorise UI Automation. Unlock the device and approve the XCTest system prompt, then rerun.' };
    }
    const assertions = issues.filter(issue => !/test(ing)? was cancel|test runner failed/i.test(issue.failureText)
        && (issue.testIdentifierString?.includes('testFreshWebsiteLifecycle')
            || issue.testIdentifierString?.includes('testScheduledPauseLifecycle')
            || issue.testIdentifierString?.includes('testRecoverOwnedFixture')));
    return { status: assertions.length ? 'FAIL' : 'BLOCKED', reason: (assertions[0] || issues[0])?.failureText };
}

export function pausePreference(output) {
    const baseline = output.match(/^REDD_IOS_BREAK_BASELINE (5 minutes|10 minutes|30 minutes|1 hour|2 hours|4 hours|8 hours|24 hours)\r?$/m)?.[1];
    return {
        baseline,
        possiblyChanged: Boolean(baseline && baseline !== '5 minutes' && /^REDD_IOS_BREAK_CHANGE_REQUESTED\r?$/m.test(output)),
        restored: Boolean(baseline && output.split(/\r?\n/).includes('REDD_IOS_BREAK_RESTORED ' + baseline)),
    };
}

export async function runDeviceDriver(run, { provision, recover }) {
    const pause = run.report.profile === 'pause';
    const id = recover ? 'fixture-recovery' : pause ? 'scheduled-pause' : 'fresh-website';
    const dir = dirname(run.file);
    const startedAt = new Date().toISOString();
    const fixture = run.report.fixture;
    const token = randomBytes(16).toString('hex');
    const attempt = `${id}-${Date.now()}`;
    const log = join(dir, `${attempt}.log`);
    const result = join(dir, `${attempt}.xcresult`);
    const evidence = () => [log, result].filter(existsSync).map(file => basename(file));
    let built = false;
    if (pause && recover && !fixture.preference) {
        // An abrupt exit can leave XCTest's durable log but skip finally.
        const original = readdirSync(dir).find(file => /^scheduled-pause-\d+\.log$/.test(file));
        if (original) fixture.preference = pausePreference(readFileSync(join(dir, original), 'utf8'));
    }
    const restoreDuration = pause && recover && fixture.preference?.possiblyChanged && !fixture.preference.restored
        ? fixture.preference.baseline : undefined;
    try {
        const template = buildDriver(run, log, provision);
        built = true;
        if (!recover) {
            fixture.deadline = new Date(Math.ceil(Date.now() / 60_000) * 60_000 + (pause ? 16 : 4) * 60_000).toISOString().replace('.000Z', 'Z');
            writeJson(run.file, run.report);
        }
        const config = JSON.parse(command('plutil', ['-convert', 'json', '-o', '-', template]));
        const configured = join(dirname(template), `${run.report.id}-${attempt}.xctestrun`);
        writeFileSync(configured, JSON.stringify(driverConfiguration(config, fixture, token, restoreDuration)), { mode: 0o600 });
        command('plutil', ['-convert', 'xml1', configured]);
        console.log(`Running the connected-device XCTest. Log: ${log}`);
        const test = recover ? 'testRecoverOwnedFixture' : pause ? 'testScheduledPauseLifecycle' : 'testFreshWebsiteLifecycle';
        await runWithNavigation(['test-without-building', '-xctestrun', configured, '-destination', destination(run),
            '-parallel-testing-enabled', 'NO', '-resultBundlePath', result, `-only-testing:Driver/Driver/${test}`,
            '-test-timeouts-enabled', 'YES', '-default-test-execution-time-allowance', pause ? '840' : '480'],
        { log, udid: run.report.device.udid, token, maxRequests: recover ? 1 : pause ? 31 : 14, timeout: (pause ? 15 : 10) * 60_000 });
        const summary = resultsSummary(result);
        if (!passedOneTest(summary)) throw new Error('The XCTest result does not contain exactly one passed, unskipped test.');
        fixture.cleanup = { at: new Date().toISOString(), method: 'XCTest', evidence: evidence() };
        record(run, id, 'PASS', recover ? 'The owned fixture is absent.'
            : pause ? 'Saved five-minute scheduled pause, Safari background reblocking, Resume now, Never, remembered duration and exact cleanup verified.'
                : 'Owned schedule persistence, Safari restriction, control navigation, automatic expiry and owned fixture deletion verified.', evidence(), startedAt);
        return true;
    } catch (error) {
        let verdict = { status: 'BLOCKED' };
        if (!(error instanceof NavigationError) && built && existsSync(result)) {
            try {
                verdict = failureVerdict(resultsSummary(result));
            } catch {
                // Keep tool/setup failures separate from executed assertions.
            }
        }
        record(run, id, verdict.status, verdict.reason || error.message, evidence(), startedAt);
        return false;
    } finally {
        const output = existsSync(log) ? readFileSync(log, 'utf8') : '';
        if (restoreDuration) {
            fixture.preference.restored ||= output.split(/\r?\n/).includes('REDD_IOS_BREAK_RESTORED ' + restoreDuration);
            if (/^REDD_IOS_BREAK_EXTERNAL_CHOICE\r?$/m.test(output)) fixture.preference.externalChoice = true;
        }
        if (!recover && output) {
            if (pause) fixture.preference = pausePreference(output);
            fixture.creation = output.includes(`REDD_IOS_FIXTURE_SAVED ${fixture.name}`) ? 'confirmed'
                : output.includes(`REDD_IOS_FIXTURE_SAVE_REQUESTED ${fixture.name}`) ? 'requested' : 'unobserved';
        }
        writeJson(run.file, run.report);
    }
}
