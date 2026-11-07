import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixtures, emptyProfile } from './native.js';
import { BlockedError, requireHosted, verdict } from './helpers.js';

const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const artifacts = path.resolve(process.env.HOSTED_ARTIFACTS_DIR || path.join(repo, 'artifacts', 'hosted-feasibility'));
mkdirSync(artifacts, { recursive: true });
const id = randomUUID();
const root = path.join(artifacts, `run-${id}`);
const report = {
    schema: 1, runId: id, sourceSHA: process.env.GITHUB_SHA || null,
    startedAt: new Date().toISOString(), platform: process.platform, osRelease: os.release(), arch: os.arch(),
    runner: { environment: process.env.RUNNER_ENVIRONMENT, imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion, runnerOS: process.env.RUNNER_OS },
    build: { profile: 'debug', feature: 'e2e-webdriver', signedRelease: false },
    limitations: ['Blocker UI uses embedded WebDriver in a debug build; not a signed release external UI/TCC qualification.', 'No physical device or iOS coverage.', 'One fresh attempt is feasibility, not three-run safety qualification.', 'Scenario-specific coverage is recorded in events. The stale scenario replays a frontend warning callback; native stale PID, schedule and persistence callbacks are not injected.'],
    behaviour: 'NOT_RUN', capability: 'NOT_RUN', cleanup: 'NOT_RUN', verdict: 'BLOCKED', events: [], capabilities: [],
};
const reportFile = path.join(artifacts, 'report.json');
function persist() { writeFileSync(reportFile, JSON.stringify(report, null, 2)); }
persist();
try {
    requireHosted();
    report.profile = emptyProfile();
    mkdirSync(root, { recursive: true });
    report.runRoot = root;
    const fixtures = buildFixtures(root, id.slice(0, 8));
    const target = process.env.CARGO_TARGET_DIR;
    if (!target || !path.resolve(target).startsWith(repo + path.sep)) throw new BlockedError('CARGO_TARGET_DIR must be inside this worktree');
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const binary = ['redd-block', 'Digital Habits Blocker'].map((name) => path.join(target, 'debug', name + suffix)).find(existsSync);
    if (!binary) throw new BlockedError('Missing debug e2e app binary');
    report.build.binary = binary;
    report.build.sha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
    report.fixtures = fixtures;
    persist();
    const wdio = path.join(repo, 'node_modules', '@wdio', 'cli', 'bin', 'wdio.js');
    const phases = ['expiry', 'restart'].includes(process.env.HOSTED_SCENARIO)
        ? ['before-restart', 'after-restart'] : ['single'];
    for (const phase of phases) {
        const child = spawn(process.execPath, [wdio, 'run', 'e2e/hosted-feasibility/wdio.conf.js'], {
            cwd: repo, stdio: 'inherit', env: { ...process.env, E2E_APP_BINARY: binary, HOSTED_REPORT_FILE: reportFile, HOSTED_RUN_ROOT: root, HOSTED_PHASE: phase },
        });
        const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
        Object.assign(report, JSON.parse(readFileSync(reportFile, 'utf8')));
        report.events.push({ action: 'webdriver-process-phase-ended', phase, status, wallTime: new Date().toISOString() });
        if (status !== 0 && report.behaviour === 'NOT_RUN') report.infrastructureError = 'WDIO exited before scenario: ' + status;
        report.verdict = verdict(report.behaviour, report.capability, report.cleanup);
        if (status !== 0 && report.verdict === 'PASS') report.verdict = 'FAIL';
        persist();
        if (phases.length > 1) {
            const evidence = path.join(artifacts, 'phases', phase);
            mkdirSync(evidence, { recursive: true });
            copyFileSync(reportFile, path.join(evidence, 'report.json'));
            for (const name of ['wdio-logs', ...Object.values(fixtures).map((f) => f.name)]) {
                if (existsSync(path.join(artifacts, name))) cpSync(path.join(artifacts, name), path.join(evidence, name), { recursive: true });
            }
        }
        if (status !== 0 || report.verdict !== 'PASS') break;
        if (phase === 'before-restart') {
            report.behaviour = 'NOT_RUN';
            report.verdict = 'BLOCKED';
            persist();
        }
    }

} catch (error) {
    report.error = { name: error.name, message: error.message, stack: error.stack };
    report.verdict = error instanceof BlockedError ? 'BLOCKED' : 'FAIL';
} finally {
    report.finishedAt = new Date().toISOString();
    persist();
    for (const file of ['native-commands.jsonl', 'external-gui.jsonl']) {
        if (existsSync(path.join(root, file))) copyFileSync(path.join(root, file), path.join(artifacts, file));
    }
}
console.log(`[hosted-feasibility] ${report.verdict}: ${reportFile}`);
process.exitCode = report.verdict === 'PASS' ? 0 : 1;
