import { describe, expect, test } from '@jest/globals';
import { MAX_ALERT_THRESHOLD_MICRODOLLARS } from '../alert-thresholds';
import {
  EnabledLowBalanceAlertConfigurationSchema,
  LowBalanceAlertConfigurationSchema,
} from './low-balance.schema';

const validConfiguration = {
  thresholdMicrodollars: 50_000_000,
  recipients: ['finance@example.com'],
};

describe('LowBalanceAlertConfigurationSchema', () => {
  test('accepts a persisted configuration and normalizes recipients', () => {
    expect(
      LowBalanceAlertConfigurationSchema.parse({
        ...validConfiguration,
        recipients: [' Finance@Example.com', 'finance@example.com', 'ops@example.com'],
      })
    ).toEqual({ ...validConfiguration, recipients: ['finance@example.com', 'ops@example.com'] });
  });

  test('has no period field, unlike monthly spending', () => {
    expect(
      LowBalanceAlertConfigurationSchema.safeParse({
        ...validConfiguration,
        period: { type: 'calendar_month_utc', version: 1 },
      }).success
    ).toBe(false);
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
      LowBalanceAlertConfigurationSchema.safeParse({
        ...validConfiguration,
        thresholdMicrodollars,
      }).success
    ).toBe(false);
  });

  test('rejects unknown configuration fields', () => {
    expect(
      LowBalanceAlertConfigurationSchema.safeParse({
        ...validConfiguration,
        percentageMilestones: [50],
      }).success
    ).toBe(false);
  });

  test('allows a disabled alert to have no recipients while an enabled one may not', () => {
    const withoutRecipients = { ...validConfiguration, recipients: [] };

    expect(LowBalanceAlertConfigurationSchema.parse(withoutRecipients)).toEqual(withoutRecipients);
    expect(EnabledLowBalanceAlertConfigurationSchema.safeParse(withoutRecipients).success).toBe(
      false
    );
    expect(EnabledLowBalanceAlertConfigurationSchema.parse(validConfiguration)).toEqual(
      validConfiguration
    );
  });
});
