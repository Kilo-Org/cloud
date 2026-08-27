import { describe, expect, test } from '@jest/globals';
import { CALENDAR_MONTH_UTC_V1 } from '../alert-periods';
import {
  AlertThresholdUsdInputSchema,
  EnabledMonthlySpendingAlertConfigurationSchema,
  formatAlertThresholdUsdInput,
  MAX_ALERT_THRESHOLD_MICRODOLLARS,
  MonthlySpendingAlertConfigurationSchema,
  MonthlySpendingAlertScopeSchema,
} from './monthly-spending.schema';

const validConfiguration = {
  thresholdMicrodollars: 500_000_000,
  period: CALENDAR_MONTH_UTC_V1,
  scope: { type: 'organization' as const },
  recipients: ['finance@example.com'],
};

describe('MonthlySpendingAlertConfigurationSchema', () => {
  test('accepts a persisted configuration and normalizes recipients', () => {
    expect(
      MonthlySpendingAlertConfigurationSchema.parse({
        ...validConfiguration,
        recipients: [' Finance@Example.com', 'finance@example.com', 'ops@example.com'],
      })
    ).toEqual({ ...validConfiguration, recipients: ['finance@example.com', 'ops@example.com'] });
  });

  test('rejects an unsupported period version or type', () => {
    expect(
      MonthlySpendingAlertConfigurationSchema.safeParse({
        ...validConfiguration,
        period: { type: 'calendar_month_utc', version: 2 },
      }).success
    ).toBe(false);
    expect(
      MonthlySpendingAlertConfigurationSchema.safeParse({
        ...validConfiguration,
        period: { type: 'rolling_30_days', version: 1 },
      }).success
    ).toBe(false);
  });

  test('requires an explicit period', () => {
    const { period: _period, ...withoutPeriod } = validConfiguration;
    expect(MonthlySpendingAlertConfigurationSchema.safeParse(withoutPeriod).success).toBe(false);
  });

  test.each([
    0, // not positive
    -10_000,
    1.5, // not an integer
    1_234_567, // sub-cent precision the editor cannot express
    MAX_ALERT_THRESHOLD_MICRODOLLARS + 10_000, // above the product ceiling
    Number.MAX_SAFE_INTEGER,
  ])('rejects the threshold %p', thresholdMicrodollars => {
    expect(
      MonthlySpendingAlertConfigurationSchema.safeParse({
        ...validConfiguration,
        thresholdMicrodollars,
      }).success
    ).toBe(false);
  });

  test.each([10_000, 19_990_000, 500_000_000, MAX_ALERT_THRESHOLD_MICRODOLLARS])(
    'accepts the whole-cent threshold %p',
    thresholdMicrodollars => {
      expect(
        MonthlySpendingAlertConfigurationSchema.parse({
          ...validConfiguration,
          thresholdMicrodollars,
        }).thresholdMicrodollars
      ).toBe(thresholdMicrodollars);
    }
  );

  test('rejects unknown configuration fields', () => {
    expect(
      MonthlySpendingAlertConfigurationSchema.safeParse({
        ...validConfiguration,
        percentageMilestones: [50],
      }).success
    ).toBe(false);
  });

  test('requires an explicit scope', () => {
    const { scope: _scope, ...withoutScope } = validConfiguration;
    expect(MonthlySpendingAlertConfigurationSchema.safeParse(withoutScope).success).toBe(false);
  });

  test('accepts a group scope with a UUID groupId and rejects a malformed one', () => {
    const groupId = '00000000-0000-4000-8000-000000000000';
    expect(
      MonthlySpendingAlertConfigurationSchema.safeParse({
        ...validConfiguration,
        scope: { type: 'group', groupId },
      }).success
    ).toBe(true);
    expect(
      MonthlySpendingAlertConfigurationSchema.safeParse({
        ...validConfiguration,
        scope: { type: 'group', groupId: 'not-a-uuid' },
      }).success
    ).toBe(false);
  });

  test('allows a disabled alert to have no recipients while an enabled one may not', () => {
    const withoutRecipients = { ...validConfiguration, recipients: [] };

    expect(MonthlySpendingAlertConfigurationSchema.parse(withoutRecipients)).toEqual(
      withoutRecipients
    );
    expect(
      EnabledMonthlySpendingAlertConfigurationSchema.safeParse(withoutRecipients).success
    ).toBe(false);
    expect(EnabledMonthlySpendingAlertConfigurationSchema.parse(validConfiguration)).toEqual(
      validConfiguration
    );
  });
});

describe('AlertThresholdUsdInputSchema', () => {
  test.each([
    ['500', 500_000_000],
    ['500.00', 500_000_000],
    [' $1,234.56 ', 1_234_560_000],
    ['0.07', 70_000], // cents combined with integer arithmetic, not 0.07 * 1e6
    ['0.1', 100_000],
    ['19.99', 19_990_000],
  ])('converts %p to %p microdollars', (input, microdollars) => {
    expect(AlertThresholdUsdInputSchema.parse(input)).toBe(microdollars);
  });

  test.each([
    '',
    '   ',
    'abc',
    '5.005', // sub-cent precision
    '-5',
    '0',
    '0.00',
    '1e3',
    '1,00.00', // malformed grouping
    '1000000000.01', // above the product ceiling
    '99999999999999.99', // beyond the safe integer range once converted
  ])('rejects %p', input => {
    expect(AlertThresholdUsdInputSchema.safeParse(input).success).toBe(false);
  });

  test('reports an amount over the ceiling as being over the maximum', () => {
    const result = AlertThresholdUsdInputSchema.safeParse('2000000000.01');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/at most \$1,000,000,000/);
  });
});

describe('MonthlySpendingAlertScopeSchema', () => {
  test('accepts organization and group scopes', () => {
    expect(MonthlySpendingAlertScopeSchema.parse({ type: 'organization' })).toEqual({
      type: 'organization',
    });
    const groupId = '00000000-0000-4000-8000-000000000000';
    expect(MonthlySpendingAlertScopeSchema.parse({ type: 'group', groupId })).toEqual({
      type: 'group',
      groupId,
    });
  });

  test('rejects an organization scope carrying a groupId and an unknown type', () => {
    expect(
      MonthlySpendingAlertScopeSchema.safeParse({
        type: 'organization',
        groupId: '00000000-0000-4000-8000-000000000000',
      }).success
    ).toBe(false);
    expect(MonthlySpendingAlertScopeSchema.safeParse({ type: 'team' }).success).toBe(false);
  });
});

describe('formatAlertThresholdUsdInput', () => {
  test.each([500_000_000, 70_000, 100_000, 1_234_560_000, MAX_ALERT_THRESHOLD_MICRODOLLARS])(
    'round-trips %p through the input schema',
    microdollars => {
      const text = formatAlertThresholdUsdInput(microdollars);
      expect(text).toMatch(/^\d+\.\d{2}$/);
      expect(AlertThresholdUsdInputSchema.parse(text)).toBe(microdollars);
    }
  );
});
