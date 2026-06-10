/* eslint-disable drizzle/enforce-delete-with-where */
import { eq } from 'drizzle-orm';

import { runCodingPlanBillingLifecycleCron } from '@/lib/coding-plans/billing-lifecycle-cron';
import { subscribeToCodingPlan, uploadKeysToInventory } from '@/lib/coding-plans';
import { db } from '@/lib/drizzle';
import { maybePerformAutoTopUp } from '@/lib/autoTopUp';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  byok_api_keys,
  coding_plan_key_inventory,
  coding_plan_subscriptions,
  coding_plan_terms,
  credit_transactions,
  kilocode_users,
} from '@kilocode/db/schema';

jest.mock('@/lib/autoTopUp', () => ({
  maybePerformAutoTopUp: jest.fn(async () => undefined),
}));

const PLAN_ID = 'minimax-token-plan-plus';
const COST_MICRODOLLARS = 20_000_000;
const dueAt = new Date(Date.now() - 60_000).toISOString();

async function createSubscription(balance = COST_MICRODOLLARS, autoTopUpEnabled = false) {
  const user = await insertTestUser({
    total_microdollars_acquired: balance,
    microdollars_used: 0,
    auto_top_up_enabled: autoTopUpEnabled,
  });
  await uploadKeysToInventory(
    PLAN_ID,
    [`cron-key-${crypto.randomUUID()}::minimax-plan-${crypto.randomUUID()}`],
    {
      validateCredential: async () => true,
    }
  );
  const created = await subscribeToCodingPlan(user.id, PLAN_ID, `activate-${crypto.randomUUID()}`);
  await db
    .update(coding_plan_subscriptions)
    .set({ current_period_end: dueAt, credit_renewal_at: dueAt })
    .where(eq(coding_plan_subscriptions.id, created.subscriptionId));
  return { user, subscriptionId: created.subscriptionId };
}

afterEach(async () => {
  jest.mocked(maybePerformAutoTopUp).mockClear();
  await db.delete(coding_plan_terms);
  await db.delete(coding_plan_subscriptions);
  await db.delete(byok_api_keys);
  await db.delete(coding_plan_key_inventory);
  await db.delete(credit_transactions);
  await db.delete(kilocode_users);
});

describe('Coding Plan billing lifecycle cron', () => {
  it('renews atomically with a charged term and retains assigned access', async () => {
    const { subscriptionId } = await createSubscription(COST_MICRODOLLARS * 2);

    const summary = await runCodingPlanBillingLifecycleCron(db);
    const [subscription] = await db
      .select()
      .from(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.id, subscriptionId));
    const terms = await db
      .select()
      .from(coding_plan_terms)
      .where(eq(coding_plan_terms.subscription_id, subscriptionId));
    const [credential] = await db
      .select()
      .from(coding_plan_key_inventory)
      .where(eq(coding_plan_key_inventory.id, subscription.key_inventory_id!));
    const renewalTransaction = await db
      .select({ description: credit_transactions.description })
      .from(credit_transactions)
      .where(eq(credit_transactions.description, 'Coding plan renewal: MiniMax Token Plan Plus'));

    expect(summary.renewals).toBe(1);
    expect(subscription.status).toBe('active');
    expect(terms.map(term => term.kind)).toEqual(['activation', 'renewal']);
    expect(renewalTransaction).toEqual([
      { description: 'Coding plan renewal: MiniMax Token Plan Plus' },
    ]);
    expect(credential.status).toBe('assigned');
  });

  it('renews after the subscriber deletes the installed MiniMax BYOK key', async () => {
    const { subscriptionId } = await createSubscription(COST_MICRODOLLARS * 2);
    const [before] = await db
      .select()
      .from(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.id, subscriptionId));
    await db.delete(byok_api_keys).where(eq(byok_api_keys.id, before.installed_byok_key_id!));

    const summary = await runCodingPlanBillingLifecycleCron(db);
    const [subscription] = await db
      .select()
      .from(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.id, subscriptionId));

    expect(summary.renewals).toBe(1);
    expect(subscription.status).toBe('active');
    expect(subscription.installed_byok_key_id).toBeNull();
  });

  it('ends user-canceled access at period end and queues credential revocation', async () => {
    const { subscriptionId } = await createSubscription(COST_MICRODOLLARS);
    await db
      .update(coding_plan_subscriptions)
      .set({ cancel_at_period_end: true })
      .where(eq(coding_plan_subscriptions.id, subscriptionId));

    const summary = await runCodingPlanBillingLifecycleCron(db);
    const [subscription] = await db
      .select()
      .from(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.id, subscriptionId));
    const [credential] = await db
      .select()
      .from(coding_plan_key_inventory)
      .where(eq(coding_plan_key_inventory.id, subscription.key_inventory_id!));

    expect(summary.canceled_at_period_end).toBe(1);
    expect(subscription.status).toBe('canceled');
    expect(subscription.cancellation_reason).toBe('user_canceled');
    expect(subscription.installed_byok_key_id).toBeNull();
    expect(credential.status).toBe('revocation_pending');
    expect(credential.upstream_plan_id).toEqual(expect.any(String));
    expect(credential.encrypted_api_key).toBeNull();
    expect(maybePerformAutoTopUp).not.toHaveBeenCalled();
  });

  it('terminates unfunded renewal immediately when auto-top-up is disabled', async () => {
    const { subscriptionId } = await createSubscription();

    const summary = await runCodingPlanBillingLifecycleCron(db);
    const [subscription] = await db
      .select()
      .from(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.id, subscriptionId));
    const [credential] = await db
      .select()
      .from(coding_plan_key_inventory)
      .where(eq(coding_plan_key_inventory.id, subscription.key_inventory_id!));

    expect(summary.canceled_insufficient_balance).toBe(1);
    expect(subscription.status).toBe('canceled');
    expect(subscription.cancellation_reason).toBe('insufficient_credits');
    expect(credential.status).toBe('revocation_pending');
    expect(credential.encrypted_api_key).toBeNull();
  });

  it('allows one past-due grace period and one auto-top-up attempt', async () => {
    const { subscriptionId } = await createSubscription(COST_MICRODOLLARS, true);

    const firstSummary = await runCodingPlanBillingLifecycleCron(db);
    await runCodingPlanBillingLifecycleCron(db);
    const [subscription] = await db
      .select()
      .from(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.id, subscriptionId));

    expect(firstSummary.past_due_started).toBe(1);
    expect(subscription.status).toBe('past_due');
    expect(subscription.payment_grace_expires_at).not.toBeNull();
    expect(maybePerformAutoTopUp).toHaveBeenCalledTimes(1);
  });

  it('restores active status when credits arrive during grace', async () => {
    const { user, subscriptionId } = await createSubscription(COST_MICRODOLLARS, true);
    await runCodingPlanBillingLifecycleCron(db);
    await db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: COST_MICRODOLLARS * 2 })
      .where(eq(kilocode_users.id, user.id));

    await runCodingPlanBillingLifecycleCron(db);
    const [subscription] = await db
      .select()
      .from(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.id, subscriptionId));

    expect(subscription.status).toBe('active');
    expect(subscription.payment_grace_expires_at).toBeNull();
  });

  it('terminates access when payment grace expires without funding', async () => {
    const { subscriptionId } = await createSubscription(COST_MICRODOLLARS, true);
    await runCodingPlanBillingLifecycleCron(db);
    await db
      .update(coding_plan_subscriptions)
      .set({ payment_grace_expires_at: dueAt })
      .where(eq(coding_plan_subscriptions.id, subscriptionId));

    await runCodingPlanBillingLifecycleCron(db);
    const [subscription] = await db
      .select()
      .from(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.id, subscriptionId));
    const [credential] = await db
      .select()
      .from(coding_plan_key_inventory)
      .where(eq(coding_plan_key_inventory.id, subscription.key_inventory_id!));

    expect(subscription.status).toBe('canceled');
    expect(subscription.cancellation_reason).toBe('insufficient_credits');
    expect(credential.status).toBe('revocation_pending');
    expect(credential.encrypted_api_key).toBeNull();
  });

  it('preserves a replacement MiniMax key when scheduled cancellation is processed', async () => {
    const { subscriptionId, user } = await createSubscription(COST_MICRODOLLARS);
    const [subscription] = await db
      .select()
      .from(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.id, subscriptionId));
    await db
      .update(byok_api_keys)
      .set({ management_source: 'user' })
      .where(eq(byok_api_keys.id, subscription.installed_byok_key_id!));
    await db
      .update(coding_plan_subscriptions)
      .set({ cancel_at_period_end: true, installed_byok_key_id: null })
      .where(eq(coding_plan_subscriptions.id, subscriptionId));

    await runCodingPlanBillingLifecycleCron(db);
    const remainingKeys = await db
      .select()
      .from(byok_api_keys)
      .where(eq(byok_api_keys.kilo_user_id, user.id));

    expect(remainingKeys).toHaveLength(1);
    expect(remainingKeys[0].management_source).toBe('user');
  });
});
