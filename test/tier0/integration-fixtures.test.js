import { expect, test } from 'vitest';
import '../../src/integration-tests.js';
const { activeIntegrationSchedule, futureIntegrationSchedule } = window.__REDDBLOCK_INTEGRATION_FIXTURES__;
test.each([9, 23])('active pause/read-back fixture at hour %s stays recurring across the midnight boundary', hour => {
    const now = new Date(2026, 10, 1, hour, 30);
    const fixture = activeIntegrationSchedule(now);
    expect(fixture.repeatType).toBe('forever');
    expect(fixture.segments[0]).toEqual({ startHour: hour, startMinute: 0, endHour: (hour + 1) % 24, endMinute: 0, days: [6] });
});

test.each([30, 59])('future suppression fixture at23:%s survives midnight and uses its start day', minute => {
    const now = new Date(2026, 10, 1, 23, minute);
    const fixture = futureIntegrationSchedule(now);
    expect(fixture.repeatType).toBe('forever');
    expect(fixture.segments[0].days).toEqual([minute === 59 ? 0 : 6]);
});
