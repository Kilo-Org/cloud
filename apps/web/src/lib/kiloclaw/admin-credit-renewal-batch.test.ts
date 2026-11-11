import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';
import { LEGACY_KILOCLAW_PRICE_VERSION } from '@kilocode/db';
import {
  kiloclaw_admin_audit_logs,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

const CONFIRMATION = 'STOP CREDIT RENEWALS';

type SubscriptionInput = {
  payment_source?: 'stripe' | 'credits';
  status?: 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid';
  cancel_at_period_end?: boolean;
  stripe_subscription_id?: string | null;
  transferred_to_subscription_id?: string | null;
  stripe_schedule_id?: string | null;
};

async function insertSubscription(input: SubscriptionInput = {}) {
  const user = await insertTestUser();
  const [subscription] = await db
    .insert(kiloclaw_subscriptions)
    .values({
      user_id: user.id,
      payment_source: input.payment_source ?? 'credits',
      status: input.status ?? 'active',
      cancel_at_period_end: input.cancel_at_period_end ?? false,
      stripe_subscription_id: input.stripe_subscription_id ?? null,
      transferred_to_subscription_id: input.transferred_to_subscription_id ?? null,
      stripe_schedule_id: input.stripe_schedule_id ?? null,
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
      plan: 'standard',
    })
    .returning();
  return { user, subscription };
}

async function superadminCaller() {
  const admin = await insertTestUser({ is_admin: true, is_super_admin: true });
  return { admin, caller: await createCallerForUser(admin.id) };
}

describe('admin credit renewal controls', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('previews only credit subscriptions that are actively renewing', async () => {
    await insertSubscription();
    await insertSubscription();
    await insertSubscription({ cancel_at_period_end: true });
    await insertSubscription({ status: 'canceled' });
    await insertSubscription({ payment_source: 'stripe', stripe_subscription_id: 'sub_stripe' });
    await insertSubscription({ stripe_subscription_id: 'sub_hybrid' });
    const transferTarget = await insertSubscription({ status: 'canceled' });
    await insertSubscription({ transferred_to_subscription_id: transferTarget.subscription.id });

    const { caller } = await superadminCaller();

    await expect(caller.admin.kiloclawCreditRenewals.preview()).resolves.toEqual({
      renewing: 2,
      ending: 1,
    });
  });

  it('stops renewals for eligible credit subscriptions only', async () => {
    const eligible = await insertSubscription({ stripe_schedule_id: 'sched_1' });
    const ending = await insertSubscription({ cancel_at_period_end: true });
    const canceled = await insertSubscription({ status: 'canceled' });
    const stripe = await insertSubscription({
      payment_source: 'stripe',
      stripe_subscription_id: 'sub_stripe',
    });
    const transferTarget = await insertSubscription({ status: 'canceled' });
    const transferred = await insertSubscription({
      transferred_to_subscription_id: transferTarget.subscription.id,
    });

    const { caller } = await superadminCaller();
    await expect(
      caller.admin.kiloclawCreditRenewals.stop({ confirmation: CONFIRMATION })
    ).resolves.toEqual({ updated: 1, remaining: false });

    const [stopped] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, eligible.subscription.id));
    expect(stopped).toMatchObject({
      cancel_at_period_end: true,
      stripe_schedule_id: null,
      scheduled_plan: null,
      scheduled_by: null,
    });

    for (const untouched of [ending, canceled, stripe, transferred]) {
      const [row] = await db
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.id, untouched.subscription.id));
      expect(row).toEqual(untouched.subscription);
    }
  });

  it('writes one change log per subscription and one summary audit log', async () => {
    const first = await insertSubscription();
    const second = await insertSubscription();
    const { admin, caller } = await superadminCaller();

    await caller.admin.kiloclawCreditRenewals.stop({ confirmation: CONFIRMATION });

    const changeLogs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.actor_id, admin.id));
    expect(changeLogs).toHaveLength(2);
    expect(new Set(changeLogs.map(log => log.subscription_id))).toEqual(
      new Set([first.subscription.id, second.subscription.id])
    );
    for (const log of changeLogs) {
      expect(log).toMatchObject({
        actor_type: 'user',
        action: 'canceled',
        reason: 'admin_stop_credit_renewal:kiloclaw_eol',
      });
      expect(log.before_state).toMatchObject({ cancel_at_period_end: false });
      expect(log.after_state).toMatchObject({ cancel_at_period_end: true });
    }

    const auditLogs = await db
      .select()
      .from(kiloclaw_admin_audit_logs)
      .where(
        and(
          eq(kiloclaw_admin_audit_logs.action, 'kiloclaw.subscription.admin_cancel'),
          eq(kiloclaw_admin_audit_logs.actor_id, admin.id)
        )
      );
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].metadata).toEqual({
      reason: 'KiloClaw end of life',
      scope: 'credit_renewals',
      updated: 2,
      remaining: false,
    });
  });

  it('is idempotent on a second run', async () => {
    await insertSubscription();
    const { caller } = await superadminCaller();

    await expect(
      caller.admin.kiloclawCreditRenewals.stop({ confirmation: CONFIRMATION })
    ).resolves.toEqual({ updated: 1, remaining: false });
    await expect(
      caller.admin.kiloclawCreditRenewals.stop({ confirmation: CONFIRMATION })
    ).resolves.toEqual({ updated: 0, remaining: false });
  });

  it('rejects the wrong confirmation phrase', async () => {
    await insertSubscription();
    const { caller } = await superadminCaller();

    await expect(
      caller.admin.kiloclawCreditRenewals.stop({ confirmation: 'STOP' as never })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.admin.kiloclawCreditRenewals.preview()).resolves.toMatchObject({
      renewing: 1,
    });
  });

  it('requires superadmin access', async () => {
    const user = await insertTestUser({ is_admin: false });
    const caller = await createCallerForUser(user.id);
    await expect(caller.admin.kiloclawCreditRenewals.preview()).rejects.toThrow(
      'Admin access required'
    );

    const platformAdmin = await insertTestUser({ is_admin: true, is_super_admin: false });
    const platformCaller = await createCallerForUser(platformAdmin.id);
    await expect(platformCaller.admin.kiloclawCreditRenewals.preview()).rejects.toThrow(
      'Superadmin access required'
    );
  });
});
