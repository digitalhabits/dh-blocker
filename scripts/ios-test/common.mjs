import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../..', import.meta.url));
export const outputRoot = join(root, 'artifacts', 'ios-test');
export const team = 'JD647S9RT6'; // Same team as scripts/xcodebuild and release.yml.
export const appId = 'com.reddblock';
export const bundleIds = [appId, `${appId}.monitor`, `${appId}.shieldconfiguration`];

export function command(program, args, { log, env = process.env, timeout = 60_000, cwd = root, stderr = false } = {}) {
    const fd = log ? openSync(log, 'a', 0o600) : undefined;
    let result;
    try {
        if (log) writeFileSync(fd, `\n$ ${[program, ...args].join(' ')}\n`);
        result = spawnSync(program, args, {
            cwd, env, timeout, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
            stdio: log ? ['ignore', fd, fd] : ['ignore', 'pipe', 'pipe'],
        });
    } finally {
        if (log) closeSync(fd);
    }
    if (result.error || result.status !== 0) {
        throw new Error(`${program} ${args[0] || ''}: ${result.error?.message || result.signal || `exit ${result.status}`}`
            + (log ? ` (see ${log})` : ` ${result.stderr?.trim() || result.stdout?.trim() || ''}`));
    }
    return (stderr ? result.stderr : result.stdout)?.trim();
}

export function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

export function revision() {
    const sha = command('git', ['rev-parse', 'HEAD']);
    const diff = command('git', ['diff', '--binary', '--no-ext-diff', 'HEAD', '--']);
    const untracked = command('git', ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean);
    const extra = untracked.sort().map(path => [path, sha256(readFileSync(join(root, path)))]);
    return { sha, dirty: Boolean(diff || extra.length), changesHash: sha256(JSON.stringify([diff, extra])) };
}

export function writeJson(file, data) {
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
}

export function readJson(file) {
    return JSON.parse(readFileSync(file, 'utf8'));
}

export function newReport(lane) {
    const startedAt = new Date().toISOString();
    const id = `${startedAt.replace(/[:.]/g, '-')}-${lane}-${randomUUID().slice(0, 8)}`;
    const dir = join(outputRoot, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    return { file: join(dir, 'report.json'), report: { schema: 1, id, lane, revision: revision(), startedAt, cases: {} } };
}

export function record(run, id, status, reason, evidence = [], startedAt) {
    const observedAt = new Date().toISOString();
    run.report.cases[id] = {
        status, reason, evidence, observedAt,
        ...(startedAt && { startedAt, durationMs: Date.parse(observedAt) - Date.parse(startedAt) }),
    };
    writeJson(run.file, run.report);
    console.log(`${status.padEnd(14)} ${id}  ${reason}`);
}

export function check(run, id, description, action, failure = 'FAIL') {
    const startedAt = new Date().toISOString();
    const log = join(dirname(run.file), `${id}.log`);
    try {
        const result = action(log);
        record(run, id, 'PASS', description, existsSync(log) ? [basename(log)] : [], startedAt);
        return { ok: true, result };
    } catch (error) {
        record(run, id, failure, error.message, existsSync(log) ? [basename(log)] : [], startedAt);
        return { ok: false };
    }
}

export function lock(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, '.lock');
    let fd;
    try {
        fd = openSync(path, 'wx', 0o600);
        writeFileSync(fd, `${process.pid}\n`);
    } catch (err) {
        if (err.code === 'EEXIST') throw new Error(`Another iOS command holds ${path}. Check its PID before removing a stale lock.`, { cause: err });
        throw err;
    }
    closeSync(fd);
    return () => unlinkSync(path);
}
