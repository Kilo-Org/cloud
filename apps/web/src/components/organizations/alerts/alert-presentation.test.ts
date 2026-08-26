import { describe, expect, test } from '@jest/globals';
import { formatAlertUsd } from '@/lib/organizations/alerts/organization-alerts';
import { CALENDAR_MONTH_UTC_V1 } from '@/lib/organizations/alerts/organization-alerts';
import { organizationAlertSummary, type OrganizationAlertRow } from './alert-presentation';

function alertRow(overrides: {
  thresholdMicrodollars?: number;
  recipients?: string[];
}): OrganizationAlertRow {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    organizationId: 'org_1',
    type: 'monthly_spending',
    status: 'enabled',
    configuration: {
      thresholdMicrodollars: overrides.thresholdMicrodollars ?? 500_000_000,
      period: CALENDAR_MONTH_UTC_V1,
      recipients: overrides.recipients ?? ['billing@example.com'],
    },
    configurationVersion: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    archivedAt: null,
    periodOccurrenceId: 'calendar_month_utc:v1:2026-08',
    admittedRecipientCount: 0,
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
      `Reaches ${formatAlertUsd(1_234_560_000)} of AI usage spend in a UTC calendar month · 2 recipients`
    );
  });

  test('counts one recipient in the singular and none at all explicitly', () => {
    expect(organizationAlertSummary(alertRow({}))).toMatch(/· 1 recipient$/);
    expect(organizationAlertSummary(alertRow({ recipients: [] }))).toMatch(/· No recipients$/);
  });
});
