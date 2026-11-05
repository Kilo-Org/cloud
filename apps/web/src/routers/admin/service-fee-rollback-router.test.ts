import { afterEach, describe, expect, jest, test } from '@jest/globals';
import type Stripe from 'stripe';
import { eq } from 'drizzle-orm';

import {
  admin_action_audit_logs,
  service_fee_rollback_refunds,
  stripe_service_fee_assessments,
} from '@kilocode/db/schema';
import type { AdminActionAuditAction } from '@kilocode/db/schema-types';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { client as stripeClient } from '@kilocode/web-shared/lib/stripe-client';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';

async function insertAdmin(isSuperAdmin: boolean) {
  return insertTestUser({
    is_admin: true,
    is_super_admin: isSuperAdmin,
    google_user_email: `admin-${crypto.randomUUID()}@kilocode.ai`,
  });
}

async function seedChargedFee(kiloUserId: string, chargeId: string) {
  const assessmentKey = `checkout:${crypto.randomUUID()}`;
  await db.insert(stripe_service_fee_assessments).values({
    assessment_key: assessmentKey,
    version: 'test',
    flow: 'personal_top_up',
    outcome: 'charged',
    currency: 'usd',
    kilo_user_id: kiloUserId,
    stripe_charge_id: chargeId,
    eligibility_created_at: '2026-11-01T12:00:00.000Z',
    eligible_subtotal_minor: 5_000,
    expected_fee_minor: 250,
    charged_fee_minor: 250,
    gross_paid_minor: 5_250,
    settled_product_minor: 5_000,
    settled_at: '2026-11-01T12:01:00.000Z',
  });
  return assessmentKey;
}

async function auditRows(action: AdminActionAuditAction) {
  return db
    .select()
    .from(admin_action_audit_logs)
    .where(eq(admin_action_audit_logs.action, action));
}

describe('admin.serviceFeeRollback', () => {
  afterEach(async () => {
    jest.restoreAllMocks();
    await cleanupDbForTest();
  });

  test('platform admins can view the overview but cannot refund', async () => {
    const admin = await insertAdmin(false);
    const customer = await insertTestUser();
    await seedChargedFee(customer.id, 'ch_view_only');
    const caller = await createCallerForUser(admin.id);

    const overview = await caller.admin.serviceFeeRollback.overview();
    expect(overview.remaining).toEqual({ count: 1, amountMinor: 250 });

    await expect(caller.admin.serviceFeeRollback.executeBatch({ limit: 5 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller.admin.serviceFeeRollback.reconcileStale()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  test('superadmins refund a batch and each refund is audit logged', async () => {
    const admin = await insertAdmin(true);
    const customer = await insertTestUser();
    const chargeId = `ch_${crypto.randomUUID()}`;
    await seedChargedFee(customer.id, chargeId);
    jest.spyOn(stripeClient.charges, 'retrieve').mockResolvedValue({
      id: chargeId,
      amount: 5_250,
      amount_refunded: 0,
      currency: 'usd',
    } as unknown as Stripe.Response<Stripe.Charge>);
    jest.spyOn(stripeClient.refunds, 'list').mockResolvedValue({
      object: 'list',
      data: [],
      has_more: false,
      url: '/v1/refunds',
    } as unknown as Stripe.Response<Stripe.ApiList<Stripe.Refund>>);
    const create = jest.spyOn(stripeClient.refunds, 'create').mockResolvedValue({
      id: 're_router_test',
      amount: 250,
      status: 'succeeded',
    } as unknown as Stripe.Response<Stripe.Refund>);
    const caller = await createCallerForUser(admin.id);

    const results = await caller.admin.serviceFeeRollback.executeBatch({ limit: 5 });

    expect(results).toEqual([
      expect.objectContaining({
        status: 'refunded',
        amountMinor: 250,
        stripeRefundId: 're_router_test',
      }),
    ]);
    expect(create).toHaveBeenCalledTimes(1);
    const audits = await db
      .select()
      .from(admin_action_audit_logs)
      .where(eq(admin_action_audit_logs.action, 'service_fee.rollback_refund'));
    expect(audits).toEqual([
      expect.objectContaining({
        actor_id: admin.id,
        target_type: 'user',
        target_id: customer.id,
        metadata: expect.objectContaining({ stripeRefundId: 're_router_test', amountMinor: 250 }),
      }),
    ]);
  });

  test('a refund with an unknown outcome is audit logged', async () => {
    const admin = await insertAdmin(true);
    const customer = await insertTestUser();
    const chargeId = `ch_${crypto.randomUUID()}`;
    await seedChargedFee(customer.id, chargeId);
    jest.spyOn(stripeClient.charges, 'retrieve').mockResolvedValue({
      id: chargeId,
      amount: 5_250,
      amount_refunded: 0,
      currency: 'usd',
    } as unknown as Stripe.Response<Stripe.Charge>);
    jest.spyOn(stripeClient.refunds, 'list').mockResolvedValue({
      object: 'list',
      data: [],
      has_more: false,
      url: '/v1/refunds',
    } as unknown as Stripe.Response<Stripe.ApiList<Stripe.Refund>>);
    jest.spyOn(stripeClient.refunds, 'create').mockRejectedValue(new Error('socket hang up'));
    const caller = await createCallerForUser(admin.id);

    const results = await caller.admin.serviceFeeRollback.executeBatch({ limit: 5 });

    expect(results).toEqual([expect.objectContaining({ status: 'outcome_unknown' })]);
    expect(await auditRows('service_fee.rollback_refund')).toEqual([
      expect.objectContaining({
        target_id: customer.id,
        metadata: expect.objectContaining({ status: 'outcome_unknown', amountMinor: 250 }),
      }),
    ]);
  });

  test('reconcile resolutions are audit logged', async () => {
    const admin = await insertAdmin(true);
    const customer = await insertTestUser();
    const chargeId = `ch_${crypto.randomUUID()}`;
    const assessmentKey = await seedChargedFee(customer.id, chargeId);
    await db.insert(service_fee_rollback_refunds).values({
      assessment_key: assessmentKey,
      status: 'pending',
      currency: 'usd',
      amount_minor: 250,
      stripe_charge_id: chargeId,
      updated_at: '2026-11-01T00:00:00.000Z',
    });
    jest.spyOn(stripeClient.refunds, 'list').mockResolvedValue({
      object: 'list',
      data: [
        {
          id: 're_reconciled',
          object: 'refund',
          amount: 250,
          status: 'succeeded',
          metadata: { serviceFeeRollback: assessmentKey },
        },
      ],
      has_more: false,
      url: '/v1/refunds',
    } as unknown as Stripe.Response<Stripe.ApiList<Stripe.Refund>>);
    const caller = await createCallerForUser(admin.id);

    const results = await caller.admin.serviceFeeRollback.reconcileStale();

    expect(results).toEqual([
      expect.objectContaining({ status: 'succeeded', stripeRefundId: 're_reconciled' }),
    ]);
    expect(await auditRows('service_fee.rollback_reconcile')).toEqual([
      expect.objectContaining({
        actor_id: admin.id,
        target_id: customer.id,
        metadata: expect.objectContaining({
          status: 'succeeded',
          stripeRefundId: 're_reconciled',
          amountMinor: 250,
        }),
      }),
    ]);
  });
});
