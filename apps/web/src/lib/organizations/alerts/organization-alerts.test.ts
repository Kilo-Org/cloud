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
    scope: { type: 'organization' },
    recipients: ['finance@example.com'],
  },
} satisfies OrganizationAlertDefinition;

const lowBalanceDefinition = {
  type: 'low_balance',
  configuration: {
    thresholdMicrodollars: 50_000_000,
    recipients: ['finance@example.com'],
  },
} satisfies OrganizationAlertDefinition;

describe('OrganizationAlertDefinitionSchema', () => {
  test('accepts a monthly spending alert', () => {
    expect(OrganizationAlertDefinitionSchema.parse(monthlySpendingDefinition)).toEqual(
      monthlySpendingDefinition
    );
  });

  test('accepts a low balance alert', () => {
    expect(OrganizationAlertDefinitionSchema.parse(lowBalanceDefinition)).toEqual(
      lowBalanceDefinition
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

  test('rejects a monthly spending configuration used with the low balance type', () => {
    expect(
      OrganizationAlertDefinitionSchema.safeParse({
        type: 'low_balance',
        configuration: monthlySpendingDefinition.configuration,
      }).success
    ).toBe(false);
  });

  test('accepts a group-scoped monthly spending alert', () => {
    const groupScoped = {
      ...monthlySpendingDefinition,
      configuration: {
        ...monthlySpendingDefinition.configuration,
        scope: { type: 'group' as const, groupId: '00000000-0000-4000-8000-000000000000' },
      },
    };
    expect(OrganizationAlertDefinitionSchema.parse(groupScoped)).toEqual(groupScoped);
  });

  test('rejects a group scope with a non-UUID groupId, and a missing scope', () => {
    expect(
      OrganizationAlertDefinitionSchema.safeParse({
        ...monthlySpendingDefinition,
        configuration: {
          ...monthlySpendingDefinition.configuration,
          scope: { type: 'group', groupId: 'not-a-uuid' },
        },
      }).success
    ).toBe(false);
    const { scope: _scope, ...withoutScope } = monthlySpendingDefinition.configuration;
    expect(
      OrganizationAlertDefinitionSchema.safeParse({
        ...monthlySpendingDefinition,
        configuration: withoutScope,
      }).success
    ).toBe(false);
  });
});
