import { describe, expect, it } from 'vitest';

import {
  briefingPeriodError,
  briefingWallTimeToInstant,
  resolveBriefingPeriod,
} from './agent-briefing-period';

const custom = { startAt: '2026-01-01T00:00:00.000Z', endAt: '2026-01-02T00:00:00.000Z' };

describe('one-off briefing period', () => {
  it('resolves rolling presets at review time without rounding away exact instants', () => {
    const now = Date.parse('2026-10-20T12:34:56.789Z');
    expect(
      resolveBriefingPeriod({ preset: 'last24Hours', timezone: 'Pacific/Auckland', custom, now })
    ).toEqual({
      startAt: '2026-10-19T12:34:56.789Z',
      endAt: '2026-10-20T12:34:56.789Z',
    });
    expect(
      resolveBriefingPeriod({ preset: 'last7Days', timezone: 'Pacific/Auckland', custom, now })
        ?.startAt
    ).toBe('2026-10-13T12:34:56.789Z');
  });

  it('uses the explicit preference timezone for today instead of device calendar dates', () => {
    const now = Date.parse('2026-10-20T02:00:00.000Z');
    expect(
      resolveBriefingPeriod({ preset: 'today', timezone: 'America/Los_Angeles', custom, now })
    ).toEqual({
      startAt: '2026-10-19T07:00:00.000Z',
      endAt: '2026-10-20T02:00:00.000Z',
    });
  });

  it('starts a calendar day at its first valid time when daylight saving skips midnight', () => {
    expect(
      resolveBriefingPeriod({
        preset: 'today',
        timezone: 'America/Santiago',
        custom,
        now: Date.parse('2026-09-06T15:00:00Z'),
      })
    ).toEqual({
      startAt: '2026-09-06T04:00:00.000Z',
      endAt: '2026-09-06T15:00:00.000Z',
    });
  });

  it('resolves yesterday across a short DST day as a local calendar day', () => {
    const period = resolveBriefingPeriod({
      preset: 'yesterday',
      timezone: 'America/New_York',
      custom,
      now: Date.parse('2026-03-09T14:00:00Z'),
    });
    expect(period).toEqual({
      startAt: '2026-03-08T05:00:00.000Z',
      endAt: '2026-03-09T04:00:00.000Z',
    });
  });

  it('resolves yesterday across a long DST day as a local calendar day', () => {
    expect(
      resolveBriefingPeriod({
        preset: 'yesterday',
        timezone: 'America/New_York',
        custom,
        now: Date.parse('2026-11-02T14:00:00Z'),
      })
    ).toEqual({
      startAt: '2026-11-01T04:00:00.000Z',
      endAt: '2026-11-02T05:00:00.000Z',
    });
  });

  it('rejects nonexistent local times and deterministically uses the earlier repeated time', () => {
    expect(
      briefingWallTimeToInstant(
        { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
        'America/New_York'
      )
    ).toBeNull();
    expect(
      briefingWallTimeToInstant(
        { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
        'America/New_York'
      )
    ).toBe(Date.parse('2026-11-01T05:30:00Z'));
  });

  it('allows old custom evidence periods and exactly 31 elapsed days, but rejects larger, future and backward ranges', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    const max = { startAt: '2020-01-01T00:00:00Z', endAt: '2020-02-01T00:00:00Z' };
    expect(briefingPeriodError(max, now)).toBeNull();
    expect(resolveBriefingPeriod({ preset: 'custom', timezone: 'UTC', custom: max, now })).toBe(
      max
    );
    expect(briefingPeriodError({ ...max, endAt: '2020-02-01T00:00:00.001Z' }, now)).toBe(
      'agentBriefing.periodTooLong'
    );
    expect(briefingPeriodError({ startAt: max.endAt, endAt: max.startAt }, now)).toBe(
      'agentBriefing.invalidPeriod'
    );
    expect(briefingPeriodError({ startAt: max.startAt, endAt: 'invalid' }, now)).toBe(
      'agentBriefing.invalidPeriod'
    );
    expect(
      briefingPeriodError(
        { startAt: '2026-10-20T11:00:00Z', endAt: '2026-10-20T12:00:00.001Z' },
        now
      )
    ).toBe('agentBriefing.futurePeriod');
  });
});
