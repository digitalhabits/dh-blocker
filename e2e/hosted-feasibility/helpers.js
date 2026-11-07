import assert from 'node:assert/strict';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export class BlockedError extends Error {}
export function requireHosted(env = process.env, platform = process.platform) {
    if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted'
        || !['darwin', 'win32'].includes(platform)) {
        throw new BlockedError('Native probe requires GITHUB_ACTIONS=true, RUNNER_ENVIRONMENT=github-hosted and macOS/Windows');
    }
}
export function assertOwned(handle, root) {
    assert(handle?.child && Number.isInteger(handle.pid) && handle.pid > 0
        && handle.child.pid === handle.pid, 'Not an owned child process');
    const relative = path.relative(realpathSync(root), realpathSync(handle.binary));
    assert(relative && !relative.startsWith(`..${path.sep}`) && relative !== '..'
        && !path.isAbsolute(relative), 'Fixture executable is outside run root');
}
export function verdict(behaviour, capability, cleanup) {
    if (behaviour === 'FAIL' || capability === 'FAIL' || cleanup === 'FAIL') return 'FAIL';
    if (behaviour !== 'PASS' || capability !== 'PASS' || cleanup !== 'PASS') return 'BLOCKED';
    return 'PASS';
}
export async function until(check, timeoutMs, message, { now = () => performance.now(), sleep = delay, intervalMs = 250 } = {}) {
    const end = now() + timeoutMs;
    while (true) {
        if (await check()) return;
        const remaining = end - now();
        if (remaining <= 0) throw new Error(message);
        await sleep(Math.min(intervalMs, remaining));
    }
}
