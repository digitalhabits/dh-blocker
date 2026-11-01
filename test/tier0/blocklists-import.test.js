import { expect, test } from 'vitest';
import { parseBlocklistsImportPayload } from '../../src/blocklists.js';

test('blocklist import refuses a file over 5 MB before parsing it', () => {
    expect(() => parseBlocklistsImportPayload(' '.repeat(5_000_001))).toThrow(/too large/);
    expect(() => parseBlocklistsImportPayload('[]')).not.toThrow();
});
