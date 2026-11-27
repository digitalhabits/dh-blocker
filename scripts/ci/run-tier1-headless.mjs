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
 * Exit 0 only if the suite completes with zero failures, no uncaught browser
 * errors and no early abort (reported by the "Test suite crashed" console
 * line).
 *
 * A fake Tauri transport lets the app boot without native side effects.
 * Tier 2 integration tests require the real native command layer.
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
        const pageErrors = [];
        const unexpectedCommands = [];
        page.on('console', (msg) => {
            const text = msg.text();
            if (text.includes('Test suite crashed')) crashed = true;
            if (text.startsWith('Unexpected Tier 1 native command:')) {
                unexpectedCommands.push(text);
                log('page>', text);
            }
            // surface the suite's own output in CI logs
            if (/TEST RESULTS|❌|crashed/i.test(text)) log('page>', text);
        });
        page.on('pageerror', (err) => {
            pageErrors.push(err);
            log('pageerror>', err.stack || err.message);
        });

        await page.addInitScript(() => {
            const responses = {
                load_data: {
                    blocklists: [],
                    activeBlocks: [],
                    schedules: [],
                    settings: {
                        overrideCountUnit: 'words',
                        lastBreakMinutes: 10,
                        digitalHabitsRebrandNoticeShown: true,
                        welcomeOnboardingShown: true,
                    },
                },
                get_enforcement_enabled: false,
                get_extension_grace_seconds: 0,
                is_firefox_installed: false,
                list_installed_apps: [],
                list_pending_blocking_warnings: [],
                reconcile_blocking_warning_shell: null,
                sync_safari_fda_access: null,
                'plugin:event|listen': 1,
                'plugin:webview|set_webview_zoom': null,
                'plugin:window|is_maximized': false,
                // iOS resume ordering tests exercise the warning and error paths.
                'plugin:screentime|set_start_warnings': null,
                'plugin:dialog|message': null,
            };
            window.__TAURI_INTERNALS__ = {
                invoke: async (cmd) => {
                    if (Object.hasOwn(responses, cmd)) return responses[cmd];
                    console.error('Unexpected Tier 1 native command:', cmd);
                    throw new Error(`Unexpected Tier 1 native command: ${cmd}`);
                },
                transformCallback: () => 1,
                metadata: {
                    currentWindow: { label: 'main' },
                    currentWebview: { label: 'main' },
                },
            };
        });

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
            // Let the browser report unhandled rejections from the suite.
            await new Promise((resolve) => setTimeout(resolve, 0));
            const r = window.ReddBlockTestUtils.testResults;
            return { passed: r.passed, failed: r.failed, errors: r.errors };
        });

        log(`results: ${results.passed} passed, ${results.failed} failed`);
        if (results.errors?.length) results.errors.forEach((e) => log('  •', e));

        if (crashed) {
            throw new Error('Tier 1 suite aborted early (a group threw an uncaught error — see "Test suite crashed" above)');
        }
        if (pageErrors.length) {
            throw new Error(`Tier 1: ${pageErrors.length} uncaught browser error(s)`);
        }
        if (unexpectedCommands.length) {
            throw new Error(`Tier 1: ${unexpectedCommands.length} unexpected native call(s)`);
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
