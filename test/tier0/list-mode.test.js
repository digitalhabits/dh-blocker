import { beforeEach, describe, expect, test } from 'vitest';
import { updateBlocklistModalModeLabels } from '../../src/list-mode.js';

const text = (id) => document.getElementById(id).textContent;

describe('"Editing" option descriptions follow the space\'s mode', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <span id="strictness-option-committed-title"></span>
            <span id="strictness-option-committed-desc"></span>
            <span id="strictness-option-flexible-title"></span>
            <span id="strictness-option-flexible-desc"></span>`;
    });

    test('a block space gets stricter by adding', () => {
        updateBlocklistModalModeLabels('blocklist');
        expect(text('strictness-option-committed-desc')).toMatch(/add websites, apps and times/i);
        expect(text('strictness-option-flexible-desc')).toMatch(/remove things/i);
    });

    test('an allow-only space gets stricter by removing what is allowed', () => {
        // The mirror is not exact: allowing fewer things is stricter, but
        // adding a time still is — so the copy has to say both.
        updateBlocklistModalModeLabels('allowlist');
        expect(text('strictness-option-committed-desc')).toMatch(/remove allowed websites and apps/i);
        expect(text('strictness-option-committed-desc')).toMatch(/add times/i);
        expect(text('strictness-option-flexible-desc')).toMatch(/allow more things/i);
    });

    test('the titles name the outcome and do not change with the mode', () => {
        updateBlocklistModalModeLabels('blocklist');
        const block = [text('strictness-option-committed-title'), text('strictness-option-flexible-title')];
        updateBlocklistModalModeLabels('allowlist');
        const allow = [text('strictness-option-committed-title'), text('strictness-option-flexible-title')];
        expect(block).toEqual(['Stricter only', 'Any change']);
        expect(allow).toEqual(block);
    });

    test('switching back restores the block wording', () => {
        updateBlocklistModalModeLabels('allowlist');
        updateBlocklistModalModeLabels('blocklist');
        expect(text('strictness-option-committed-desc')).not.toMatch(/allowed/i);
    });
});

describe('"What to block" heading follows the mode', () => {
    beforeEach(() => {
        document.body.innerHTML = '<span id="editor-section-what-title"></span>';
    });

    test('an allow-only space lists what to allow', () => {
        updateBlocklistModalModeLabels('allowlist');
        expect(text('editor-section-what-title')).toBe('What to allow');
        updateBlocklistModalModeLabels('blocklist');
        expect(text('editor-section-what-title')).toBe('What to block');
    });
});
