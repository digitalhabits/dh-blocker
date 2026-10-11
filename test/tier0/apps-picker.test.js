import { describe, expect, test } from 'vitest';
import { canOfferTypedAppName } from '../../src/apps-picker.js';

const installed = [
    { display_name: 'Google Chrome', process_name: 'Google Chrome' },
    { display_name: 'Xcode', process_name: 'Xcode' },
];

describe('offering to add an app the scan missed', () => {
    test('offered only when the search found nothing', () => {
        expect(canOfferTypedAppName('Photoshop', installed)).toBe(true);
        expect(canOfferTypedAppName('  Xcode  ', installed)).toBe(false);
        expect(canOfferTypedAppName('google chrome', installed)).toBe(false);
        expect(canOfferTypedAppName('   ', installed)).toBe(false);
    });

    test('the blocker itself is refused however it is spelled', () => {
        // Blocking it would take enforcement down with it, so this path must not
        // hand the user a way in that the installed list already refuses.
        for (const name of ['Digital Habits Blocker', 'digital habits: blocker', 'ReDD Blocker', 'redd-block']) {
            expect(canOfferTypedAppName(name, installed)).toBe(false);
        }
    });
});
