import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { alive, cleanupFixture, heartbeat, interact, launchFixture, ready, savedMarker } from './native.js';
import { requireHosted, until, verdict } from './helpers.js';

requireHosted();
const reportFile = process.env.HOSTED_REPORT_FILE;
const root = process.env.HOSTED_RUN_ROOT;
const artifacts = path.dirname(reportFile);
const report = JSON.parse(readFileSync(reportFile, 'utf8'));
const handles = [];
const start = performance.now();
function save() { writeFileSync(reportFile, JSON.stringify(report, null, 2)); }
function event(action, detail = {}) {
    report.events.push({ action, wallTime: new Date().toISOString(), elapsedMs: Math.round(performance.now() - start), ...detail });
    save();
}
async function screenshot(label) { await browser.saveScreenshot(path.join(artifacts, `${label}.png`)); }
async function click(selector) {
    const element = await $(selector);
    await element.waitForClickable({ timeout: 20_000 });
    await element.click();
}
async function fill(selector, value) {
    const element = await $(selector);
    await element.waitForDisplayed();
    await element.setValue(value);
}
async function warningRows() {
    return browser.execute(() => [...(window.__REDDBLOCK_INTERNALS__?.appBlockingWarningRows || [])]
        .map(([pid, row]) => ({ pid, name: row.name, ackedDeadlineMs: row.ackedDeadlineMs })));
}
async function assertNoTargetWarnings(target) {
    const rows = await warningRows();
    assert(!rows.some((row) => row.name === target.name || Number(row.pid) === target.pid), `Renewed/stale target warning: ${JSON.stringify(rows)}`);
    assert(!await $('#app-blocking-warning-overlay').isDisplayed(), 'Unexpected warning overlay after release');
}
async function recordInteraction(handle, label) {
    const result = await interact(handle, root, label);
    report.capabilities.push(result);
    event('external-gui-interaction', result);
}
async function setup() {
    await browser.waitUntil(() => browser.execute(() => !!window.__REDDBLOCK_INTERNALS__?.appData), { timeout: 120_000 });
    const initial = await browser.execute(() => {
        const d = window.__REDDBLOCK_INTERNALS__.appData;
        return { blocklists: d.blocklists, activeBlocks: d.activeBlocks, schedules: d.schedules };
    });
    assert.deepEqual(initial, { blocklists: [], activeBlocks: [], schedules: [] }, 'Fresh hosted profile must contain no rules');
    event('empty-policy-preflight', initial);
    // Same app acceptance route as Tier 2, restricted to initial setup. All
    // fixture policy creation and release below use visible UI + WebDriver input.
    await browser.waitUntil(async () => await $('#welcome-onboarding-continue-btn').isDisplayed()
        || await $('#rebrand-onboarding-continue-btn').isDisplayed()
        || await $('#eula-continue-btn').isDisplayed(), { timeout: 30_000, timeoutMsg: 'Fresh-profile onboarding did not appear' });
    if (await $('#welcome-onboarding-continue-btn').isDisplayed()) await click('#welcome-onboarding-continue-btn');
    if (await $('#rebrand-onboarding-continue-btn').isDisplayed()) await click('#rebrand-onboarding-continue-btn');
    await $('#eula-continue-btn').waitForDisplayed({ timeout: 30_000 });
    await browser.execute(() => {
        window.__HOSTED_EULA_RESULT__ = { status: 'pending' };
        Promise.resolve(window.__REDDBLOCK_INTERNALS__.acceptEula())
            .then(() => { window.__HOSTED_EULA_RESULT__ = { status: 'done' }; })
            .catch((error) => { window.__HOSTED_EULA_RESULT__ = { status: 'error', error: String(error) }; });
    });
    await browser.waitUntil(
        () => browser.execute(() => window.__HOSTED_EULA_RESULT__?.status !== 'pending'),
        { timeout: 120_000, timeoutMsg: 'App EULA acceptance did not settle' },
    );
    const acceptance = await browser.execute(() => window.__HOSTED_EULA_RESULT__);
    assert.equal(acceptance?.status, 'done', acceptance?.error || 'EULA acceptance did not complete');
    event('setup-eula-accepted', { method: 'existing acceptEula setup seam; no policy mutation' });
    await $('#add-blocklist-btn').waitForDisplayed({ timeout: 30_000 });
}
async function createAndStart(name) {
    await click('#add-blocklist-btn');
    await fill('#blocklist-name', `Hosted recovery ${report.runId}`);
    if (!await $('#modal-browse-apps-btn').isDisplayed()) await click('#editor-section-what-header');
    await click('#modal-browse-apps-btn');
    await fill('#app-picker-search', name);
    // The public typed-name affordance enrols run-owned, uninstalled fixtures.
    await click('.app-picker-add-typed');
    await click('#app-picker-add-btn');
    await click('#editor-section-when-header');
    await click('#when-kind-manual');
    await click('#editor-section-stop-header');
    await click('#override-type-trigger');
    await click('#override-type-menu [data-value="random-words"]');
    await click('#override-count');
    await browser.keys('Home');
    assert.equal(await $('#override-count').getValue(), '1', 'One legitimate word must be configured through the slider');
    await screenshot('configured-focus-space');
    await click('#save-blocklist-btn');
    await $('.blocklist-switch').waitForDisplayed();
    assert.equal(await $('.blocklist-switch').getAttribute('aria-checked'), 'false');
    await click('.blocklist-switch');
    await click('#proceed-start-confirm-btn');
    event('block-started-through-ui', { name, challengeWords: 1, ruleKind: 'Manual', finite: false, expected: 'warning then 30 s acknowledged pre-quit + 10 s grace' });
}
async function pauseThroughChallenge() {
    await click('.blocklist-switch');
    await $('#challenge-input').waitForDisplayed();
    await click('#unlock-duration-select-trigger');
    await click('#unlock-duration-select-menu [data-value="5"]');
    const challenge = await $('#challenge-text').getText();
    assert(challenge.trim() && challenge.trim().split(/\s+/).length === 1, 'Expected one non-empty challenge word');
    assert.equal(await $('#confirm-override-btn').isEnabled(), false, 'Challenge must initially prevent confirmation');
    await click('#challenge-input');
    // Send actual WebDriver key events, never call confirm/stop internals.
    for (const character of challenge) await browser.keys(character);
    await $('#confirm-override-btn').waitForEnabled();
    await screenshot('completed-pause-challenge');
    const requestedAt = performance.now();
    await click('#confirm-override-btn');
    await browser.waitUntil(async () => (await $('.blocklist-switch').getAttribute('aria-checked')) === 'false', { timeout: 10_000 });
    event('pause-accepted-through-ui', { challenge, pauseMinutes: 5, acceptedAfterMs: performance.now() - requestedAt });
    await screenshot('pause-accepted');
    return requestedAt;
}

describe('Hosted native app recovery feasibility', () => {
    it('enforces and legitimately pauses a real target while its control remains usable', async () => {
        try {
            await setup();
            const target = launchFixture(report.fixtures.target, root, 'initial'); handles.push(target);
            const control = launchFixture(report.fixtures.control, root, 'control'); handles.push(control);
            await Promise.all([ready(target), ready(control)]);
            event('native-fixtures-ready', { targetPid: target.pid, controlPid: control.pid, targetBinary: target.binary, controlBinary: control.binary });
            await recordInteraction(target, 'target-baseline');
            await recordInteraction(control, 'control-baseline');
            const marker = savedMarker(target);
            report.savedState = { verdict: marker ? 'PENDING' : 'BLOCKED', reason: marker ? 'GUI-saved nonce captured before enforcement' : 'No external GUI-saved nonce; persistence not established' };
            save();
            await createAndStart(target.name);
            await $('#app-blocking-lets-go-btn').waitForDisplayed({ timeout: 20_000 });
            await until(async () => (await warningRows()).some((row) => Number(row.pid) === target.pid), 10_000, 'Warning must enrol the actual target PID');
            await screenshot('target-warning-before-ack');
            await delay(2_000);
            await heartbeat(target);
            await heartbeat(control);
            event('warning-before-ack-target-alive', { targetPid: target.pid });
            const acknowledgedAt = performance.now();
            await click('#app-blocking-lets-go-btn');
            event('warning-acknowledged-through-ui', { targetPid: target.pid });
            await until(async () => {
                await heartbeat(control);
                if (!alive(target)) return true;
                return false;
            }, 45_000, 'Acknowledged target survived enforcement deadline');
            const terminatedAfterMs = performance.now() - acknowledgedAt;
            assert(terminatedAfterMs >= 29_000, `Target terminated before 30 s pre-quit: ${terminatedAfterMs}ms`);
            assert(existsSync(path.join(target.directory, 'polite-quit')), 'Target must run its normal polite-close path');
            if (marker) assert.equal(savedMarker(target), marker, 'Saved native marker lost during quit');
            event('target-terminated', { terminatedAfterMs, targetPid: target.pid, controlPid: control.pid, expectedMaximumMs: 45_000 });
            await recordInteraction(control, 'control-during-block');
            const releasedAt = await pauseThroughChallenge();
            await until(async () => (await warningRows()).every((row) => row.name !== target.name), 10_000, 'Target warning did not clear after accepted pause');
            const reopened = launchFixture(report.fixtures.target, root, 'reopened'); handles.push(reopened);
            await ready(reopened);
            if (marker) {
                assert.equal(savedMarker(reopened), marker, 'Native saved state did not survive relaunch');
                report.savedState = { verdict: 'PASS', nonce: marker, targetPid: reopened.pid };
                event('gui-saved-state-persisted', report.savedState);
            } else {
                event('gui-saved-state-not-established', report.savedState);
            }
            await heartbeat(reopened);
            assert(performance.now() - releasedAt <= 10_000, 'Target did not become usable within proposed 10 s release bound');
            event('target-reopened-after-pause', { targetPid: reopened.pid, usableAfterMs: performance.now() - releasedAt, controlPid: control.pid });
            await recordInteraction(reopened, 'target-after-pause');
            const observeUntil = performance.now() + 75_000;
            while (performance.now() < observeUntil) {
                await assertNoTargetWarnings(reopened);
                await heartbeat(reopened);
                await heartbeat(control);
                event('released-target-control-heartbeats', { targetPid: reopened.pid, controlPid: control.pid });
                await delay(1_000);
            }
            await assertNoTargetWarnings(reopened);
            await recordInteraction(reopened, 'target-after-75s');
            await recordInteraction(control, 'control-after-75s');
            await screenshot('sustained-release');
            report.behaviour = 'PASS';
            event('sustained-release-complete', { minimumObservationMs: 75_000 });
        } catch (error) {
            report.behaviour = 'FAIL';
            report.error = { message: error.message, stack: error.stack };
            try { await screenshot('failure'); } catch (captureError) { event('screenshot-failed', { message: captureError.message }); }
            throw error;
        } finally {
            report.capability = report.capabilities.length > 0 && report.capabilities.every((item) => item.verdict === 'PASS') ? 'PASS'
                : report.capabilities.some((item) => item.verdict === 'FAIL') ? 'FAIL' : 'BLOCKED';
            report.cleanup = 'PASS';
            for (const handle of handles) {
                try { await cleanupFixture(handle, root); }
                catch (error) { report.cleanup = 'FAIL'; event('cleanup-failed', { pid: handle.pid, message: error.message }); }
            }
            // Behaviour is final before cleanup. Cleanup never clears policy or
            // masquerades as release; the disposable hosted profile is discarded.
            for (const entry of Object.values(report.fixtures)) {
                const stateDir = path.join(entry.directory, 'state');
                if (existsSync(stateDir)) cpSync(stateDir, path.join(artifacts, entry.name), { recursive: true });
            }
            for (const file of readdirSync(root).filter((name) => name.endsWith('.log'))) cpSync(path.join(root, file), path.join(artifacts, file));
            report.verdict = verdict(report.behaviour, report.capability, report.cleanup);
            save();
        }
        assert.equal(report.verdict, 'PASS', `Hosted probe ${report.verdict}: see report.json capabilities and cleanup`);
    });
});
