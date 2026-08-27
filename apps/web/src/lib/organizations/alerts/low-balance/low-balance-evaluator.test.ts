import { beforeEach, describe, expect, it } from '@jest/globals';
import {
  organization_alert_deliveries,
  organization_alerts,
  organizations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { createOrganization } from '@/lib/organizations/organizations';
import { insertTestUser } from '@/tests/helpers/user.helper';

jest.mock('@/lib/email', () => ({
  sendLowBalanceAlertEmail: jest.fn(),
}));

import { sendLowBalanceAlertEmail } from '@/lib/email';
import { alertRecipientIdentityHmac } from '../alert-deliveries';
import { evaluateLowBalanceAlerts } from './low-balance-evaluator';

const mockedSend = jest.mocked(sendLowBalanceAlertEmail);

const THRESHOLD = 1_000_000;

async function createEnterpriseOrganization(): Promise<string> {
  const owner = await insertTestUser();
  const organization = await createOrganization(`low-balance-${owner.id}`, owner.id);
  await db
    .update(organizations)
    .set({ plan: 'enterprise' })
    .where(eq(organizations.id, organization.id));
  return organization.id;
}

/**
 * The evaluator's crossing check is derived from the two balances passed in,
 * but dispatch re-validates against the organization's actual stored balance,
 * so tests set both consistently.
 */
async function setStoredBalance(
  organizationId: string,
  balanceMicrodollars: number
): Promise<void> {
  await db
    .update(organizations)
    .set({ total_microdollars_acquired: balanceMicrodollars, microdollars_used: 0 })
    .where(eq(organizations.id, organizationId));
}

async function createAlert(
  organizationId: string,
  overrides: { thresholdMicrodollars?: number; recipients?: string[] } = {},
  status: 'enabled' | 'disabled' = 'enabled'
): Promise<string> {
  const [alert] = await db
    .insert(organization_alerts)
    .values({
      organization_id: organizationId,
      type: 'low_balance',
      status,
      configuration: {
        thresholdMicrodollars: overrides.thresholdMicrodollars ?? THRESHOLD,
        recipients: overrides.recipients ?? ['finance@example.com'],
      },
    })
    .returning();
  return alert.id;
}

function deliveries(alertId: string) {
  return db
    .select()
    .from(organization_alert_deliveries)
    .where(eq(organization_alert_deliveries.alert_id, alertId));
}

describe('low balance alert evaluation', () => {
  beforeEach(() => {
    mockedSend.mockReset();
    mockedSend.mockResolvedValue({ sent: true });
  });

  it('claims and sends when a mutation crosses the threshold', async () => {
    const organizationId = await createEnterpriseOrganization();
    const alertId = await createAlert(organizationId);
    await setStoredBalance(organizationId, THRESHOLD - 1);

    await evaluateLowBalanceAlerts({
      organizationId,
      previousBalanceMicrodollars: THRESHOLD + 1,
      newBalanceMicrodollars: THRESHOLD - 1,
    });

    const rows = await deliveries(alertId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('accepted');
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it('does not claim when the balance does not cross the threshold', async () => {
    const organizationId = await createEnterpriseOrganization();
    const alertId = await createAlert(organizationId);
    await setStoredBalance(organizationId, THRESHOLD + 10);

    await evaluateLowBalanceAlerts({
      organizationId,
      previousBalanceMicrodollars: THRESHOLD + 20,
      newBalanceMicrodollars: THRESHOLD + 10,
    });

    expect(await deliveries(alertId)).toHaveLength(0);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('does not re-fire on a second debit that stays below the threshold', async () => {
    const organizationId = await createEnterpriseOrganization();
    const alertId = await createAlert(organizationId);
    await setStoredBalance(organizationId, THRESHOLD - 1);

    // First debit crosses the threshold.
    await evaluateLowBalanceAlerts({
      organizationId,
      previousBalanceMicrodollars: THRESHOLD + 1,
      newBalanceMicrodollars: THRESHOLD - 1,
    });
    // A second debit is already below the threshold beforehand, so it is not a
    // new crossing.
    await setStoredBalance(organizationId, THRESHOLD - 2);
    await evaluateLowBalanceAlerts({
      organizationId,
      previousBalanceMicrodollars: THRESHOLD - 1,
      newBalanceMicrodollars: THRESHOLD - 2,
    });

    expect(await deliveries(alertId)).toHaveLength(1);
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it('fires again after the balance recovers and drops below the threshold a second time', async () => {
    const organizationId = await createEnterpriseOrganization();
    const alertId = await createAlert(organizationId);
    await setStoredBalance(organizationId, THRESHOLD - 1);

    await evaluateLowBalanceAlerts({
      organizationId,
      previousBalanceMicrodollars: THRESHOLD + 1,
      newBalanceMicrodollars: THRESHOLD - 1,
    });

    // A top-up brings the balance back to or above the threshold, then a later
    // debit crosses it again: a new, later crossing.
    await setStoredBalance(organizationId, THRESHOLD - 1);
    await evaluateLowBalanceAlerts({
      organizationId,
      previousBalanceMicrodollars: THRESHOLD + 100,
      newBalanceMicrodollars: THRESHOLD - 1,
    });

    expect(await deliveries(alertId)).toHaveLength(2);
    expect(mockedSend).toHaveBeenCalledTimes(2);
  });

  it('ignores a disabled alert', async () => {
    const organizationId = await createEnterpriseOrganization();
    const alertId = await createAlert(organizationId, {}, 'disabled');
    await setStoredBalance(organizationId, THRESHOLD - 1);

    await evaluateLowBalanceAlerts({
      organizationId,
      previousBalanceMicrodollars: THRESHOLD + 1,
      newBalanceMicrodollars: THRESHOLD - 1,
    });

    expect(await deliveries(alertId)).toHaveLength(0);
  });

  it('evaluates every alert of the organization independently', async () => {
    const organizationId = await createEnterpriseOrganization();
    const crossed = await createAlert(organizationId, { thresholdMicrodollars: THRESHOLD });
    const notCrossed = await createAlert(organizationId, { thresholdMicrodollars: THRESHOLD / 10 });
    await setStoredBalance(organizationId, THRESHOLD - 1);

    await evaluateLowBalanceAlerts({
      organizationId,
      previousBalanceMicrodollars: THRESHOLD + 1,
      newBalanceMicrodollars: THRESHOLD - 1,
    });

    expect(await deliveries(crossed)).toHaveLength(1);
    expect(await deliveries(notCrossed)).toHaveLength(0);
  });

  it('stores a keyed recipient digest instead of the address', async () => {
    const organizationId = await createEnterpriseOrganization();
    const alertId = await createAlert(organizationId);
    await setStoredBalance(organizationId, THRESHOLD - 1);

    await evaluateLowBalanceAlerts({
      organizationId,
      previousBalanceMicrodollars: THRESHOLD + 1,
      newBalanceMicrodollars: THRESHOLD - 1,
    });

    const [delivery] = await deliveries(alertId);
    expect(delivery.recipient_identity_hmac).toBe(
      alertRecipientIdentityHmac('finance@example.com')
    );
    expect(JSON.stringify(delivery)).not.toContain('finance@example.com');
  });

  it('cancels the send when the balance has recovered by dispatch time', async () => {
    const organizationId = await createEnterpriseOrganization();
    const alertId = await createAlert(organizationId);
    // The crossing is real at evaluation time, but the stored balance used for
    // dispatch-time re-validation is already back at or above the threshold.
    await setStoredBalance(organizationId, THRESHOLD);

    await evaluateLowBalanceAlerts({
      organizationId,
      previousBalanceMicrodollars: THRESHOLD + 1,
      newBalanceMicrodollars: THRESHOLD - 1,
    });

    const [delivery] = await deliveries(alertId);
    expect(delivery.status).toBe('canceled');
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('does nothing for a mutation that does not decrease the balance', async () => {
    const organizationId = await createEnterpriseOrganization();
    const alertId = await createAlert(organizationId);
    await setStoredBalance(organizationId, THRESHOLD - 1);

    await evaluateLowBalanceAlerts({
      organizationId,
      previousBalanceMicrodollars: THRESHOLD - 1,
      newBalanceMicrodollars: THRESHOLD - 1,
    });

    expect(await deliveries(alertId)).toHaveLength(0);
  });
});
