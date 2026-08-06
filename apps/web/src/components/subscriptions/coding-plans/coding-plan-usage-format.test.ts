import {
  formatCodingPlanQuotaPeriod,
  formatCodingPlanRemainingPercent,
  getCodingPlanQuotaDepletion,
  isCodingPlanQuotaLow,
} from './coding-plan-usage-format';

describe('Coding Plan usage formatting', () => {
  it.each([
    [{ value: 5, unit: 'hour' as const }, '5-hour window'],
    [{ value: 1, unit: 'week' as const }, '1-week window'],
    [{ value: 30, unit: 'day' as const }, '30-day window'],
    [{ value: 2, unit: 'month' as const }, '2-month window'],
  ])('derives window labels from period metadata', (period, expected) => {
    expect(formatCodingPlanQuotaPeriod(period)).toBe(expected);
  });

  it.each([
    [0, '0%'],
    [75, '75%'],
    [100, '100%'],
    [150, '150%'],
  ])('formats %s%% remaining', (remaining, expected) => {
    expect(formatCodingPlanRemainingPercent(remaining)).toBe(expected);
  });

  it.each([
    [0, 100],
    [75, 25],
    [100, 0],
    [150, 0],
  ])('maps %s%% remaining to %s%% depletion', (remaining, expected) => {
    expect(getCodingPlanQuotaDepletion(remaining)).toBe(expected);
  });

  it.each([
    [0, true],
    [10, true],
    [11, false],
    [100, false],
  ])('flags %s%% remaining as low quota: %s', (remaining, expected) => {
    expect(isCodingPlanQuotaLow(remaining)).toBe(expected);
  });
});
