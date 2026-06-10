/* eslint-disable drizzle/enforce-delete-with-where */
import { eq } from 'drizzle-orm';

import { encryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import {
  cancelCodingPlanSubscription,
  getKeyInventoryCounts,
  subscribeToCodingPlan,
  terminateCodingPlanImmediately,
  uploadKeysToInventory,
} from '@/lib/coding-plans';
import { CODING_PLAN_CATALOG } from '@/lib/coding-plans/pricing';
import {
  markCredentialManuallyRevoked,
  markCredentialManualRevocationFailed,
  requeueManualCredentialRevocation,
} from '@/lib/coding-plans/revocation';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  byok_api_keys,
  coding_plan_key_inventory,
  coding_plan_subscriptions,
  coding_plan_terms,
  credit_transactions,
  kilocode_users,
} from '@kilocode/db/schema';

const PLAN_ID = 'minimax-token-plan-plus';
const PROVIDER_ID = 'minimax';
const COST_MICRODOLLARS = 20_000_000;

const validatedInventoryUpload = { validateCredential: async () => true };

function inventoryEntry(key: string, upstreamPlanId = `minimax-plan-${crypto.randomUUID()}`) {
  return `${key}::${upstreamPlanId}`;
}

async function seedInventoryKey(key = `managed-test-key-${crypto.randomUUID()}`) {
  await uploadKeysToInventory(PLAN_ID, [inventoryEntry(key)], validatedInventoryUpload);
}

async function createUserWithBalance(microdollars: number) {
  return insertTestUser({
    total_microdollars_acquired: microdollars,
    microdollars_used: 0,
  });
}

afterEach(async () => {
  await db.delete(coding_plan_terms);
  await db.delete(coding_plan_subscriptions);
  await db.delete(byok_api_keys);
  await db.delete(coding_plan_key_inventory);
  await db.delete(credit_transactions);
  await db.delete(kilocode_users);
});

describe('coding plans', () => {
  it('publishes the code-owned MiniMax Token Plan Plus catalog entry', () => {
    expect(CODING_PLAN_CATALOG[PLAN_ID]).toEqual({
      planId: PLAN_ID,
      providerName: 'MiniMax',
      name: 'Token Plan Plus',
      providerId: PROVIDER_ID,
      costMicrodollars: COST_MICRODOLLARS,
      billingPeriodDays: 30,
    });
  });

  it('activates an episode with one charged term and managed BYOK entry', async () => {
    const user = await createUserWithBalance(COST_MICRODOLLARS);
    await seedInventoryKey();

    const result = await subscribeToCodingPlan(user.id, PLAN_ID, 'activation-request');
    const [subscription] = await db
      .select()
      .from(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.id, result.subscriptionId));
    const terms = await db
      .select()
      .from(coding_plan_terms)
      .where(eq(coding_plan_terms.subscription_id, result.subscriptionId));
    const [managedKey] = await db
      .select()
      .from(byok_api_keys)
      .where(eq(byok_api_keys.id, subscription.installed_byok_key_id!));
    const [inventoryKey] = await db
      .select()
      .from(coding_plan_key_inventory)
      .where(eq(coding_plan_key_inventory.id, subscription.key_inventory_id!));

    expect(subscription.plan_id).toBe(PLAN_ID);
    expect(subscription.provider_id).toBe(PROVIDER_ID);
    expect(subscription.status).toBe('active');
    expect(terms).toHaveLength(1);
    expect(terms[0].kind).toBe('activation');
    expect(terms[0].cost_microdollars).toBe(COST_MICRODOLLARS);
    expect(managedKey.provider_id).toBe(PROVIDER_ID);
    expect(managedKey.management_source).toBe('coding_plan');
    expect(inventoryKey.status).toBe('assigned');
    expect(inventoryKey.assigned_to_user_id).toBe(user.id);
  });

  it('returns prior outcome when an activation request is retried', async () => {
    const user = await createUserWithBalance(COST_MICRODOLLARS * 2);
    await seedInventoryKey();
    await seedInventoryKey();

    const first = await subscribeToCodingPlan(user.id, PLAN_ID, 'same-request');
    const retried = await subscribeToCodingPlan(user.id, PLAN_ID, 'same-request');
    const terms = await db.select().from(coding_plan_terms);
    const assigned = await db
      .select()
      .from(coding_plan_key_inventory)
      .where(eq(coding_plan_key_inventory.status, 'assigned'));
    const [updatedUser] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));

    expect(retried.subscriptionId).toBe(first.subscriptionId);
    expect(terms).toHaveLength(1);
    expect(assigned).toHaveLength(1);
    expect(updatedUser.microdollars_used).toBe(COST_MICRODOLLARS);
  });

  it('rejects a new purchase while an active subscription exists', async () => {
    const user = await createUserWithBalance(COST_MICRODOLLARS * 2);
    await seedInventoryKey();
    const activation = await subscribeToCodingPlan(user.id, PLAN_ID, 'activate');
    const [before] = await db
      .select()
      .from(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.id, activation.subscriptionId));

    await expect(subscribeToCodingPlan(user.id, PLAN_ID, 'second-purchase')).rejects.toThrow(
      'already has a live subscription'
    );
    const [after] = await db
      .select()
      .from(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.id, activation.subscriptionId));
    const terms = await db
      .select()
      .from(coding_plan_terms)
      .where(eq(coding_plan_terms.subscription_id, activation.subscriptionId));
    const [updatedUser] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));

    expect(after.current_period_end).toBe(before.current_period_end);
    expect(terms.map(term => term.kind)).toEqual(['activation']);
    expect(updatedUser.microdollars_used).toBe(COST_MICRODOLLARS);
  });

  it('cannot overspend credits during concurrent purchase requests', async () => {
    const user = await createUserWithBalance(COST_MICRODOLLARS);
    await seedInventoryKey();
    await seedInventoryKey();

    const outcomes = await Promise.allSettled([
      subscribeToCodingPlan(user.id, PLAN_ID, 'concurrent-one'),
      subscribeToCodingPlan(user.id, PLAN_ID, 'concurrent-two'),
    ]);
    const [updatedUser] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    const subscriptions = await db
      .select()
      .from(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.user_id, user.id));

    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(updatedUser.microdollars_used).toBe(COST_MICRODOLLARS);
    expect(subscriptions).toHaveLength(1);
  });

  it('rolls back activation when credits are insufficient or capacity is absent', async () => {
    const poorUser = await createUserWithBalance(COST_MICRODOLLARS - 1);
    await seedInventoryKey();
    await expect(subscribeToCodingPlan(poorUser.id, PLAN_ID, 'poor')).rejects.toThrow(
      'Insufficient credit balance'
    );

    const fundedUser = await createUserWithBalance(COST_MICRODOLLARS);
    const [availableKey] = await db
      .select()
      .from(coding_plan_key_inventory)
      .where(eq(coding_plan_key_inventory.status, 'available'));
    await db
      .update(coding_plan_key_inventory)
      .set({ status: 'assigned' })
      .where(eq(coding_plan_key_inventory.id, availableKey.id));
    await expect(subscribeToCodingPlan(fundedUser.id, PLAN_ID, 'capacity')).rejects.toThrow(
      'No managed credential'
    );
    const [unchargedUser] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, fundedUser.id));
    expect(unchargedUser.microdollars_used).toBe(0);
  });

  it('rejects activation when the personal MiniMax BYOK slot is occupied', async () => {
    const user = await createUserWithBalance(COST_MICRODOLLARS);
    await seedInventoryKey();
    await db.insert(byok_api_keys).values({
      kilo_user_id: user.id,
      provider_id: PROVIDER_ID,
      encrypted_api_key: encryptApiKey('existing-minimax', BYOK_ENCRYPTION_KEY),
      is_enabled: false,
      created_by: user.id,
    });

    await expect(subscribeToCodingPlan(user.id, PLAN_ID, 'occupied-slot')).rejects.toThrow(
      'Remove your existing MiniMax BYOK key'
    );
    const [updatedUser] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    const terms = await db.select().from(coding_plan_terms);
    const subscriptions = await db.select().from(coding_plan_subscriptions);
    const [inventory] = await db.select().from(coding_plan_key_inventory);

    expect(updatedUser.microdollars_used).toBe(0);
    expect(terms).toHaveLength(0);
    expect(subscriptions).toHaveLength(0);
    expect(inventory.status).toBe('available');
  });

  it('creates a new episode and new credential after immediate termination', async () => {
    const user = await createUserWithBalance(COST_MICRODOLLARS * 2);
    await seedInventoryKey();
    await seedInventoryKey();
    const first = await subscribeToCodingPlan(user.id, PLAN_ID, 'first-episode');
    const [firstSubscription] = await db
      .select()
      .from(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.id, first.subscriptionId));

    await terminateCodingPlanImmediately(first.subscriptionId);
    const second = await subscribeToCodingPlan(user.id, PLAN_ID, 'second-episode');
    const [terminatedCredential] = await db
      .select()
      .from(coding_plan_key_inventory)
      .where(eq(coding_plan_key_inventory.id, firstSubscription.key_inventory_id!));

    expect(second.subscriptionId).not.toBe(first.subscriptionId);
    expect(terminatedCredential.status).toBe('revocation_pending');
    const subscriptions = await db
      .select()
      .from(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.user_id, user.id));
    expect(subscriptions.map(subscription => subscription.status).sort()).toEqual([
      'active',
      'canceled',
    ]);
  });

  it('preserves a detached user-managed MiniMax key on termination', async () => {
    const user = await createUserWithBalance(COST_MICRODOLLARS);
    await seedInventoryKey();
    const activation = await subscribeToCodingPlan(user.id, PLAN_ID, 'replace-before-end');
    const [subscription] = await db
      .select()
      .from(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.id, activation.subscriptionId));
    await db
      .update(byok_api_keys)
      .set({ management_source: 'user' })
      .where(eq(byok_api_keys.id, subscription.installed_byok_key_id!));
    await db
      .update(coding_plan_subscriptions)
      .set({ installed_byok_key_id: null })
      .where(eq(coding_plan_subscriptions.id, activation.subscriptionId));

    await terminateCodingPlanImmediately(activation.subscriptionId);
    const remainingKeys = await db
      .select()
      .from(byok_api_keys)
      .where(eq(byok_api_keys.kilo_user_id, user.id));

    expect(remainingKeys).toHaveLength(1);
    expect(remainingKeys[0].management_source).toBe('user');
  });

  it('schedules user cancellation without immediately removing installed access', async () => {
    const user = await createUserWithBalance(COST_MICRODOLLARS);
    await seedInventoryKey();
    const result = await subscribeToCodingPlan(user.id, PLAN_ID, 'cancel-request');

    await cancelCodingPlanSubscription(user.id, result.subscriptionId);
    const [subscription] = await db
      .select()
      .from(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.id, result.subscriptionId));
    const managedKeys = await db
      .select()
      .from(byok_api_keys)
      .where(eq(byok_api_keys.kilo_user_id, user.id));

    expect(subscription.status).toBe('active');
    expect(subscription.cancel_at_period_end).toBe(true);
    expect(managedKeys).toHaveLength(1);
  });

  it('stores upstream plan IDs separately from validated inventory credentials', async () => {
    const validateCredential = jest.fn(async () => true);

    await uploadKeysToInventory(PLAN_ID, ['test-api-key::minimax-upstream-plan-123'], {
      validateCredential,
    });
    const [inventory] = await db.select().from(coding_plan_key_inventory);

    expect(validateCredential).toHaveBeenCalledWith('test-api-key');
    expect(inventory.plan_id).toBe(PLAN_ID);
    expect(inventory.upstream_plan_id).toBe('minimax-upstream-plan-123');
  });

  it('rejects malformed or unvalidated inventory entries before they become available', async () => {
    const validateCredential = jest.fn(async () => false);

    await expect(
      uploadKeysToInventory(PLAN_ID, ['missing-plan-id'], { validateCredential })
    ).rejects.toThrow('<api key>::<plan id>');
    expect(validateCredential).not.toHaveBeenCalled();
    await expect(
      uploadKeysToInventory(PLAN_ID, ['invalid-key::minimax-plan-id'], { validateCredential })
    ).rejects.toThrow('failed validation');
    expect(validateCredential).toHaveBeenCalledWith('invalid-key');
    expect(await db.select().from(coding_plan_key_inventory)).toHaveLength(0);
  });

  it('rejects duplicate uploaded credentials using a secret keyed fingerprint', async () => {
    await uploadKeysToInventory(
      PLAN_ID,
      [inventoryEntry('duplicate-key', 'minimax-plan-one')],
      validatedInventoryUpload
    );
    await expect(
      uploadKeysToInventory(
        PLAN_ID,
        [inventoryEntry('duplicate-key', 'minimax-plan-two')],
        validatedInventoryUpload
      )
    ).rejects.toThrow('already present');
    const counts = await getKeyInventoryCounts(PLAN_ID);
    expect(counts).toEqual([{ planId: PLAN_ID, status: 'available', count: 1 }]);
  });

  it('clears credential material once revocation work starts and records completion by plan ID', async () => {
    const user = await createUserWithBalance(COST_MICRODOLLARS);
    await uploadKeysToInventory(
      PLAN_ID,
      [inventoryEntry('revoke-success-key', 'minimax-revoke-plan')],
      validatedInventoryUpload
    );
    const activation = await subscribeToCodingPlan(user.id, PLAN_ID, 'revoke-success');
    const [subscription] = await db
      .select()
      .from(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.id, activation.subscriptionId));
    await terminateCodingPlanImmediately(activation.subscriptionId);

    let [credential] = await db
      .select()
      .from(coding_plan_key_inventory)
      .where(eq(coding_plan_key_inventory.id, subscription.key_inventory_id!));
    expect(credential.status).toBe('revocation_pending');
    expect(credential.upstream_plan_id).toBe('minimax-revoke-plan');
    expect(credential.encrypted_api_key).toBeNull();

    await markCredentialManuallyRevoked(subscription.key_inventory_id!);
    [credential] = await db
      .select()
      .from(coding_plan_key_inventory)
      .where(eq(coding_plan_key_inventory.id, subscription.key_inventory_id!));

    expect(credential.status).toBe('revoked');
    expect(credential.upstream_plan_id).toBe('minimax-revoke-plan');
    expect(credential.encrypted_api_key).toBeNull();
    expect(credential.revocation_attempt_count).toBe(1);
  });

  it('keeps failed manual revocation terminal and retryable', async () => {
    const user = await createUserWithBalance(COST_MICRODOLLARS);
    await seedInventoryKey('revoke-failure-key');
    const activation = await subscribeToCodingPlan(user.id, PLAN_ID, 'revoke-failure');
    const [subscription] = await db
      .select()
      .from(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.id, activation.subscriptionId));
    await terminateCodingPlanImmediately(activation.subscriptionId);

    await markCredentialManualRevocationFailed(
      subscription.key_inventory_id!,
      'MiniMax admin request failed with api_key=secret-value'
    );
    let [credential] = await db
      .select()
      .from(coding_plan_key_inventory)
      .where(eq(coding_plan_key_inventory.id, subscription.key_inventory_id!));

    expect(credential.status).toBe('revocation_failed');
    expect(credential.upstream_plan_id).toEqual(expect.any(String));
    expect(credential.encrypted_api_key).toBeNull();
    expect(credential.revocation_attempt_count).toBe(1);
    expect(credential.last_revocation_error).toContain('api_key=[redacted]');

    await requeueManualCredentialRevocation(subscription.key_inventory_id!);
    [credential] = await db
      .select()
      .from(coding_plan_key_inventory)
      .where(eq(coding_plan_key_inventory.id, subscription.key_inventory_id!));
    expect(credential.status).toBe('revocation_pending');
    expect(credential.last_revocation_error).toBeNull();
  });
});
