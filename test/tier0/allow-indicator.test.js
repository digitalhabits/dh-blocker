import { expect, test } from 'vitest';
import { describeIndicator } from '../../src/allow-indicator.js';
import { SETTINGS_TRANSLATIONS } from '../../src/i18n.js';

const base = {
    active: true,
    spaces: [{ name: 'Deep work' }],
    websites: ['docs.google.com', 'wikipedia.org'],
    allWebsites: false,
    apps: ['Word'],
    allApps: false,
    blocklistAlsoActive: false,
};

const section = (d, kind) => d.sections.find((s) => s.kind === kind);

test('summarises the effective list and names the space', () => {
    const d = describeIndicator(base, 'en');
    expect(d.title).toBe('Deep work');
    expect(d.summary).toBe('2 sites, 1 app allowed');
    expect(section(d, 'websites').items).toEqual(['docs.google.com', 'wikipedia.org']);
    expect(section(d, 'apps').items).toEqual(['Word']);
    expect(d.footer).toBe('Everything else is blocked');
});

test('several spaces are named as one plus a count', () => {
    const d = describeIndicator({ ...base, spaces: [{ name: 'Deep work', emoji: '📚' }, { name: 'Essay' }, { name: 'Lab' }] }, 'en');
    expect(d.title).toBe('📚 Deep work + 2 more');
});

test('an unrestricted side says "all", and says so honestly beside a blocklist', () => {
    const open = describeIndicator({ ...base, websites: [], allWebsites: true }, 'en');
    expect(open.summary).toBe('All sites, 1 app allowed');
    expect(section(open, 'websites')).toMatchObject({ note: 'All websites', items: [] });

    const withBlocklist = describeIndicator({ ...base, websites: [], allWebsites: true, blocklistAlsoActive: true }, 'en');
    expect(section(withBlocklist, 'websites').note).toBe('All websites, except those another focus space blocks');
});

test('a list emptied by another space does not read as "all"', () => {
    const d = describeIndicator({ ...base, websites: [], allWebsites: false, blocklistAlsoActive: true }, 'en');
    expect(d.summary).toBe('0 sites, 1 app allowed');
    expect(section(d, 'websites').note).toBe('None. Another focus space blocks the listed websites.');
});

test('an end time appears in the footer', () => {
    const d = describeIndicator({ ...base, endsAt: new Date(2026, 10, 27, 14, 30).getTime() }, 'en');
    expect(d.footer).toMatch(/^Everything else is blocked until .*30/);
});

test('every language has every indicator string', () => {
    const keys = Object.keys(SETTINGS_TRANSLATIONS.en).filter((k) => /allowIndicator/i.test(k));
    expect(keys.length).toBeGreaterThan(20);
    for (const lang of ['da', 'zh-CN']) {
        for (const key of keys) expect(SETTINGS_TRANSLATIONS[lang][key], `${lang}.${key}`).toBeTruthy();
    }
});
