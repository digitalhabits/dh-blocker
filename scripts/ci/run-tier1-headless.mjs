#!/usr/bin/env node
/**
 * Headless Tier 1 test runner (CI).
 *
 * The Tier 1 blocking-logic suite (src/blocking-tests.js + src/test-utils.js)
 * only exists in the app's dev build — it is injected via <script> tags in
 * src/index.html and stripped from production bundles (see vite.config.js).
 * There is no CLI runner, so CI drives it the same way a developer would:
 * boot the Vite dev server, open the page in headless Chromium, call
 * runBlockingTests(), and read back window.ReddBlockTestUtils.testResults.
 *
 * Exit 0 only if the suite completes with zero failures AND did not abort
 * early (the runner has no per-test try/catch, so an uncaught throw in one
 * group silently skips the rest — we detect that via the "Test suite crashed"
 * console line).
 *
 * No Tauri runtime is present here, so anything that calls `invoke` will
 * reject — but Tier 1 is pure logic and never touches the backend, so those
 * rejections don't affect it. (Tier 2 integration tests are intentionally not
 * run headlessly; they require the native command layer.)
 */
import { chromium } from 'playwright';

import { startDevServer } from './lib/dev-server.mjs';

const PORT = process.env.TIER1_PORT || '5199';
const URL = `http://localhost:${PORT}/`;
const BOOT_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 120_000;

function log(...a) { console.log('[tier1]', ...a); }

async function main() {
    let stopServer = () => {};
    let browser;
    const cleanup = async () => {
        try { if (browser) await browser.close(); } catch { /* ignore */ }
        stopServer('SIGTERM');
    };
    process.on('exit', () => stopServer('SIGKILL'));

    try {
        ({ stop: stopServer } = await startDevServer({
            port: PORT,
            bootTimeoutMs: BOOT_TIMEOUT_MS,
            log,
        }));
        log('launching headless Chromium');
        browser = await chromium.launch();
        const page = await browser.newPage();

        let crashed = false;
        page.on('console', (msg) => {
            const text = msg.text();
            if (text.includes('Test suite crashed')) crashed = true;
            // surface the suite's own output in CI logs
            if (/TEST RESULTS|❌|crashed/i.test(text)) log('page>', text);
        });
        page.on('pageerror', (err) => log('pageerror>', err.message));

        await page.goto(URL, { waitUntil: 'domcontentloaded' });

        // Wait until the dev test harness has attached.
        await page.waitForFunction(
            () => typeof window.ReddBlockTests?.runAllTests === 'function'
                && !!window.ReddBlockTestUtils?.testResults,
            null,
            { timeout: BOOT_TIMEOUT_MS },
        );

        log('running runBlockingTests()');
        page.setDefaultTimeout(TEST_TIMEOUT_MS);
        const results = await page.evaluate(async () => {
            await window.ReddBlockTests.runAllTests();
            const r = window.ReddBlockTestUtils.testResults;
            return { passed: r.passed, failed: r.failed, errors: r.errors };
        });

        log(`results: ${results.passed} passed, ${results.failed} failed`);
        if (results.errors?.length) results.errors.forEach((e) => log('  •', e));

        if (crashed) {
            throw new Error('Tier 1 suite aborted early (a group threw an uncaught error — see "Test suite crashed" above)');
        }
        if (results.failed > 0) {
            throw new Error(`Tier 1: ${results.failed} test(s) failed`);
        }
        if (results.passed === 0) {
            throw new Error('Tier 1: no tests ran (harness did not load)');
        }
        log(`OK — ${results.passed} tests passed`);
        await cleanup();
        process.exit(0);
    } catch (err) {
        log('FAILED:', err.message);
        await cleanup();
        process.exit(1);
    }
}

main();
