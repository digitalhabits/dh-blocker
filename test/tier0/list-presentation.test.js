import { describe, expect, test } from 'vitest';
import {
    blocklistCardHasExpandableSummary,
    buildBlocklistCardMetaHtml,
    formatEditorItemCounts,
} from '../../src/list-presentation.js';

function metaText(blocklist) {
    const host = document.createElement('div');
    host.innerHTML = buildBlocklistCardMetaHtml(blocklist);
    return {
        text: host.textContent,
        button: host.querySelector('.blocklist-meta-items-btn'),
    };
}

describe('focus-space card summary honours "show names in the overview"', () => {
    test('a short list shows its names when the option is on', () => {
        const bl = { websites: ['twitter.com', 'x.com'], apps: [], showItemDetails: true };
        const { text, button } = metaText(bl);
        expect(text).toContain('twitter.com');
        expect(text).toContain('x.com');
        expect(button).not.toBeNull();
        expect(blocklistCardHasExpandableSummary(bl)).toBe(true);
    });

    test('the option defaults to on for spaces saved without it', () => {
        expect(metaText({ websites: ['twitter.com', 'x.com'], apps: [] }).text).toContain('twitter.com');
    });

    test('a long list falls back to counts but stays expandable', () => {
        const bl = { websites: ['a.com', 'b.com', 'c.com', 'd.com'], apps: [], showItemDetails: true };
        const { text, button } = metaText(bl);
        expect(text).toContain('4 sites');
        expect(text).not.toContain('a.com');
        expect(button).not.toBeNull();
    });

    test('a single item is reduced to a count when the option is off', () => {
        const bl = { websites: ['ulriklyngs.com'], apps: [], showItemDetails: false };
        const { text } = metaText(bl);
        expect(text).not.toContain('ulriklyngs');
        expect(text).toContain('1 site');
    });

    test('with the option off nothing on the card can reveal the names', () => {
        const bl = { websites: ['twitter.com', 'x.com'], apps: [], showItemDetails: false };
        const { text, button } = metaText(bl);
        expect(text).toContain('2 sites');
        expect(text).not.toContain('twitter');
        expect(button).toBeNull();
        expect(blocklistCardHasExpandableSummary(bl)).toBe(false);
    });
});

describe('editor "What to block" summary', () => {
    test('one of something is singular', () => {
        expect(formatEditorItemCounts({ websites: 1, apps: 0 })).toBe('1 website · 0 apps');
        expect(formatEditorItemCounts({ websites: 2, apps: 1 })).toBe('2 websites · 1 app');
        expect(formatEditorItemCounts({ websites: 0, apps: 28 })).toBe('0 websites · 28 apps');
    });
});
