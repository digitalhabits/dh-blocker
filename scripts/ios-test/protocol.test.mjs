import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSafeBuild, selectDevice } from './apple.mjs';
import { assertObservation, pendingCases, sameInstalledApp } from './device.mjs';
import { lineReader, navigationRequest } from './navigation.mjs';
import { profileMatches } from './provisioning.mjs';
import { driverConfiguration, failureVerdict, passedOneTest } from './xctest.mjs';

const device = {
    identifier: 'CORE-DEVICE',
    hardwareProperties: { platform: 'iOS', reality: 'physical', udid: 'HARDWARE-DEVICE' },
    deviceProperties: { name: 'iPad' },
};

test('selects a physical device by exact identifier even when several devices are listed', () => {
    const devices = [device,
        { ...device, identifier: 'OTHER', hardwareProperties: { ...device.hardwareProperties, udid: 'OTHER-UDID' } }];
    assert.equal(selectDevice(devices, 'hardware-device'), device);
    assert.equal(selectDevice(devices, 'core-device'), device);
    assert.throws(() => selectDevice(devices, 'iPad'), /explicit|Specify/);
    assert.throws(() => selectDevice(devices, 'HARDWARE'), /explicit|Specify/);
    assert.throws(() => selectDevice([device, device], 'core-device'), /explicit|Specify/);
});

test('physical builds reject the two automation features and inherited overrides', () => {
    for (const feature of ['e2e-webdriver', 'system-test', 'redd-block/system-test']) {
        assert.throws(() => assertSafeBuild([{ build: { features: [feature] } }], {}), /prohibits/);
    }
    assert.throws(() => assertSafeBuild([], { TAURI_CONFIG: '{}' }), /Unset/);
    assert.doesNotThrow(() => assertSafeBuild([{ build: { features: ['custom-protocol'] } }], {}));
});

test('development profiles must match entitlement, team, identity, expiry and device', () => {
    const profile = { applicationId: 'JD647S9RT6.com.reddblock', teamId: 'JD647S9RT6', expires: '2099-01-01T00:00:00Z',
        familyControls: true, groups: ['group.com.reddblock'], devices: ['DEVICE'], development: true, certificates: ['CERT'] };
    assert.equal(profileMatches(profile, 'com.reddblock', 'device', 'DEVICE', ['CERT']), true);
    assert.equal(profileMatches(profile, 'com.reddblock.monitor', 'device', 'DEVICE', ['CERT']), false);
    assert.equal(profileMatches(profile, 'com.reddblock', 'device', 'WRONG', ['CERT']), false);
    assert.equal(profileMatches(profile, 'com.reddblock', 'device', 'DEVICE', ['WRONG']), false);
    assert.equal(profileMatches({ ...profile, familyControls: false }, 'com.reddblock', 'device', 'DEVICE', ['CERT']), false);
    assert.equal(profileMatches(profile, 'com.reddblock', 'device', 'DEVICE', ['CERT'], Date.parse('2100-01-01')), false);
});

test('a replaced installation invalidates an ongoing run despite a matching version', () => {
    const install = { url: 'file:///old/', bundleId: 'com.reddblock', build: '2', version: '1', developerSigned: true };
    assert.equal(sameInstalledApp(install, install), true);
    assert.equal(sameInstalledApp(install, { ...install, url: 'file:///new/' }), false);
    assert.equal(sameInstalledApp(install, { ...install, developerSigned: false }), false);
    assert.equal(sameInstalledApp(install, null), false);
});

test('automated profiles accept only a real XCTest pass', () => {
    const report = { lane: 'device-full', profile: 'website', cases: {
        'upgrade-continuity': { status: 'PASS' }, relaunch: { status: 'PASS' },
    } };
    assert.deepEqual(pendingCases(report), ['fresh-website']);
    assert.throws(() => assertObservation(report, 'fresh-website', 'PASS', 'manual', ['evidence.png']), /only accepts XCTest/);
    const pause = { ...report, profile: 'pause' };
    assert.deepEqual(pendingCases(pause), ['scheduled-pause']);
    assert.throws(() => assertObservation(pause, 'scheduled-pause', 'PASS', 'manual', ['evidence.png']), /only accepts XCTest/);
    assert.throws(() => assertObservation({ ...report, profile: 'default' }, 'scheduled-pause', 'PASS', 'manual', ['evidence.png']), /only accepts XCTest/);
    assert.equal(passedOneTest({ totalTestCount: 1, passedTests: 1, failedTests: 0, skippedTests: 0 }), true);
    assert.equal(passedOneTest({ totalTestCount: 1, passedTests: 0, failedTests: 0, skippedTests: 1 }), false);
    assert.equal(passedOneTest({ totalTestCount: 2, passedTests: 1, failedTests: 1, skippedTests: 0 }), false);
});

test('XCTest receives only the owned fixture and deadline, preserving Xcode test configuration', () => {
    const base = { Driver: { IsUITestBundle: true, TestHostBundleIdentifier: 'com.reddblock.testing.driver.xctrunner',
        EnvironmentVariables: { TERM: 'dumb' }, UITargetAppEnvironmentVariables: { KEEP: 'yes' } } };
    const fixture = { name: 'RBTest-abcdef12-345', deadline: '2026-11-06T20:00:00Z' };
    const token = 'a'.repeat(32);
    const configured = driverConfiguration(base, fixture, token);
    assert.deepEqual(configured.Driver.EnvironmentVariables,
        { TERM: 'dumb', REDD_IOS_TEST_FIXTURE: fixture.name, REDD_IOS_TEST_END: fixture.deadline, REDD_IOS_NAV_TOKEN: token });
    assert.deepEqual(configured.Driver.UITargetAppEnvironmentVariables, { KEEP: 'yes' });
    assert.throws(() => driverConfiguration({ Driver: { IsUITestBundle: false } }, fixture), /Unexpected Xcode/);
});

test('UI Automation approval and failed behavioural assertions have different verdicts', () => {
    const verdict = text => failureVerdict({ testFailures: [text] }).status;
    assert.equal(verdict({ failureText: 'Timed out while enabling automation mode.',
        testIdentifierString: 'Driver-Runner encountered an error' }), 'BLOCKED');
    assert.equal(verdict({ failureText: 'Expected target to be restricted.',
        testIdentifierString: 'Driver/testFreshWebsiteLifecycle()' }), 'FAIL');
    assert.equal(verdict({ failureText: 'Expected no Blocker alert.',
        testIdentifierString: 'Driver/testScheduledPauseLifecycle()' }), 'FAIL');
});

test('Safari navigation accepts only the current token and exact fixed HTTPS URLs', () => {
    const token = 'a'.repeat(32);
    const url = `https://example.org/?redd-ios-test=${'b'.repeat(32)}`;
    assert.equal(navigationRequest(`REDD_IOS_NAV ${token} ${url}\r`, token), url);
    assert.equal(navigationRequest(`REDD_IOS_NAV ${token} ${url.replace('.org', '.com')}`, token), url.replace('.org', '.com'));
    for (const unsafe of [url.replace('example.org', 'example.org.evil.test'),
        url.replace('example.org', 'example.org@evil.test'), url.replace('example.org', 'example.org:8080'),
        url.replace('https:', 'http:'), url + '&redirect=evil', url + ' --terminate-existing']) {
        assert.equal(navigationRequest(`REDD_IOS_NAV ${token} ${unsafe}`, token), null);
    }
    assert.equal(navigationRequest(`REDD_IOS_NAV ${'c'.repeat(32)} ${url}`, token), null);
    assert.equal(navigationRequest(`prefix REDD_IOS_NAV ${token} ${url}`, token), null);
});

test('stream framing reads split markers and discards overlong diagnostic lines', () => {
    const lines = [];
    const feed = lineReader(line => lines.push(line));
    feed('REDD_IOS_');
    feed('NAV request\r\n' + 'x'.repeat(300));
    feed('incomplete\nnext');
    feed(' line\n');
    assert.deepEqual(lines, ['REDD_IOS_NAV request\r', 'next line']);
});
