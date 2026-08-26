import { describe, expect, test } from '@jest/globals';
import {
  CALENDAR_MONTH_UTC_V1,
  type OrganizationAlertDefinition,
  OrganizationAlertDefinitionSchema,
} from './organization-alerts';

const monthlySpendingDefinition = {
  type: 'monthly_spending',
  configuration: {
    thresholdMicrodollars: 500_000_000,
    period: CALENDAR_MONTH_UTC_V1,
    recipients: ['finance@example.com'],
  },
} satisfies OrganizationAlertDefinition;

describe('OrganizationAlertDefinitionSchema', () => {
  test('accepts a monthly spending alert', () => {
    expect(OrganizationAlertDefinitionSchema.parse(monthlySpendingDefinition)).toEqual(
      monthlySpendingDefinition
    );
  });

  test('rejects an unknown alert type', () => {
    expect(
      OrganizationAlertDefinitionSchema.safeParse({
        ...monthlySpendingDefinition,
        type: 'daily_spending',
      }).success
    ).toBe(false);
  });

  test('rejects a configuration that does not belong to the type', () => {
    expect(
      OrganizationAlertDefinitionSchema.safeParse({
        type: 'monthly_spending',
        configuration: { thresholdMicrodollars: 500_000_000 },
      }).success
    ).toBe(false);
  });
});
