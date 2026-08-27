import { describe, expect, test } from '@jest/globals';
import {
  CALENDAR_MONTH_UTC_V1,
  OrganizationAlertPeriodDefinitionSchema,
  resolveOrganizationAlertPeriodOccurrence,
} from './alert-periods';

function resolveAt(iso: string) {
  return resolveOrganizationAlertPeriodOccurrence(CALENDAR_MONTH_UTC_V1, new Date(iso));
}

describe('OrganizationAlertPeriodDefinitionSchema', () => {
  test('accepts calendar_month_utc v1', () => {
    expect(OrganizationAlertPeriodDefinitionSchema.parse(CALENDAR_MONTH_UTC_V1)).toEqual(
      CALENDAR_MONTH_UTC_V1
    );
  });

  test('rejects an unknown version, unknown type, or extra field', () => {
    expect(
      OrganizationAlertPeriodDefinitionSchema.safeParse({ type: 'calendar_month_utc', version: 2 })
        .success
    ).toBe(false);
    expect(
      OrganizationAlertPeriodDefinitionSchema.safeParse({ type: 'rolling_30_days', version: 1 })
        .success
    ).toBe(false);
    expect(OrganizationAlertPeriodDefinitionSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(
      OrganizationAlertPeriodDefinitionSchema.safeParse({
        type: 'calendar_month_utc',
        version: 1,
        timezone: 'UTC',
      }).success
    ).toBe(false);
  });
});

describe('resolveOrganizationAlertPeriodOccurrence', () => {
  test('resolves the containing UTC month as a half-open interval', () => {
    const occurrence = resolveAt('2026-08-17T13:45:12.345Z');

    expect(occurrence.occurrenceId).toBe('calendar_month_utc:v1:2026-08');
    expect(occurrence.startInclusive.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(occurrence.endExclusive.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(occurrence.definition).toEqual(CALENDAR_MONTH_UTC_V1);
  });

  test('includes the exact period start and excludes the next period start', () => {
    const atStart = resolveAt('2026-08-01T00:00:00.000Z');
    expect(atStart.occurrenceId).toBe('calendar_month_utc:v1:2026-08');
    expect(atStart.startInclusive.toISOString()).toBe('2026-08-01T00:00:00.000Z');

    const atLastMillisecond = resolveAt('2026-08-31T23:59:59.999Z');
    expect(atLastMillisecond.occurrenceId).toBe('calendar_month_utc:v1:2026-08');

    const atNextStart = resolveAt('2026-09-01T00:00:00.000Z');
    expect(atNextStart.occurrenceId).toBe('calendar_month_utc:v1:2026-09');
    expect(atNextStart.startInclusive.getTime()).toBe(atLastMillisecond.endExclusive.getTime());
  });

  test.each([
    ['2024-02-10T00:00:00.000Z', 'calendar_month_utc:v1:2024-02', '2024-03-01T00:00:00.000Z', 29],
    ['2026-02-10T00:00:00.000Z', 'calendar_month_utc:v1:2026-02', '2026-03-01T00:00:00.000Z', 28],
    ['2026-12-31T23:00:00.000Z', 'calendar_month_utc:v1:2026-12', '2027-01-01T00:00:00.000Z', 31],
  ])('handles month boundaries at %s', (at, occurrenceId, endExclusive, days) => {
    const occurrence = resolveAt(at);

    expect(occurrence.occurrenceId).toBe(occurrenceId);
    expect(occurrence.endExclusive.toISOString()).toBe(endExclusive);
    expect(
      (occurrence.endExclusive.getTime() - occurrence.startInclusive.getTime()) / 86_400_000
    ).toBe(days);
  });

  test('rejects an invalid evaluation date instead of resolving a NaN interval', () => {
    expect(() => resolveAt('not-a-date')).toThrow('invalid date');
  });
});
