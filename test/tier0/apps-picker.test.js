import { describe, expect, test } from 'vitest';
import { canOfferTypedAppName } from '../../src/apps-picker.js';

const installed = [
    { display_name: 'Google Chrome', process_name: 'Google Chrome' },
    { display_name: 'Xcode', process_name: 'Xcode' },
];

describe('offering to add an app the scan missed', () => {
    test('a name the search did not find can be added by hand', () => {
        expect(canOfferTypedAppName('Photoshop', installed)).toBe(true);
    });

    test('a name already in the list is not offered — it is in the rows above', () => {
        expect(canOfferTypedAppName('Xcode', installed)).toBe(false);
        expect(canOfferTypedAppName('google chrome', installed)).toBe(false);
        expect(canOfferTypedAppName('  Xcode  ', installed)).toBe(false);
    });

    test('nothing is offered for an empty search', () => {
        expect(canOfferTypedAppName('', installed)).toBe(false);
        expect(canOfferTypedAppName('   ', installed)).toBe(false);
    });

    test('the blocker itself is refused however it is spelled', () => {
        // Blocking it would take enforcement down with it, so the picker must
        // not hand the user a way in through the typed-name path.
        for (const name of ['Digital Habits Blocker', 'digital habits: blocker', 'ReDD Blocker', 'redd-block']) {
            expect(canOfferTypedAppName(name, installed)).toBe(false);
        }
    });
});
