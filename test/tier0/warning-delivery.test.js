import { describe, it, expect } from 'vitest';
import { createWarningDelivery } from '../../src/warning-delivery.js';

describe('authoritative warning delivery', () => {
    it('does not resurrect a released PID when its old show event is replayed', async () => {
        let pending = [{ pid: 42 }];
        const applied = [];
        const delivery = createWarningDelivery(async () => pending, (rows) => applied.push(rows));
        await delivery.refresh();
        pending = [];
        delivery.invalidate();
        await delivery.refresh();
        expect(applied).toEqual([[{ pid: 42 }], []]);
    });
    it.each(['hide', 'ack'])('discards a snapshot arriving after %s', async () => {
        let resolve;
        const applied = [];
        const delivery = createWarningDelivery(() => new Promise((r) => { resolve = r; }), (rows) => applied.push(rows));
        const request = delivery.refresh();
        delivery.invalidate();
        resolve([{ pid: 42 }]);
        expect(await request).toBe(false);
        expect(applied).toEqual([]);
    });
    it('newest snapshot retains concurrent genuine warnings and supersedes an older response', async () => {
        const resolvers = [];
        const applied = [];
        const delivery = createWarningDelivery(() => new Promise((r) => resolvers.push(r)), (rows) => applied.push(rows));
        const older = delivery.refresh();
        const newer = delivery.refresh();
        resolvers[1]([{ pid: 1 }, { pid: 2 }]);
        await newer;
        resolvers[0]([{ pid: 1 }]);
        await older;
        expect(applied).toEqual([[{ pid: 1 }, { pid: 2 }]]);
    });
    it('does not fabricate a warning or clear existing UI when a read fails', async () => {
        const applied = [];
        const delivery = createWarningDelivery(async () => { throw new Error('read failed'); }, (rows) => applied.push(rows));
        await expect(delivery.refresh()).rejects.toThrow('read failed');
        expect(applied).toEqual([]);
    });
    it('recovers a genuine pending warning after a transient read error', async () => {
        let attempts = 0;
        const applied = [];
        const delivery = createWarningDelivery(async () => {
            if (++attempts < 3) throw new Error('temporary transport error');
            return [{ pid: 42 }];
        }, (rows) => applied.push(rows));
        await delivery.refresh();
        expect(attempts).toBe(3);
        expect(applied).toEqual([[{ pid: 42 }]]);
    });
});
