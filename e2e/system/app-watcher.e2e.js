import {
    closeFixtureWindow,
    isFixtureAlive,
    killFixture,
    launchFixture,
    quitFixture,
    waitForFixtureExit,
    waitForFixtureReady,
} from './app-watcher-harness.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TARGET_NAME = 'Digital Habits Test Target';
const SYSTEM_APP_ENABLED = process.platform === 'darwin'
    && Boolean(process.env.SYSTEM_TEST_APP || process.env.E2E_SYSTEM_APP);

const suite = SYSTEM_APP_ENABLED ? describe : describe.skip;

async function callTauri(method, ...args) {
    return browser.executeAsync((name, params, done) => {
        const api = window.__REDDBLOCK_INTERNALS__?.tauriAPI;
        if (!api || typeof api[name] !== 'function') {
            done({ error: `tauriAPI.${name} is unavailable` });
            return;
        }
        Promise.resolve(api[name](...params))
            .then((value) => done({ value }))
            .catch((error) => done({ error: String(error?.message || error) }));
    }, method, args).then((result) => {
        if (result?.error) throw new Error(result.error);
        return result?.value;
    });
}

async function warningRows() {
    return browser.execute(() => {
        const rows = window.__REDDBLOCK_INTERNALS__?.appBlockingWarningRows;
        if (!(rows instanceof Map)) return [];
        return [...rows.entries()].map(([pid, row]) => ({
            pid,
            name: row?.name,
            ackedDeadlineMs: row?.ackedDeadlineMs ?? null,
        }));
    });
}

async function waitForWarning({ timeout = 12_000, acknowledged = false } = {}) {
    await browser.waitUntil(
        async () => (await warningRows()).some((row) => acknowledged
            ? Number.isFinite(row.ackedDeadlineMs)
            : row.name === TARGET_NAME),
        { timeout, interval: 250, timeoutMsg: 'app-blocking warning row did not appear' },
    );
}

async function waitForWarningGone(timeout = 8_000) {
    await browser.waitUntil(
        async () => (await warningRows()).every((row) => row.name !== TARGET_NAME),
        { timeout, interval: 250, timeoutMsg: 'app-blocking warning row did not clear' },
    );
}

async function setBlockedApps(apps, newlyAdded = apps) {
    await callTauri('setBlockedApps', apps, newlyAdded);
}

async function clearBlockedApps() {
    await setBlockedApps([], []);
    await waitForWarningGone().catch(() => {});
}

async function acknowledgeWarning() {
    await callTauri('letsGoAcknowledge');
    await waitForWarning({ acknowledged: true });
}

suite('macOS app watcher — real fixture', function () {
    // The slowest path is 30 s pre-quit + 10 s force-close grace, plus the
    // two-second idle/one-second active sweep and process scheduling headroom.
    this.timeout(75_000);

    let fixture;

    afterEach(async function () {
        const failed = this.currentTest?.state === 'failed';
        if (failed) {
            const artifactDir = process.env.SYSTEM_TEST_ARTIFACTS_DIR
                || path.join(os.tmpdir(), 'redd-block-system-test');
            mkdirSync(artifactDir, { recursive: true });
            await browser.saveScreenshot(path.join(
                artifactDir,
                `app-watcher-${Date.now()}.png`,
            )).catch((error) => console.error(`[app-watcher] screenshot failed: ${error.message}`));
            writeFileSync(path.join(artifactDir, 'app-watcher-warning-rows.json'), JSON.stringify(
                await warningRows().catch(() => []),
                null,
                2,
            ));
        }
        try {
            await clearBlockedApps();
        } finally {
            await killFixture(fixture).catch((error) => {
                console.error(`[app-watcher] exact-PID cleanup failed: ${error.message}`);
            });
            fixture = undefined;
        }
    });

    it('raises warning before acknowledgement and keeps a normal app alive', async () => {
        fixture = launchFixture({ mode: 'normal' });
        await waitForFixtureReady(fixture);
        await setBlockedApps([TARGET_NAME], [TARGET_NAME]);
        await waitForWarning();

        await new Promise((resolve) => setTimeout(resolve, 2_000));
        if (!isFixtureAlive(fixture)) {
            throw new Error('normal fixture quit before the user acknowledged the warning');
        }
    });

    it('gives a normal app the full 30-second pre-quit window after Let\'s go', async () => {
        fixture = launchFixture({ mode: 'normal' });
        await waitForFixtureReady(fixture);
        await setBlockedApps([TARGET_NAME], [TARGET_NAME]);
        await waitForWarning();
        await acknowledgeWarning();

        await new Promise((resolve) => setTimeout(resolve, 5_000));
        if (!isFixtureAlive(fixture)) {
            throw new Error('normal fixture quit before the 30-second pre-quit window elapsed');
        }
        if (!await waitForFixtureExit(fixture, 45_000)) {
            throw new Error(`normal fixture survived polite quit (pid=${fixture.pid}); see ${fixture.logPath}`);
        }
    });

    it('force-closes a stubborn app after polite quit plus the 10-second grace', async () => {
        fixture = launchFixture({ mode: 'stubborn' });
        await waitForFixtureReady(fixture);
        await setBlockedApps([TARGET_NAME], [TARGET_NAME]);
        await waitForWarning();
        await acknowledgeWarning();

        await new Promise((resolve) => setTimeout(resolve, 35_000));
        if (!isFixtureAlive(fixture)) {
            throw new Error('stubborn fixture exited during the pre-quit window');
        }
        if (!await waitForFixtureExit(fixture, 28_000)) {
            throw new Error(`stubborn fixture was not force-closed (pid=${fixture.pid}); see ${fixture.logPath}`);
        }
    });

    it('silently closes an app launched in the middle of an active block', async () => {
        // No newlyAdded entry models a policy that was already active before
        // the target launched. That path intentionally skips the warning.
        await setBlockedApps([TARGET_NAME], []);
        fixture = launchFixture({ mode: 'normal' });
        await waitForFixtureReady(fixture);
        await browser.waitUntil(
            async () => !isFixtureAlive(fixture),
            { timeout: 12_000, interval: 250, timeoutMsg: 'mid-block fixture remained alive' },
        );
        const rows = await warningRows();
        if (rows.some((row) => row.name === TARGET_NAME)) {
            throw new Error('mid-block launch unexpectedly raised a user warning');
        }
    });

    it('syncs effective pause, resume, and expiry policy without losing the target process', async () => {
        fixture = launchFixture({ mode: 'normal' });
        await waitForFixtureReady(fixture);
        await setBlockedApps([TARGET_NAME], [TARGET_NAME]);
        await waitForWarning();

        // A paused/expired effective policy removes the target from the
        // watcher. Keep the process alive so resume can exercise a new block.
        await clearBlockedApps();
        if (!isFixtureAlive(fixture)) throw new Error('target quit while policy was paused');
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await setBlockedApps([TARGET_NAME], [TARGET_NAME]);
        await waitForWarning();
        if (!isFixtureAlive(fixture)) throw new Error('target was not alive for resume policy');

        // Natural expiry has the same native contract: the next effective
        // policy sync removes the app and hides any outstanding warning.
        await clearBlockedApps();
        if (!isFixtureAlive(fixture)) throw new Error('target quit when resumed policy expired');
    });

    it('keeps enforcement state across Cmd-W and handles Cmd-Q through AppKit', async () => {
        fixture = launchFixture({ mode: 'normal' });
        await waitForFixtureReady(fixture);
        await setBlockedApps([TARGET_NAME], [TARGET_NAME]);
        await waitForWarning();

        closeFixtureWindow();
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        if (!isFixtureAlive(fixture)) throw new Error('Cmd-W terminated the target process');
        await waitForWarning();

        // Cmd-Q is the target app's normal user exit path. The blocker must
        // observe the PID disappearing and clear its warning state rather than
        // retaining stale enforcement state.
        quitFixture(fixture);
        await browser.waitUntil(
            async () => !isFixtureAlive(fixture),
            { timeout: 8_000, interval: 250, timeoutMsg: 'Cmd-Q did not terminate normal fixture' },
        );
        await waitForWarningGone();
    });
});
