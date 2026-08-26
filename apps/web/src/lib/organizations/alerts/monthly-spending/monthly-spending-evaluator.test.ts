import { beforeEach, describe, expect, it } from '@jest/globals';
import {
  microdollar_usage,
  organization_alert_deliveries,
  organization_alerts,
  organizations,
  type OrganizationAlertConfiguration,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { createOrganization } from '@/lib/organizations/organizations';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { CALENDAR_MONTH_UTC_V1, resolveOrganizationAlertPeriodOccurrence } from '../alert-periods';

jest.mock('@/lib/email', () => ({
  sendMonthlySpendingAlertEmail: jest.fn(),
}));

import { sendMonthlySpendingAlertEmail } from '@/lib/email';
import { alertRecipientIdentityHmac, claimAlertDeliveries } from '../alert-deliveries';
import { evaluateMonthlySpendingAlerts } from './monthly-spending-evaluator';

const mockedSend = jest.mocked(sendMonthlySpendingAlertEmail);

const THRESHOLD = 1_000_000;

async function createTestOrganizationWithPlan(plan: 'enterprise' | 'teams'): Promise<string> {
  const owner = await insertTestUser();
  const organization = await createOrganization(`alerts-${plan}-${owner.id}`, owner.id);
  await db.update(organizations).set({ plan }).where(eq(organizations.id, organization.id));
  return organization.id;
}

const createEnterpriseOrganization = () => createTestOrganizationWithPlan('enterprise');

async function createAlert(
  organizationId: string,
  overrides: Partial<OrganizationAlertConfiguration> = {},
  status: 'enabled' | 'disabled' = 'enabled'
): Promise<string> {
  const [alert] = await db
    .insert(organization_alerts)
    .values({
      organization_id: organizationId,
      type: 'monthly_spending',
      status,
      configuration: {
        thresholdMicrodollars: THRESHOLD,
        period: CALENDAR_MONTH_UTC_V1,
        recipients: ['finance@example.com'],
        ...overrides,
      },
    })
    .returning();
  return alert.id;
}

/** Usage inside the alert's current UTC month, which is what evaluation measures. */
async function recordSpend(organizationId: string, cost: number): Promise<void> {
  await db.insert(microdollar_usage).values({
    kilo_user_id: `alert-usage-${organizationId}`,
    organization_id: organizationId,
    cost,
    input_tokens: 0,
    output_tokens: 0,
    cache_write_tokens: 0,
    cache_hit_tokens: 0,
  });
}

function deliveries(alertId: string) {
  return db
    .select()
    .from(organization_alert_deliveries)
    .where(eq(organization_alert_deliveries.alert_id, alertId));
}

/**
 * A sweep is global, so other tests' organizations are evaluated by the same run.
 * Provider calls are counted per organization to keep assertions independent of
 * test order and of rows left behind in the shared database.
 */
function sendCallCount(organizationId: string): number {
  return mockedSend.mock.calls.filter(([props]) => props.organizationId === organizationId).length;
}

describe('monthly spending alert evaluation', () => {
  beforeEach(() => {
    mockedSend.mockReset();
    mockedSend.mockResolvedValue({ sent: true });
  });

  it('sends once per recipient and period no matter how often it runs', async () => {
    const organizationId = await createEnterpriseOrganization();
    const alertId = await createAlert(organizationId);
    await recordSpend(organizationId, THRESHOLD);

    await evaluateMonthlySpendingAlerts();
    await evaluateMonthlySpendingAlerts();

    const rows = await deliveries(alertId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('accepted');
    expect(rows[0].period_occurrence_id).toBe(
      resolveOrganizationAlertPeriodOccurrence(CALENDAR_MONTH_UTC_V1, new Date()).occurrenceId
    );
    expect(sendCallCount(organizationId)).toBe(1);
  });

  it('stores a keyed recipient digest instead of the address', async () => {
    const organizationId = await createEnterpriseOrganization();
    const alertId = await createAlert(organizationId);
    await recordSpend(organizationId, THRESHOLD);
    await evaluateMonthlySpendingAlerts();

    const [delivery] = await deliveries(alertId);
    expect(delivery.recipient_identity_hmac).toBe(
      alertRecipientIdentityHmac('finance@example.com')
    );
    expect(JSON.stringify(delivery)).not.toContain('finance@example.com');
  });

  it('treats exact threshold as crossed and lower spend as not crossed', async () => {
    const crossing = await createEnterpriseOrganization();
    const belowAlert = await createAlert(await createEnterpriseOrganization());
    const crossingAlert = await createAlert(crossing);
    await recordSpend(crossing, THRESHOLD);

    await evaluateMonthlySpendingAlerts();

    expect(await deliveries(crossingAlert)).toHaveLength(1);
    expect(await deliveries(belowAlert)).toHaveLength(0);
  });

  it('evaluates every alert of one organization independently', async () => {
    const organizationId = await createEnterpriseOrganization();
    const reached = await createAlert(organizationId);
    const sameThreshold = await createAlert(organizationId, {
      recipients: ['ops@example.com'],
    });
    const higher = await createAlert(organizationId, {
      thresholdMicrodollars: THRESHOLD * 10,
    });
    await recordSpend(organizationId, THRESHOLD);

    await evaluateMonthlySpendingAlerts();

    expect(await deliveries(reached)).toHaveLength(1);
    expect(await deliveries(sameThreshold)).toHaveLength(1);
    expect(await deliveries(higher)).toHaveLength(0);
  });

  it('ignores alerts that are not enabled for a live Enterprise organization', async () => {
    const disabledAlertOrg = await createEnterpriseOrganization();
    const disabledAlert = await createAlert(disabledAlertOrg, {}, 'disabled');
    const teamsOrg = await createTestOrganizationWithPlan('teams');
    const teamsAlert = await createAlert(teamsOrg);
    const deletedOrg = await createEnterpriseOrganization();
    const deletedOrgAlert = await createAlert(deletedOrg);
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, deletedOrg));
    await Promise.all([
      recordSpend(disabledAlertOrg, THRESHOLD),
      recordSpend(teamsOrg, THRESHOLD),
      recordSpend(deletedOrg, THRESHOLD),
    ]);

    await evaluateMonthlySpendingAlerts();

    expect(await deliveries(disabledAlert)).toHaveLength(0);
    expect(await deliveries(teamsAlert)).toHaveLength(0);
    expect(await deliveries(deletedOrgAlert)).toHaveLength(0);
    for (const id of [disabledAlertOrg, teamsOrg, deletedOrg]) {
      expect(sendCallCount(id)).toBe(0);
    }
  });

  it('cancels a claim instead of sending when the alert stops being eligible', async () => {
    const organizationId = await createEnterpriseOrganization();
    const alertId = await createAlert(organizationId);
    await recordSpend(organizationId, THRESHOLD);
    // A first sweep claims and sends. Returning the claim to `pending` and then
    // disabling the alert stands in for work claimed before a disable landed.
    await evaluateMonthlySpendingAlerts();
    expect(await deliveries(alertId)).toHaveLength(1);
    await db
      .update(organization_alert_deliveries)
      .set({ status: 'pending', lease_expires_at: null })
      .where(eq(organization_alert_deliveries.alert_id, alertId));
    await db
      .update(organization_alerts)
      .set({ status: 'disabled' })
      .where(eq(organization_alerts.id, alertId));
    mockedSend.mockImplementation(async () => {
      throw new Error('dispatch must not reach the provider');
    });

    await evaluateMonthlySpendingAlerts();

    const [delivery] = await deliveries(alertId);
    expect(delivery.status).toBe('canceled');
  });

  it('records an ambiguous provider outcome and never retries it', async () => {
    const organizationId = await createEnterpriseOrganization();
    const alertId = await createAlert(organizationId);
    await recordSpend(organizationId, THRESHOLD);
    mockedSend.mockRejectedValue(new Error('socket hang up'));

    await evaluateMonthlySpendingAlerts();

    mockedSend.mockResolvedValue({ sent: true });
    await evaluateMonthlySpendingAlerts();

    const [delivery] = await deliveries(alertId);
    expect(delivery.status).toBe('ambiguous');
    expect(delivery.attempt_count).toBe(1);
  });

  it('keeps a definitive pre-submission failure retryable', async () => {
    const organizationId = await createEnterpriseOrganization();
    const alertId = await createAlert(organizationId);
    await recordSpend(organizationId, THRESHOLD);
    mockedSend.mockResolvedValue({ sent: false, reason: 'neverbounce_rejected' });

    await evaluateMonthlySpendingAlerts();

    const [delivery] = await deliveries(alertId);
    expect(delivery.status).toBe('pending');
    expect(delivery.last_error_code).toBe('neverbounce_rejected');
  });

  it('skips an alert whose stored configuration is unsupported', async () => {
    const organizationId = await createEnterpriseOrganization();
    const alertId = await createAlert(organizationId);
    await recordSpend(organizationId, THRESHOLD);
    await db
      .update(organization_alerts)
      .set({
        configuration: unsupportedConfiguration(),
      })
      .where(eq(organization_alerts.id, alertId));

    const summary = await evaluateMonthlySpendingAlerts();

    expect(summary.invalidAlertCount).toBeGreaterThanOrEqual(1);
    expect(await deliveries(alertId)).toHaveLength(0);
  });

  it('admits at most ten recipients for one alert and period', async () => {
    const organizationId = await createEnterpriseOrganization();
    const alertId = await createAlert(organizationId, {
      recipients: Array.from({ length: 10 }, (_, index) => `person${index}@example.com`),
    });
    await recordSpend(organizationId, THRESHOLD);
    await evaluateMonthlySpendingAlerts();

    // Replacing every address cannot admit an eleventh recipient this period.
    await db
      .update(organization_alerts)
      .set({
        configuration: {
          thresholdMicrodollars: THRESHOLD,
          period: CALENDAR_MONTH_UTC_V1,
          recipients: ['late@example.com'],
        },
      })
      .where(eq(organization_alerts.id, alertId));

    await evaluateMonthlySpendingAlerts();

    const rows = await deliveries(alertId);
    expect(rows).toHaveLength(10);
    expect(
      rows.some(
        row => row.recipient_identity_hmac === alertRecipientIdentityHmac('late@example.com')
      )
    ).toBe(false);
  });

  it('claims each recipient once when evaluators overlap', async () => {
    const organizationId = await createEnterpriseOrganization();
    const alertId = await createAlert(organizationId, {
      recipients: ['first@example.com', 'second@example.com'],
    });
    const occurrence = resolveOrganizationAlertPeriodOccurrence(CALENDAR_MONTH_UTC_V1, new Date());
    const claim = () =>
      claimAlertDeliveries({
        alertId,
        occurrence,
        recipients: ['first@example.com', 'second@example.com'],
        configurationVersion: 1,
        thresholdMicrodollars: THRESHOLD,
        measuredSpendMicrodollars: THRESHOLD,
      });

    // No lock serializes this: delivery identity uniqueness is what keeps a
    // concurrent evaluator from claiming the same recipient a second time.
    const [left, right] = await Promise.all([claim(), claim()]);

    expect(left.length + right.length).toBe(2);
    const rows = await deliveries(alertId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.recipient_identity_hmac)).size).toBe(2);
  });

  it('does not count another organization spend toward an alert', async () => {
    const organizationId = await createEnterpriseOrganization();
    const otherOrganizationId = await createEnterpriseOrganization();
    const alertId = await createAlert(organizationId);
    await recordSpend(otherOrganizationId, THRESHOLD * 5);

    await evaluateMonthlySpendingAlerts();

    expect(await deliveries(alertId)).toHaveLength(0);
  });

  it('does not measure spend from an earlier period', async () => {
    const organizationId = await createEnterpriseOrganization();
    const alertId = await createAlert(organizationId);
    const previousMonth = resolveOrganizationAlertPeriodOccurrence(
      CALENDAR_MONTH_UTC_V1,
      new Date()
    ).startInclusive;
    await db.insert(microdollar_usage).values({
      kilo_user_id: `alert-usage-${organizationId}`,
      organization_id: organizationId,
      cost: THRESHOLD * 5,
      input_tokens: 0,
      output_tokens: 0,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      created_at: new Date(previousMonth.getTime() - 1).toISOString(),
    });

    await evaluateMonthlySpendingAlerts();

    expect(await deliveries(alertId)).toHaveLength(0);
  });
});

/** A period version this build does not support, to prove it is skipped. */
function unsupportedConfiguration(): OrganizationAlertConfiguration {
  return {
    thresholdMicrodollars: THRESHOLD,
    period: { type: 'calendar_month_utc', version: 2 },
    recipients: ['finance@example.com'],
  } as unknown as OrganizationAlertConfiguration;
}
