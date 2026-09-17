// The screen list for the UI screenshot harness (scripts/ui/shoot.mjs).
//
// One entry per screenshot. Adding a screen should mean adding an object here,
// not editing the driver.
//
// `platform` is required, and it is not cosmetic. detectPlatform() has no Linux
// branch and falls through to `body.windows`, so an unstamped screenshot taken
// in a container or CI silently claims to be a Windows one. It also decides
// whether a screen exists at all: `handset-device` hides whole sections, so
// asking for a week calendar on `android` or `iphone` is asking for a screen the
// app never renders. The driver fails such a screen rather than emitting a blank
// PNG.
//
// Omit `clip` to capture the whole app; set it to zoom in on one component.
// Both are worth having: the full shots are the only place layout problems
// *between* sections show up, and the clipped ones are the only place a 9px
// band is big enough to judge.

import { fixtures } from './fixtures.js';

/**
 * @typedef {object} Screen
 * @property {string}   name      output filename stem
 * @property {object}   fixture   appData to boot with
 * @property {string}   platform  'windows' | 'mac' | 'ipad' | 'iphone' | 'android'
 * @property {string}  [theme]    'light' | 'dark'
 * @property {object}  [viewport] { width, height } — device size, not a crop
 * @property {string}  [clip]     selector to screenshot instead of the whole page
 * @property {Function} [prepare] async (page) => {} run after render, before the shot
 */

// Real device sizes. A phone rendered at desktop width is not a phone
// screenshot — the handset layout rules are width-dependent as well as
// class-dependent.
const IPHONE = { width: 390, height: 844 };
const ANDROID_PHONE = { width: 412, height: 915 };
const IPAD = { width: 1024, height: 768 };
const DESKTOP = { width: 1100, height: 900 };

/** @type {Screen[]} */
export const screens = [
    // ---- Whole app, per platform -------------------------------------------
    // The mobile ones are the home screen as a phone actually gets it: no week
    // calendar (hidden by `handset-device`), no title bar, no window controls.
    {
        name: 'home-windows',
        fixture: fixtures.crowdedWeek,
        platform: 'windows',
        viewport: DESKTOP,
    },
    {
        name: 'home-mac',
        fixture: fixtures.crowdedWeek,
        platform: 'mac',
        viewport: DESKTOP,
    },
    {
        name: 'home-ipad',
        fixture: fixtures.crowdedWeek,
        platform: 'ipad',
        viewport: IPAD,
    },
    {
        name: 'home-iphone',
        fixture: fixtures.crowdedWeek,
        platform: 'iphone',
        viewport: IPHONE,
    },
    {
        name: 'home-android',
        fixture: fixtures.crowdedWeek,
        platform: 'android',
        viewport: ANDROID_PHONE,
    },
    {
        name: 'home-windows-dark',
        fixture: fixtures.crowdedWeek,
        platform: 'windows',
        theme: 'dark',
        viewport: DESKTOP,
    },

    // ---- The week calendar on its own --------------------------------------
    {
        name: 'week-crowded',
        fixture: fixtures.crowdedWeek,
        platform: 'windows',
        viewport: DESKTOP,
        clip: '.week-calendar-section',
    },
    {
        name: 'week-crowded-dark',
        fixture: fixtures.crowdedWeek,
        platform: 'windows',
        theme: 'dark',
        viewport: DESKTOP,
        clip: '.week-calendar-section',
    },
    {
        // iPad is the *only* touch platform that shows this view, so it is the
        // one screen where the label-free bands' hover-only tooltip fallback is
        // genuinely unavailable to the user.
        name: 'week-crowded-ipad',
        fixture: fixtures.crowdedWeek,
        platform: 'ipad',
        viewport: IPAD,
        clip: '.week-calendar-section',
    },
    {
        name: 'week-single',
        fixture: fixtures.singleSchedule,
        platform: 'windows',
        viewport: DESKTOP,
        clip: '.week-calendar-section',
    },

    // ---- Home with nothing selected: the scheduler column is simply empty ----
    {
        name: 'home-idle-desktop',
        fixture: fixtures.cardStates,
        platform: 'mac',
        viewport: DESKTOP,
    },

    // ---- A fresh install: no default focus space ----------------------------
    {
        name: 'home-empty-desktop',
        fixture: fixtures.emptyInstall,
        platform: 'mac',
        viewport: DESKTOP,
    },
    {
        name: 'home-empty-iphone',
        fixture: fixtures.emptyInstall,
        platform: 'iphone',
        viewport: IPHONE,
    },

    // ---- Focus-space cards: switch on / off / paused --------------------------
    {
        name: 'cards-desktop',
        fixture: fixtures.cardStates,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#blocklists-container',
    },
    {
        // "Show names … in the overview" on: a lone item and a short list show
        // names, a long list shows counts; both lists expand.
        name: 'cards-names-shown',
        fixture: fixtures.cardNamesShown,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#blocklists-container',
    },
    {
        // …and off: counts only, with no dashed underline — nothing expands.
        name: 'cards-names-hidden',
        fixture: fixtures.cardNamesHidden,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#blocklists-container',
    },
    {
        // Full schedule when it fits ("09:00 – 12:00, 18:00 – 22:00"), "+N" when not.
        name: 'cards-schedule-ranges',
        fixture: fixtures.multiRangeSchedules,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#blocklists-container',
    },
    {
        name: 'cards-schedule-ranges-one-column',
        fixture: fixtures.multiRangeSchedules,
        platform: 'mac',
        viewport: { width: 700, height: 900 },
        clip: '#blocklists-container',
    },
    {
        name: 'cards-iphone',
        fixture: fixtures.cardStates,
        platform: 'iphone',
        viewport: IPHONE,
    },

    // ---- Turning a space on: what will be blocked, the way out, the unlock ----
    {
        name: 'start-confirm-modal',
        fixture: fixtures.cardStates,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#start-block-confirm-modal .modal-content',
        prepare: async (page) => {
            await page.click('.blocklist-card[data-id="bl-sched-off"] .blocklist-switch');
            await page.waitForSelector('#start-block-confirm-modal:not(.hidden)');
        },
    },
    {
        name: 'editor-edit-dirty',
        fixture: fixtures.singleSchedule,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#time-picker-container',
        prepare: async (page) => {
            await page.fill('#blocklist-name', 'Deep Work (renamed)');
            await page.dispatchEvent('#blocklist-name', 'input');
        },
    },
    {
        // The editor's own "Discard changes?" dialog (it used to be the OS one).
        name: 'editor-discard-dialog',
        fixture: fixtures.singleSchedule,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#editor-discard-modal .modal-content',
        prepare: async (page) => {
            await page.evaluate(() => { void window.__REDDBLOCK_INTERNALS__.showEditorDiscardConfirmModal(); });
            await page.waitForSelector('#editor-discard-modal:not(.hidden)');
        },
    },
    {
        name: 'editor-discard-dialog-dark',
        fixture: fixtures.singleSchedule,
        platform: 'mac',
        theme: 'dark',
        viewport: DESKTOP,
        clip: '#editor-discard-modal .modal-content',
        prepare: async (page) => {
            await page.evaluate(() => { void window.__REDDBLOCK_INTERNALS__.showEditorDiscardConfirmModal(); });
            await page.waitForSelector('#editor-discard-modal:not(.hidden)');
        },
    },

    // ---- Stopping a space: the challenge modal + unlock outcome line -------
    {
        name: 'stop-modal-manual',
        fixture: fixtures.manualRunning,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#override-modal .modal-content',
        prepare: async (page) => {
            await page.click('.blocklist-card[data-id="bl-manual"] .blocklist-switch');
            await page.waitForSelector('#override-modal:not(.hidden)');
        },
    },
    {
        // Whole window, not just the dialog: the point is how far the page
        // behind the stop challenge is dimmed.
        name: 'stop-modal-scrim',
        fixture: fixtures.manualRunning,
        platform: 'mac',
        viewport: DESKTOP,
        prepare: async (page) => {
            await page.click('.blocklist-card[data-id="bl-manual"] .blocklist-switch');
            await page.waitForSelector('#override-modal:not(.hidden)');
        },
    },
    {
        name: 'stop-modal-scrim-dark',
        fixture: fixtures.manualRunning,
        platform: 'mac',
        theme: 'dark',
        viewport: DESKTOP,
        prepare: async (page) => {
            await page.click('.blocklist-card[data-id="bl-manual"] .blocklist-switch');
            await page.waitForSelector('#override-modal:not(.hidden)');
        },
    },
    {
        name: 'stop-modal-flexible',
        fixture: fixtures.flexibleBetweenBlocks,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#override-modal .modal-content',
        prepare: async (page) => {
            await page.click('.blocklist-card[data-id="bl-flex"] .blocklist-switch');
            await page.waitForSelector('#override-modal.override-frictionless:not(.hidden)');
        },
    },

    // ---- The focus-space editor -------------------------------------------
    // One form for create (modal) and edit (panel; sheet on phones). The sole
    // space in the fixture is auto-selected, so the panel shows its editor.
    {
        name: 'editor-edit-weekly',
        fixture: fixtures.singleSchedule,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#time-picker-container',
        prepare: async (page) => {
            await page.click('#editor-section-when-header');
        },
    },
    {
        // The expanded time row: start / end and the day circles (M T W T F S S).
        // weeklyOffPeak: one Weekly segment, not enforcing now, so the editor
        // renders it expanded and unlocked (a live schedule disables the row).
        name: 'editor-weekly-days',
        fixture: fixtures.weeklyOffPeak,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#editor-section-when',
        prepare: async (page) => {
            await page.click('#editor-section-when-header');
        },
    },
    {
        name: 'editor-weekly-days-iphone',
        fixture: fixtures.weeklyOffPeak,
        platform: 'iphone',
        viewport: IPHONE,
        prepare: async (page) => {
            await page.click('.blocklist-card');
            await page.click('#editor-section-when-header');
        },
    },
    {
        // Custom Text: the field sits directly under Method, inside the panel.
        name: 'editor-stop-early-custom',
        fixture: fixtures.weeklyOffPeak,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#editor-section-stop',
        prepare: async (page) => {
            await page.click('#editor-section-stop-header');
            await page.selectOption('#override-type', 'custom');
            await page.dispatchEvent('#override-type', 'change');
        },
    },
    {
        name: 'editor-edit-stop-early',
        fixture: fixtures.singleSchedule,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#time-picker-container',
        prepare: async (page) => {
            await page.click('#editor-section-stop-header');
        },
    },
    {
        name: 'editor-create',
        fixture: fixtures.singleSchedule,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#blocklist-modal .modal-content',
        prepare: async (page) => {
            // A fresh space opens on What to block; type a website and pick nothing else.
            await page.click('#add-blocklist-btn');
            await page.fill('#modal-website-input', 'reddit.com');
            await page.keyboard.press('Enter');
        },
    },
    {
        name: 'editor-edit-weekly-dark',
        fixture: fixtures.singleSchedule,
        platform: 'mac',
        theme: 'dark',
        viewport: DESKTOP,
        clip: '#time-picker-container',
        prepare: async (page) => {
            await page.click('#editor-section-when-header');
        },
    },
    {
        name: 'editor-edit-what',
        fixture: fixtures.singleSchedule,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#time-picker-container',
        prepare: async (page) => {
            await page.click('#editor-section-what-header');
        },
    },
    {
        // App-styled dropdown menu (not the OS one), opened in the create form.
        // The create form, not the edit panel: singleSchedule's space is running
        // on weekday mornings, and a running space locks To stop early.
        name: 'dropdown-unlock-open',
        fixture: fixtures.singleSchedule,
        platform: 'mac',
        viewport: DESKTOP,
        prepare: async (page) => {
            await page.click('#add-blocklist-btn');
            await page.click('#editor-section-stop-header');
            await page.click('#unlock-duration-select-trigger');
            await page.waitForSelector('#unlock-duration-select-menu:not(.hidden)');
        },
    },
    {
        name: 'dropdown-unlock-open-dark',
        fixture: fixtures.singleSchedule,
        platform: 'mac',
        theme: 'dark',
        viewport: DESKTOP,
        prepare: async (page) => {
            await page.click('#add-blocklist-btn');
            await page.click('#editor-section-stop-header');
            await page.click('#unlock-duration-select-trigger');
            await page.waitForSelector('#unlock-duration-select-menu:not(.hidden)');
        },
    },
    {
        name: 'dropdown-settings-theme-open',
        fixture: fixtures.singleSchedule,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#settings-modal .modal-content',
        prepare: async (page) => {
            await page.click('#settings-btn');
            await page.waitForSelector('#settings-modal:not(.hidden)');
            await page.click('#theme-select-trigger');
            await page.waitForSelector('#theme-select-menu:not(.hidden)');
        },
    },
    {
        // Settings → Enforcement: the "Maximum words to stop early" slider.
        name: 'settings-max-words',
        fixture: fixtures.highWordMaximum,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#settings-enforcement-panel',
        prepare: async (page) => {
            await page.click('#settings-btn');
            await page.waitForSelector('#settings-modal:not(.hidden)');
            if (await page.getAttribute('#settings-enforcement-section-toggle', 'aria-expanded') !== 'true') {
                await page.click('#settings-enforcement-section-toggle');
            }
            await page.locator('#settings-max-words-row').scrollIntoViewIfNeeded();
        },
    },
    {
        // The setting was lowered to 50 after this space was set to 800 words:
        // the slider stretches to 800 rather than cutting the challenge.
        name: 'editor-stop-early-above-maximum',
        fixture: fixtures.loweredWordMaximum,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#time-picker-container',
        prepare: async (page) => {
            await page.click('#editor-section-stop-header');
        },
    },
    {
        name: 'editor-edit-advanced',
        fixture: fixtures.singleSchedule,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#time-picker-container',
        prepare: async (page) => {
            await page.click('#editor-section-advanced-header');
        },
    },
    {
        // "Editing" dropdown open on a block space: stricter means adding.
        name: 'editor-editing-options-block',
        fixture: fixtures.blockScheduleOff,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#time-picker-container',
        prepare: async (page) => {
            await page.click('#editor-section-advanced-header');
            await page.click('#schedule-strictness-dropdown-btn');
            await page.waitForSelector('#schedule-strictness-dropdown-menu:not(.hidden)');
        },
    },
    {
        // …and on an allow-only space, where stricter means allowing less.
        name: 'editor-editing-options-allow',
        fixture: fixtures.allowScheduleOff,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#time-picker-container',
        prepare: async (page) => {
            await page.click('#editor-section-advanced-header');
            await page.click('#schedule-strictness-dropdown-btn');
            await page.waitForSelector('#schedule-strictness-dropdown-menu:not(.hidden)');
        },
    },
    {
        // A long Start alert name must truncate, keeping the pencil in the panel.
        name: 'editor-advanced-long-alert',
        fixture: fixtures.longStartAlertName,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#time-picker-container',
        prepare: async (page) => {
            await page.click('#editor-section-advanced-header');
        },
    },
    {
        name: 'editor-create-daily',
        fixture: fixtures.singleSchedule,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#blocklist-modal .modal-content',
        prepare: async (page) => {
            await page.click('#add-blocklist-btn');
            await page.click('#editor-section-when-header');
            await page.click('#when-kind-daily');
            await page.click('#until-date');
        },
    },
    {
        name: 'editor-edit-manual',
        fixture: fixtures.manualRunning,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#time-picker-container',
        prepare: async (page) => {
            // Locked space with websites and an app: chips render as locked.
            await page.click('#editor-section-what-header');
        },
    },
    {
        // Desktop single-column (≤718px): the editor opens as a sheet, and its
        // title row should match the two-column panel's, back chevron in front.
        name: 'editor-edit-narrow-desktop',
        fixture: fixtures.cardStates,
        platform: 'mac',
        viewport: { width: 600, height: 900 },
        prepare: async (page) => {
            await page.click('.blocklist-card[data-id="bl-on"]', { position: { x: 30, y: 20 } });
            await page.waitForSelector('body.enter-scheduler-modal-open');
        },
    },
    {
        name: 'editor-edit-iphone',
        fixture: fixtures.singleSchedule,
        platform: 'iphone',
        viewport: IPHONE,
        prepare: async (page) => {
            await page.click('.blocklist-card');
            await page.click('#editor-section-when-header');
        },
    },
];
