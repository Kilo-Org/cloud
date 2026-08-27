import { describe, expect, test } from '@jest/globals';
import { formatAlertUsd } from '@/lib/organizations/alerts/organization-alerts';
import { CALENDAR_MONTH_UTC_V1 } from '@/lib/organizations/alerts/organization-alerts';
import { organizationAlertSummary, type OrganizationAlertRow } from './alert-presentation';

function alertRow(overrides: {
  thresholdMicrodollars?: number;
  recipients?: string[];
  scope?: { type: 'organization' } | { type: 'group'; groupId: string };
  groupName?: string | null;
}): OrganizationAlertRow {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    organizationId: 'org_1',
    type: 'monthly_spending',
    status: 'enabled',
    configuration: {
      thresholdMicrodollars: overrides.thresholdMicrodollars ?? 500_000_000,
      period: CALENDAR_MONTH_UTC_V1,
      scope: overrides.scope ?? { type: 'organization' },
      recipients: overrides.recipients ?? ['billing@example.com'],
    },
    configurationVersion: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    archivedAt: null,
    periodOccurrenceId: 'calendar_month_utc:v1:2026-08',
    admittedRecipientCount: 0,
    groupName: overrides.groupName ?? null,
  };
}

describe('organizationAlertSummary', () => {
  // The threshold is composed through the shared currency formatter rather than
  // asserted as a literal, which would depend on the runtime locale.
  test('states the threshold, the period window, and the recipient count', () => {
    expect(
      organizationAlertSummary(
        alertRow({
          thresholdMicrodollars: 1_234_560_000,
          recipients: ['finance@example.com', 'ops@example.com'],
        })
      )
    ).toBe(
      `Reaches ${formatAlertUsd(1_234_560_000)} of AI usage spend in a UTC calendar month for the whole organization · 2 recipients`
    );
  });

  test('counts one recipient in the singular and none at all explicitly', () => {
    expect(organizationAlertSummary(alertRow({}))).toMatch(/· 1 recipient$/);
    expect(organizationAlertSummary(alertRow({ recipients: [] }))).toMatch(/· No recipients$/);
  });

  test('describes a low balance alert by its threshold and recipient count', () => {
    const row: OrganizationAlertRow = {
      ...alertRow({ thresholdMicrodollars: 50_000_000, recipients: ['finance@example.com'] }),
      type: 'low_balance',
      configuration: {
        thresholdMicrodollars: 50_000_000,
        recipients: ['finance@example.com'],
      },
    };
    expect(organizationAlertSummary(row)).toBe(
      `Drops below ${formatAlertUsd(50_000_000)} of AI usage balance · 1 recipient`
    );
  });

  test('describes a group-scoped alert by the group name, or as deleted when it has none', () => {
    const groupId = '00000000-0000-4000-8000-000000000001';
    expect(
      organizationAlertSummary(
        alertRow({ scope: { type: 'group', groupId }, groupName: 'Engineering' })
      )
    ).toContain('for the "Engineering" group');
    expect(
      organizationAlertSummary(alertRow({ scope: { type: 'group', groupId }, groupName: null }))
    ).toContain('for a deleted group');
    expect(organizationAlertSummary(alertRow({}))).toContain('for the whole organization');
  });
});
