import { afterEach, describe, expect, test } from 'vitest';
import { isBackgroundClick } from '../../src/background-click.js';

afterEach(() => {
    document.body.innerHTML = '';
});

describe('isBackgroundClick', () => {
    test('a click on empty page deselects', () => {
        document.body.innerHTML = '<main id="page"></main>';
        const page = document.getElementById('page');
        expect(isBackgroundClick(page, page)).toBe(true);
    });

    test('a click inside the focus space editor keeps the selection', () => {
        document.body.innerHTML = '<section class="scheduler-section"><span id="tag" class="tag">a.com</span></section>';
        const tag = document.getElementById('tag');
        expect(isBackgroundClick(tag, tag)).toBe(false);
    });

    test('a chip that re-rendered under the click keeps the selection', () => {
        // Clicking a website chip selects it, and selecting re-renders the
        // chips: by the time the click reaches the document, the element it
        // landed on has been replaced and has no ancestors left to match.
        // That used to read as a background click and closed the editor.
        document.body.innerHTML = '<section class="scheduler-section"><div id="tags"><span id="tag" class="tag">a.com</span></div></section>';
        const tag = document.getElementById('tag');
        document.getElementById('tags').innerHTML = '<span class="tag selected">a.com</span>';
        expect(tag.isConnected).toBe(false);
        expect(isBackgroundClick(tag, tag)).toBe(false);
    });
});
