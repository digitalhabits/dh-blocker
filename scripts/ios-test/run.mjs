#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { dirname } from 'node:path';
import { build, preflight, preferReleaseXcode } from './apple.mjs';
import { check, command, lock, newReport, outputRoot, readJson, record, writeJson } from './common.mjs';
import { deviceRun, isAutomatedProfile, reportPath } from './device.mjs';

const options = {
    mode: { type: 'string' },
    profile: { type: 'string' },
    device: { type: 'string' },
    build: { type: 'string' },
    baseline: { type: 'string' },
    report: { type: 'string' },
    case: { type: 'string' },
    status: { type: 'string' },
    note: { type: 'string' },
    evidence: { type: 'string', multiple: true, default: [] },
    capture: { type: 'boolean' },
    recover: { type: 'boolean' },
    'provision-driver': { type: 'boolean' },
    help: { type: 'boolean' },
};
const commands = {
    preflight: ['mode', 'device'],
    host: [],
    build: ['mode', 'device'],
    'device-smoke': ['device', 'build', 'baseline', 'report', 'capture', 'case', 'status', 'note', 'evidence'],
    'device-full': ['profile', 'device', 'build', 'baseline', 'report', 'capture', 'case', 'status', 'note', 'evidence', 'recover', 'provision-driver'],
};
const modes = ['device', 'simulator', 'unsigned-device', 'store'];

function host(run) {
    const checks = [
        ['tier0', 'Tier 0 logic', 'pnpm', ['test:tier0']],
        ['tier1', 'Tier 1 logic', 'pnpm', ['test:tier1']],
        ['frontend', 'Production frontend build', 'pnpm', ['vite:build']],
        ['activity-timing', 'Swift one-off activity timing', 'bash', ['scripts/ci/test-ios-activity-timing.sh']],
        ['schedule-registration', 'Swift schedule registration', 'bash', ['scripts/ci/test-ios-schedule-registration.sh']],
        ['schedule-data', 'Swift schedule data', 'bash', ['scripts/ci/test-ios-schedule-data.sh']],
        ['start-warnings', 'Swift start warnings', 'bash', ['scripts/ci/test-ios-start-warnings.sh']],
        ['ui-ios', 'Mocked iPhone/iPad Chromium fixtures and geometry', 'pnpm',
            ['ui:shoot', '--profile=ios', '--measure', `--out=${dirname(run.file)}/ui`]],
    ];
    return checks.map(([id, label, executable, args]) =>
        check(run, id, label, log => command(executable, args, { log, timeout: 10 * 60_000 })).ok).every(Boolean);
}

async function main() {
    const { positionals, values, tokens } = parseArgs({ options, allowPositionals: true, tokens: true });
    if (values.help || positionals.length === 0) {
        console.log('Usage: node scripts/ios-test/run.mjs preflight|host|build|device-smoke|device-full [options]\nSee docs/ios-testing.md.');
        return;
    }
    const [lane] = positionals;
    if (positionals.length !== 1 || !Object.hasOwn(commands, lane)) throw new Error('Unknown iOS test command. See --help.');
    for (const token of tokens.filter(token => token.kind === 'option')) {
        if (!commands[lane].includes(token.name)) throw new Error(`--${token.name} is unavailable for ${lane}.`);
    }
    const deviceLane = lane.startsWith('device-');
    const mode = values.mode || 'device';
    if (!modes.includes(mode)) throw new Error('Use --mode device|simulator|unsigned-device|store.');
    if (values.device && mode !== 'device') throw new Error('--device is only used for a physical device.');
    if (values.report && (values.build || values.baseline)) throw new Error('Use --build and --baseline only when starting a new device run.');
    if (values.build && !values.baseline && !isAutomatedProfile(values.profile)) throw new Error('An in-place update requires --baseline.');
    if (values.status && !values.case) throw new Error('--status requires --case.');
    if (values.evidence.length && !values.case) throw new Error('--evidence requires --case.');
    if (values.recover && !values.report) throw new Error('--recover requires the interrupted automated run report.');
    if (values.profile && (!isAutomatedProfile(values.profile) || values.report)) throw new Error('Use --profile website|pause when starting a new device-full run.');
    if (deviceLane && !values.device) throw new Error('Specify --device with an explicit UDID or CoreDevice identifier.');
    if (deviceLane && !values.report && values.case) {
        throw new Error('Start the device run before adding observations or planning a fixture.');
    }
    const release = lock(outputRoot);
    try {
        preferReleaseXcode();
        const run = values.report ? { file: reportPath(values.report) } : newReport(lane);
        if (values.report) run.report = readJson(run.file);
        if (run.report.lane !== lane || run.report.schema !== 1) throw new Error('The report belongs to a different test lane or schema.');
        console.log(`Report: ${run.file}`);
        writeJson(run.file, run.report);
        let ok;
        try {
            delete run.report.cases.execution;
            if (deviceLane) ok = await deviceRun(run, values, Boolean(values.report));
            else if (lane === 'host') ok = host(run);
            else {
                ok = preflight(run, mode, values.device);
                if (ok && lane === 'build') ok = build(run, mode);
            }
        } catch (error) {
            record(run, 'execution', 'BLOCKED', error.message);
            ok = false;
        }
        run.report.finishedAt = new Date().toISOString();
        if (values.recover) run.report.result ??= 'BLOCKED';
        else run.report.result = ok ? 'PASS' : Object.values(run.report.cases).some(item => item.status === 'FAIL') ? 'FAIL' : 'BLOCKED';
        writeJson(run.file, run.report);
        process.exitCode = ok ? 0 : 1;
    } finally {
        release();
    }
}

await main().catch(error => {
    console.error(error.message);
    process.exitCode = 2;
});
