import { describe, expect, it } from '@jest/globals';
import {
  organization_alert_deliveries,
  organization_alerts,
  organizations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { CALENDAR_MONTH_UTC_V1 } from './alert-periods';
import { alertRecipientIdentityHmac } from './alert-deliveries';
import {
  disableOrganizationAlertsForDowngrade,
  removeOrganizationAlertRecipients,
} from './alert-lifecycle';
import { createOrganization, markOrganizationAsDeleted } from '@/lib/organizations/organizations';
import { insertTestUser } from '@/tests/helpers/user.helper';

async function createEnterpriseOrganization(): Promise<string> {
  const owner = await insertTestUser();
  const organization = await createOrganization(`alerts-lifecycle-${owner.id}`, owner.id);
  await db
    .update(organizations)
    .set({ plan: 'enterprise' })
    .where(eq(organizations.id, organization.id));
  return organization.id;
}

async function createEnabledAlert(organizationId: string) {
  const [alert] = await db
    .insert(organization_alerts)
    .values({
      organization_id: organizationId,
      type: 'monthly_spending',
      status: 'enabled',
      configuration: {
        thresholdMicrodollars: 1_000_000,
        period: CALENDAR_MONTH_UTC_V1,
        scope: { type: 'organization' },
        recipients: ['finance@example.com'],
      },
    })
    .returning();
  return alert;
}

async function claimPendingDelivery(alertId: string) {
  await db.insert(organization_alert_deliveries).values({
    alert_id: alertId,
    period_occurrence_id: 'calendar_month_utc:v1:2026-08',
    recipient_identity_hmac: alertRecipientIdentityHmac('finance@example.com'),
    channel: 'email',
    claimed_configuration_version: 1,
    threshold_microdollars: 1_000_000,
    measured_value_microdollars: 1_000_000,
  });
}

const readAlert = async (alertId: string) =>
  (await db.select().from(organization_alerts).where(eq(organization_alerts.id, alertId)))[0];

const readDeliveries = async (alertId: string) =>
  await db
    .select()
    .from(organization_alert_deliveries)
    .where(eq(organization_alert_deliveries.alert_id, alertId));

describe('organization alert lifecycle', () => {
  it('disables alerts and cancels claimed work when an organization leaves Enterprise', async () => {
    const organizationId = await createEnterpriseOrganization();
    const alert = await createEnabledAlert(organizationId);
    await claimPendingDelivery(alert.id);

    await db.transaction(tx => disableOrganizationAlertsForDowngrade(tx, organizationId));

    const disabled = await readAlert(alert.id);
    expect(disabled.status).toBe('disabled');
    // Recipients are retained so a later upgrade does not lose the configuration.
    expect(disabled.configuration.recipients).toEqual(['finance@example.com']);
    expect(disabled.configuration_version).toBe(alert.configuration_version + 1);
    expect((await readDeliveries(alert.id))[0].status).toBe('canceled');
  });

  it('does not re-enable a disabled alert on a later upgrade', async () => {
    const organizationId = await createEnterpriseOrganization();
    const alert = await createEnabledAlert(organizationId);
    await db.transaction(tx => disableOrganizationAlertsForDowngrade(tx, organizationId));

    await db.transaction(tx => disableOrganizationAlertsForDowngrade(tx, organizationId));

    expect((await readAlert(alert.id)).status).toBe('disabled');
  });

  it('removes recipient addresses when an organization is deleted', async () => {
    const organizationId = await createEnterpriseOrganization();
    const alert = await createEnabledAlert(organizationId);
    await claimPendingDelivery(alert.id);

    await markOrganizationAsDeleted(organizationId);

    const scrubbed = await readAlert(alert.id);
    expect(scrubbed.configuration.recipients).toEqual([]);
    expect(scrubbed.status).toBe('disabled');
    expect((await readDeliveries(alert.id))[0].status).toBe('canceled');
  });

  it('scrubs an archived alert without reviving it when recipients are removed', async () => {
    const organizationId = await createEnterpriseOrganization();
    const alert = await createEnabledAlert(organizationId);
    await db
      .update(organization_alerts)
      .set({ status: 'archived', archived_at: new Date().toISOString() })
      .where(eq(organization_alerts.id, alert.id));

    await db.transaction(tx => removeOrganizationAlertRecipients(tx, organizationId));

    const scrubbed = await readAlert(alert.id);
    expect(scrubbed.status).toBe('archived');
    expect(scrubbed.configuration.recipients).toEqual([]);
  });
});
