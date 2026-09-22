import { describe, expect, test } from 'vitest';
import { cleanDomainInput, parseDomainList, processWebsiteInput } from '../../src/website-input.js';

describe('cleanDomainInput', () => {
    test('a leading www. is dropped, so the entry covers the whole site', () => {
        // Desktop matching is "host == entry, or a subdomain of entry". A
        // stored `www.example.com` therefore never matches `example.com`, and
        // the site the user asked to block stays reachable at its bare domain.
        expect(cleanDomainInput('www.ulriklyngs.com')).toBe('ulriklyngs.com');
        expect(cleanDomainInput('https://www.ulriklyngs.com/about?x=1#top')).toBe('ulriklyngs.com');
        expect(cleanDomainInput('WWW.Example.COM')).toBe('example.com');
        expect(cleanDomainInput('  www.example.com  ')).toBe('example.com');
    });

    test('only a whole leading www label is dropped', () => {
        expect(cleanDomainInput('wwwexample.com')).toBe('wwwexample.com');
        expect(cleanDomainInput('www2.example.com')).toBe('www2.example.com');
        expect(cleanDomainInput('mail.www.example.com')).toBe('mail.www.example.com');
        // `www.com` is a real registrable domain — stripping would leave `com`.
        expect(cleanDomainInput('www.com')).toBe('www.com');
    });

    test('other subdomains are kept as typed', () => {
        expect(cleanDomainInput('https://old.reddit.com/r/x')).toBe('old.reddit.com');
    });
});

describe('website input pipeline', () => {
    test('pasted lists are normalized entry by entry', () => {
        expect(parseDomainList('www.a.com, https://www.b.org/x\nc.net')).toEqual(['a.com', 'b.org', 'c.net']);
    });

    test('a www. entry is accepted and added in its bare form', () => {
        const result = processWebsiteInput('www.ulriklyngs.com');
        expect(result.invalid).toEqual([]);
        expect(result.toAdd).toEqual(['ulriklyngs.com']);
    });

    test('www. does not smuggle a protected domain past the guard', () => {
        const result = processWebsiteInput('www.digitalhabits.org');
        expect(result.toAdd).toEqual([]);
        expect(result.hadProtected).toBe(true);
    });
});
