import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
async function click(selector, beforeClick = () => {}) {
    const started = performance.now();
    const element = await $(selector);
    await element.waitForClickable({ timeout: 20_000 });
    beforeClick();
    await element.click();
    event('ui-click', { selector, transportMs: performance.now() - started });
}
async function fill(selector, value) {
    const element = await $(selector);
    await element.waitForDisplayed();
    await element.setValue(value);
}
// Pointer actions avoid the embedded driver's element-click scroll after a
// dropdown opens. Only geometry is read here; choices use the visible menu.
async function pointerClick(selector) {
    await browser.waitUntil(() => browser.execute((sel) => {
        const element = document.querySelector(sel);
        if (!element) return false;
        const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return r.width > 0 && r.height > 0 && (hit === element || element.contains(hit));
    }, selector), { timeout: 20_000, timeoutMsg: 'Visible pointer target unavailable: ' + selector });
    const point = await browser.execute((sel) => {
        const r = document.querySelector(sel).getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }, selector);
    await browser.action('pointer').move(point).down().up().perform();
}
async function selectVisibleOption(id, value) {
    await $('#' + id + '-trigger').scrollIntoView({ block: 'nearest', inline: 'nearest' });
    await browser.pause(200); // Let the pre-open scroll event settle.
    await pointerClick('#' + id + '-trigger');
    await pointerClick('#' + id + '-menu [data-value="' + value + '"]');
    assert.equal(await $('#' + id).getValue(), value, 'Visible menu choice was not applied');
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
    await browser.waitUntil(async () => await $('#add-blocklist-btn').isDisplayed()
        || await $('#migration-skip-btn').isDisplayed(),
    { timeout: 30_000, timeoutMsg: 'Neither main UI nor browser setup appeared after acceptance' });
    // This probe creates app-only rules. Use the normal Skip control for the
    // browser setup checklist; do not hide overlays or mutate onboarding state.
    if (await $('#migration-skip-btn').isDisplayed()) {
        await click('#migration-skip-btn');
        event('browser-setup-skipped-through-ui', { scope: 'app-only probe' });
    }
    await $('#add-blocklist-btn').waitForDisplayed({ timeout: 30_000 });
}
async function createAndStart(name, startNow = true) {
    const before = await browser.execute(() => window.__REDDBLOCK_INTERNALS__.appData.blocklists.map((b) => b.id));
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
    // Exercise the ordinary factory challenge. The embedded driver's synthetic
    // Home key does not implement the browser's native range-input default.
    assert.equal(await $('#override-type').getValue(), 'random-words');
    assert.equal(await $('#override-count').getValue(), '15', 'Expected the ordinary 15-word challenge');
    await screenshot('configured-focus-space');
    await click('#save-blocklist-btn');
    const id = await browser.execute((old) => window.__REDDBLOCK_INTERNALS__.appData.blocklists.find((b) => !old.includes(b.id))?.id, before);
    assert(id, 'New rule identity missing');
    const selector = `.blocklist-switch[data-id="${id}"]`;
    await $(selector).waitForDisplayed();
    assert.equal(await $(selector).getAttribute('aria-checked'), 'false');
    if (!startNow) return selector;
    await click(selector);
    await click('#proceed-start-confirm-btn');
    event('block-started-through-ui', { name, challengeWords: 15, ruleKind: 'Manual', finite: false, expected: 'warning then 30 s acknowledged pre-quit + 10 s grace' });
    return selector;
}
async function pauseThroughChallenge() {
    await click('.blocklist-switch');
    await $('#challenge-input').waitForDisplayed();
    await selectVisibleOption('unlock-duration-select', '5');
    const challenge = await $('#challenge-text').getText();
    assert.equal(challenge.trim().split(/\s+/).length, 15, 'Expected the configured 15-word challenge');
    assert.equal(await $('#challenge-input').getValue(), '', 'Challenge must begin empty');
    // Desktop character-mode deliberately allows a click, then rejects a
    // mismatch. Prove the behaviour rather than assuming a disabled button.
    await click('#confirm-override-btn');
    assert(await $('#override-modal').isDisplayed(), 'Empty challenge dismissed the pause dialog');
    assert.equal(await $('.blocklist-switch').getAttribute('aria-checked'), 'true', 'Empty challenge paused the space');
    assert.equal(await $('#challenge-input').getValue(), '', 'Empty confirmation unexpectedly filled the challenge');
    event('empty-challenge-rejected-through-ui');
    await click('#challenge-input');
    // Send actual WebDriver key events, never call confirm/stop internals.
    await browser.keys(challenge);
    assert.equal(await $('#challenge-input').getValue(), challenge, 'WebDriver typing did not reproduce the displayed challenge');
    await $('#confirm-override-btn').waitForEnabled();
    await screenshot('completed-pause-challenge');
    let requestedAt;
    await click('#confirm-override-btn', () => { requestedAt = performance.now(); });
    await browser.waitUntil(() => browser.execute(() => document.querySelector('.blocklist-switch')?.getAttribute('aria-checked') === 'false'), { timeout: 10_000 });
    event('pause-accepted-through-ui', { challenge, pauseMinutes: 5, acceptedAfterMs: performance.now() - requestedAt });
    return requestedAt;
}

async function preparePermanentStop(selector) {
    await click(selector);
    await $('#challenge-input').waitForDisplayed();
    await selectVisibleOption('unlock-duration-select', '0');
    const text = await $('#challenge-text').getText();
    assert.equal(text.trim().split(/\s+/).length, 15);
    await click('#challenge-input');
    await browser.keys(text);
    assert.equal(await $('#challenge-input').getValue(), text);
    await $('#confirm-override-btn').waitForEnabled();
    event('permanent-stop-challenge-prepared', { selector, words: 15 });
}
async function permanentStop(selector) {
    await preparePermanentStop(selector);
    await click('#confirm-override-btn');
    await browser.waitUntil(async () => await $(selector).getAttribute('aria-checked') === 'false', { timeout: 10_000 });
    event('permanent-stop-confirmed', { selector });
}
async function waitForWarning(handle) {
    await $('#app-blocking-lets-go-btn').waitForDisplayed({ timeout: 20_000 });
    const rows = await warningRows();
    assert(rows.some((r) => Number(r.pid) === handle.pid && !r.ackedDeadlineMs), 'Exact fixture must await acknowledgement');
    await heartbeat(handle);
    event('exact-fixture-awaiting-ack', { pid: handle.pid, rows });
}
async function startRule(selector) {
    await click(selector);
    await click('#proceed-start-confirm-btn');
}
async function safetyScenario(kind) {
    report.scenario = kind;
    const postquit = kind === 'postquit';
    const a = await createAndStart(report.fixtures.target.name, false);
    const b = kind === 'overlap' ? await createAndStart(report.fixtures.target.name, false) : null;
    const c = await createAndStart(report.fixtures.secondary.name, false);
    const control = launchFixture(report.fixtures.control, root, 'control'); handles.push(control);
    let target = launchFixture(report.fixtures.target, root, 'safety', postquit); handles.push(target);
    await Promise.all([ready(target), ready(control)]);
    await recordInteraction(target, 'safety-target-baseline');
    await recordInteraction(control, 'safety-control-baseline');
    // Cache element references before the native 30-second countdown starts.
    const confirm = await $('#confirm-override-btn');
    if (kind === 'stale') {
        report.faultInjection = { layer: 'frontend Tauri warning-show callback', runtimeInjected: true, releaseCandidate: false };
        await browser.execute((pid) => {
            const callbacks = window.__TAURI_INTERNALS__.callbacks;
            if (!(callbacks instanceof Map)) throw new Error('Tauri callback registry unavailable');
            window.__HOSTED_STALE_WARNING__ = null;
            for (const [id, callback] of callbacks) {
                callbacks.set(id, (data) => {
                    if (data?.event === 'app-blocking://warning-show' && Number(data.payload?.pid) === pid) {
                        window.__HOSTED_STALE_WARNING__ = { callback, data: structuredClone(data) };
                    }
                    return callback(data);
                });
            }
        }, target.pid);
    }
    await startRule(a);
    await waitForWarning(target);
    if (b) {
        let ack;
        await click('#app-blocking-lets-go-btn', () => { ack = performance.now(); });
        await until(async () => { await heartbeat(control); return !alive(target); }, 45_000, 'Initial overlap source did not enforce');
        assert(performance.now() - ack >= 29_000);
        await startRule(b);
        await permanentStop(a);
        assert.equal(await $(b).getAttribute('aria-checked'), 'true');
        target = launchFixture(report.fixtures.target, root, 'overlap-still-blocked'); handles.push(target);
        // Mid-block launches intentionally receive immediate close, without an ack.
        await until(async () => { await heartbeat(control); return !alive(target); }, 15_000, 'Remaining overlap source allowed relaunch');
        event('overlap-remaining-source-enforced', { stopped: a, remaining: b, pid: target.pid });
        await permanentStop(b);
        target = launchFixture(report.fixtures.target, root, 'overlap-released'); handles.push(target);
        await ready(target);
    } else {
        await browser.execute(() => {
            window.__HOSTED_CONFIRM_OBSERVATION__ = null;
            document.getElementById('confirm-override-btn').addEventListener('click', (e) => {
                window.__HOSTED_CONFIRM_OBSERVATION__ = { trusted: e.isTrusted, now: Date.now(), rows: [...window.__REDDBLOCK_INTERNALS__.appBlockingWarningRows].map(([pid, r]) => ({ pid, deadline: r.ackedDeadlineMs })) };
            }, { capture: true, once: true });
        });
        const ack = await $('#app-blocking-lets-go-btn');
        await browser.action('pointer').move({ origin: ack }).down().up().pause(1000).perform();
        // Acknowledgement rebuilds the cards. Read current geometry after that
        // render and hit-test it; never reuse the detached switch element.
        const point = await browser.execute((selector) => {
            const e = document.querySelector(selector);
            const r = e.getBoundingClientRect();
            const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
            const hit = document.elementFromPoint(x, y);
            if (hit !== e && !e.contains(hit)) throw new Error('Stop switch is obscured');
            return { x, y };
        }, a);
        await browser.action('pointer').move(point).down().up().perform();
        const challenge = await browser.execute(() => ({ text: document.getElementById('challenge-text').textContent, duration: document.getElementById('unlock-duration-select').value }));
        assert.equal(challenge.text.trim().split(/\s+/).length, 15);
        assert.equal(challenge.duration, '10', 'Expected ordinary initial ten-minute pause');
        await browser.keys(challenge.text);
        if (postquit) {
            await until(() => {
                assert(alive(target), 'Stubborn target exited before grace cancellation');
                return existsSync(path.join(target.directory, 'polite-quit'));
            }, 40_000, 'No real polite quit received by stubborn target', { intervalMs: 50 });
            event('postquit-grace-entered', { pid: target.pid, politeQuitWallTime: statSync(path.join(target.directory, 'polite-quit')).mtimeMs });
        }
        await browser.action('pointer').move({ origin: confirm }).down().up().perform();
        const observed = await browser.execute(() => window.__HOSTED_CONFIRM_OBSERVATION__);
        event('pending-confirm-phase-observation', { observed, pid: target.pid });
        // Embedded WebDriver dispatches synthetic events (isTrusted=false).
        // Keep that evidence; command provenance, the actual challenge and
        // native survival are the oracles, not browser event trust branding.
        assert(observed, 'WebDriver confirmation did not reach the button');
        const row = observed.rows.find((r) => Number(r.pid) === target.pid);
        if (postquit) {
            const politeAt = statSync(path.join(target.directory, 'polite-quit')).mtimeMs;
            assert(row && observed.now >= row.deadline && observed.now >= politeAt && observed.now - politeAt < 10_000, 'Stop missed actual post-quit grace phase');
        } else {
            assert(row?.deadline > observed.now && row.deadline - observed.now < 30_000, 'Stop missed acknowledged pre-quit phase');
        }
        await browser.waitUntil(async () => await $(a).getAttribute('aria-checked') === 'false', { timeout: 10_000 });
        assert(alive(target), 'Pending cancellation must preserve original PID');
        if (!postquit) assert(!existsSync(path.join(target.directory, 'polite-quit')), 'Cancellation already sent polite quit');
        event(postquit ? 'postquit-grace-cancelled' : 'pending-prequit-cancelled', { pid: target.pid, pauseMinutes: 10, remainingMs: row.deadline - observed.now });
    }
    await recordInteraction(target, 'safety-target-released');
    if (kind === 'stale') {
        const injection = await browser.execute(() => {
            const saved = window.__HOSTED_STALE_WARNING__;
            if (!saved) throw new Error('No genuine warning callback captured');
            saved.callback(structuredClone(saved.data));
            return { payload: saved.data.payload, injectedAt: Date.now() };
        });
        event('stale-warning-callback-replayed', injection);
        await screenshot('stale-callback-after-release');
        await assertNoTargetWarnings(target);
    }
    const secondary = launchFixture(report.fixtures.secondary, root, 'later-ack', postquit); handles.push(secondary);
    await ready(secondary);
    await startRule(c);
    await waitForWarning(secondary);
    let secondAck;
    await click('#app-blocking-lets-go-btn', () => { secondAck = performance.now(); });
    const end = performance.now() + 75_000;
    while (performance.now() < end) {
        await heartbeat(target);
        await heartbeat(control);
        assert(!(await warningRows()).some((r) => Number(r.pid) === target.pid || r.name === target.name), 'Released target re-enrolled after later acknowledgement');
        event('safety-release-sample', { targetPid: target.pid, controlPid: control.pid, secondaryAlive: alive(secondary) });
        if (alive(secondary)) {
            if (postquit) {
                const marker = path.join(secondary.directory, 'polite-quit');
                assert(performance.now() - secondAck <= 55_000, 'Stubborn secondary survived total enforcement observation budget');
                if (existsSync(marker)) assert(Date.now() - statSync(marker).mtimeMs <= 15_000, 'Stubborn secondary survived post-quit force-kill observation budget');
            } else {
                assert(performance.now() - secondAck <= 45_000, 'Secondary survived enforcement deadline');
            }
        }
        await delay(1000);
    }
    assert(!alive(secondary));
    assert(existsSync(path.join(secondary.directory, 'polite-quit')));
    if (postquit) {
        assert(!existsSync(path.join(secondary.directory, 'fixture-error.txt')), 'Secondary exited through a fixture exception');
        const closeToExitMs = secondary.exitObservation?.wallTime - statSync(path.join(secondary.directory, 'polite-quit')).mtimeMs;
        assert(closeToExitMs >= 9_000 && closeToExitMs <= 15_000, 'Stubborn secondary did not survive its normal grace before termination');
        event('stubborn-secondary-termination-observed', { pid: secondary.pid, closeToExitMs, exit: secondary.exitObservation });
    }
    await assertNoTargetWarnings(target);
    await recordInteraction(target, 'safety-target-after-later-ack-75s');
    await recordInteraction(control, 'safety-control-after-later-ack-75s');
    await screenshot(kind + '-complete');
    report.behaviour = 'PASS';
    event('safety-scenario-complete', { kind, targetPid: target.pid, minimumObservationMs: 75_000 });
}
describe('Hosted native app recovery feasibility', () => {
    it('enforces and legitimately pauses a real target while its control remains usable', async () => {
        try {
            await setup();
            if (process.env.HOSTED_SCENARIO && process.env.HOSTED_SCENARIO !== 'recovery') {
                assert(['pending', 'overlap', 'postquit', 'stale'].includes(process.env.HOSTED_SCENARIO));
                await safetyScenario(process.env.HOSTED_SCENARIO);
                return;
            }
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
            let acknowledgedAt;
            await click('#app-blocking-lets-go-btn', () => { acknowledgedAt = performance.now(); });
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
            await screenshot('pause-accepted');
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
