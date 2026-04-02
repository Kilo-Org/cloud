/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@/lib/drizzle';
import {
  byok_api_keys,
  coding_plan_key_inventory,
  coding_plan_subscriptions,
  credit_transactions,
  kilocode_users,
} from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { encryptApiKey } from '@/lib/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import {
  subscribeToCodingPlan,
  cancelCodingPlanSubscription,
  cancelCodingPlanImmediately,
  uploadKeysToInventory,
  getKeyInventoryCounts,
} from '@/lib/coding-plans';

// Use a test provider ID that exists in the coding plan definitions
const TEST_PROVIDER_ID = 'byteplus-coding';
const TEST_COST_MICRODOLLARS = 4_990_000;
const TEST_ENV_VAR = 'CODING_PLAN_PRICE_BYTEPLUS_CODING';

beforeAll(() => {
  // Set the env var so the provider appears in the catalog
  process.env[TEST_ENV_VAR] = String(TEST_COST_MICRODOLLARS);
});

afterAll(() => {
  delete process.env[TEST_ENV_VAR];
});

afterEach(async () => {
  await db.delete(coding_plan_subscriptions);
  await db.delete(byok_api_keys);
  await db.delete(coding_plan_key_inventory);
  await db.delete(credit_transactions);
  await db.delete(kilocode_users);
});

async function seedInventoryKey(providerId: string, plaintext = 'test-api-key-' + Math.random()) {
  const encrypted = encryptApiKey(plaintext, BYOK_ENCRYPTION_KEY);
  const [row] = await db
    .insert(coding_plan_key_inventory)
    .values({ provider_id: providerId, encrypted_api_key: encrypted })
    .returning();
  return { row, plaintext };
}

async function createUserWithBalance(microdollars: number) {
  return insertTestUser({
    total_microdollars_acquired: microdollars,
    microdollars_used: 0,
  });
}

describe('coding-plans', () => {
  describe('subscribeToCodingPlan', () => {
    it('happy path: subscribe, deduct credits, assign key, create BYOK', async () => {
      const user = await createUserWithBalance(TEST_COST_MICRODOLLARS);
      await seedInventoryKey(TEST_PROVIDER_ID);

      const result = await subscribeToCodingPlan(user.id, TEST_PROVIDER_ID);

      // Subscription created
      const [sub] = await db
        .select()
        .from(coding_plan_subscriptions)
        .where(eq(coding_plan_subscriptions.id, result.subscriptionId));
      expect(sub.status).toBe('active');
      expect(sub.provider_id).toBe(TEST_PROVIDER_ID);
      expect(sub.cost_microdollars).toBe(TEST_COST_MICRODOLLARS);
      expect(sub.byok_key_id).not.toBeNull();
      expect(sub.cancel_at_period_end).toBe(false);

      // Credits deducted
      const [updatedUser] = await db
        .select()
        .from(kilocode_users)
        .where(eq(kilocode_users.id, user.id));
      expect(updatedUser.microdollars_used).toBe(TEST_COST_MICRODOLLARS);

      // BYOK entry created
      const [byok] = await db
        .select()
        .from(byok_api_keys)
        .where(
          and(
            eq(byok_api_keys.kilo_user_id, user.id),
            eq(byok_api_keys.provider_id, TEST_PROVIDER_ID)
          )
        );
      expect(byok).toBeDefined();
      expect(byok.is_enabled).toBe(true);

      // Inventory key assigned
      const [invKey] = await db
        .select()
        .from(coding_plan_key_inventory)
        .where(eq(coding_plan_key_inventory.assigned_to_user_id, user.id));
      expect(invKey).toBeDefined();
      expect(invKey.assigned_at).not.toBeNull();
    });

    it('rejects when balance is insufficient', async () => {
      const user = await createUserWithBalance(100); // not enough
      await seedInventoryKey(TEST_PROVIDER_ID);

      await expect(subscribeToCodingPlan(user.id, TEST_PROVIDER_ID)).rejects.toThrow(
        'Insufficient credit balance'
      );

      // No subscription created
      const subs = await db
        .select()
        .from(coding_plan_subscriptions)
        .where(eq(coding_plan_subscriptions.user_id, user.id));
      expect(subs).toHaveLength(0);

      // No credits deducted
      const [updatedUser] = await db
        .select()
        .from(kilocode_users)
        .where(eq(kilocode_users.id, user.id));
      expect(updatedUser.microdollars_used).toBe(0);
    });

    it('rejects and rolls back when no inventory key is available', async () => {
      const user = await createUserWithBalance(TEST_COST_MICRODOLLARS);
      // No keys seeded!

      await expect(subscribeToCodingPlan(user.id, TEST_PROVIDER_ID)).rejects.toThrow(
        'No pre-purchased API key available'
      );

      // Credits NOT deducted (transaction rolled back)
      const [updatedUser] = await db
        .select()
        .from(kilocode_users)
        .where(eq(kilocode_users.id, user.id));
      expect(updatedUser.microdollars_used).toBe(0);
    });

    it('rejects unknown provider', async () => {
      const user = await createUserWithBalance(TEST_COST_MICRODOLLARS);
      await expect(subscribeToCodingPlan(user.id, 'nonexistent-provider')).rejects.toThrow(
        'not available as a coding plan'
      );
    });

    it('extends an existing active subscription (spec §2.5)', async () => {
      const user = await createUserWithBalance(TEST_COST_MICRODOLLARS * 2);
      await seedInventoryKey(TEST_PROVIDER_ID);

      // First subscription
      const result1 = await subscribeToCodingPlan(user.id, TEST_PROVIDER_ID);

      const [sub1] = await db
        .select()
        .from(coding_plan_subscriptions)
        .where(eq(coding_plan_subscriptions.id, result1.subscriptionId));
      const originalEnd = sub1.current_period_end;

      // Second subscription = extension
      await subscribeToCodingPlan(user.id, TEST_PROVIDER_ID);

      const [sub2] = await db
        .select()
        .from(coding_plan_subscriptions)
        .where(eq(coding_plan_subscriptions.id, result1.subscriptionId));

      // Period end should be extended (stacked)
      expect(new Date(sub2.current_period_end!).getTime()).toBeGreaterThan(
        new Date(originalEnd!).getTime()
      );

      // Two credit transactions (one for initial, one for extension)
      const txns = await db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.kilo_user_id, user.id));
      expect(txns).toHaveLength(2);

      // Only one BYOK key (no duplicate)
      const byokKeys = await db
        .select()
        .from(byok_api_keys)
        .where(eq(byok_api_keys.kilo_user_id, user.id));
      expect(byokKeys).toHaveLength(1);
    });

    it('re-subscribes after cancellation', async () => {
      const user = await createUserWithBalance(TEST_COST_MICRODOLLARS * 2);
      await seedInventoryKey(TEST_PROVIDER_ID);
      await seedInventoryKey(TEST_PROVIDER_ID); // need a second key

      // Subscribe
      const result1 = await subscribeToCodingPlan(user.id, TEST_PROVIDER_ID);

      // Immediately cancel
      await cancelCodingPlanImmediately(user.id, TEST_PROVIDER_ID);

      // Re-subscribe
      const result2 = await subscribeToCodingPlan(user.id, TEST_PROVIDER_ID);

      // Should reuse the same subscription row
      expect(result2.subscriptionId).toBe(result1.subscriptionId);

      const [sub] = await db
        .select()
        .from(coding_plan_subscriptions)
        .where(eq(coding_plan_subscriptions.id, result2.subscriptionId));
      expect(sub.status).toBe('active');
      expect(sub.byok_key_id).not.toBeNull();
      // canceled_at should be preserved for audit history
      expect(sub.canceled_at).not.toBeNull();
    });

    it('works with free plan (cost = 0)', async () => {
      const freeProvider = 'zai-coding';
      process.env['CODING_PLAN_PRICE_ZAI_CODING'] = '0';

      try {
        const user = await createUserWithBalance(0); // zero balance is fine for free
        await seedInventoryKey(freeProvider);

        const result = await subscribeToCodingPlan(user.id, freeProvider);

        const [sub] = await db
          .select()
          .from(coding_plan_subscriptions)
          .where(eq(coding_plan_subscriptions.id, result.subscriptionId));
        expect(sub.status).toBe('active');
        expect(sub.cost_microdollars).toBe(0);

        // No credit transactions for free plan
        const txns = await db
          .select()
          .from(credit_transactions)
          .where(eq(credit_transactions.kilo_user_id, user.id));
        expect(txns).toHaveLength(0);
      } finally {
        delete process.env['CODING_PLAN_PRICE_ZAI_CODING'];
      }
    });
  });

  describe('cancelCodingPlanSubscription', () => {
    it('sets cancel_at_period_end flag', async () => {
      const user = await createUserWithBalance(TEST_COST_MICRODOLLARS);
      await seedInventoryKey(TEST_PROVIDER_ID);

      const result = await subscribeToCodingPlan(user.id, TEST_PROVIDER_ID);
      await cancelCodingPlanSubscription(user.id, TEST_PROVIDER_ID);

      const [sub] = await db
        .select()
        .from(coding_plan_subscriptions)
        .where(eq(coding_plan_subscriptions.id, result.subscriptionId));
      expect(sub.status).toBe('active'); // still active until period end
      expect(sub.cancel_at_period_end).toBe(true);
    });

    it('throws when no active subscription exists', async () => {
      const user = await createUserWithBalance(0);
      await expect(cancelCodingPlanSubscription(user.id, TEST_PROVIDER_ID)).rejects.toThrow(
        'No active subscription'
      );
    });
  });

  describe('cancelCodingPlanImmediately', () => {
    it('cancels immediately and removes BYOK key', async () => {
      const user = await createUserWithBalance(TEST_COST_MICRODOLLARS);
      await seedInventoryKey(TEST_PROVIDER_ID);

      const result = await subscribeToCodingPlan(user.id, TEST_PROVIDER_ID);
      await cancelCodingPlanImmediately(user.id, TEST_PROVIDER_ID);

      const [sub] = await db
        .select()
        .from(coding_plan_subscriptions)
        .where(eq(coding_plan_subscriptions.id, result.subscriptionId));
      expect(sub.status).toBe('canceled');
      expect(sub.canceled_at).not.toBeNull();
      expect(sub.byok_key_id).toBeNull();

      // BYOK key removed
      const byokKeys = await db
        .select()
        .from(byok_api_keys)
        .where(eq(byok_api_keys.kilo_user_id, user.id));
      expect(byokKeys).toHaveLength(0);
    });
  });

  describe('uploadKeysToInventory', () => {
    it('encrypts and inserts keys', async () => {
      const result = await uploadKeysToInventory(TEST_PROVIDER_ID, ['key-1', 'key-2', 'key-3']);
      expect(result.inserted).toBe(3);

      const counts = await getKeyInventoryCounts(TEST_PROVIDER_ID);
      expect(counts).toHaveLength(1);
      expect(counts[0].available).toBe(3);
      expect(counts[0].assigned).toBe(0);
    });
  });

  describe('getKeyInventoryCounts', () => {
    it('returns counts per provider', async () => {
      await uploadKeysToInventory(TEST_PROVIDER_ID, ['key-1', 'key-2']);
      await uploadKeysToInventory('zai-coding', ['key-3']);

      const counts = await getKeyInventoryCounts();
      expect(counts.length).toBeGreaterThanOrEqual(2);

      const bytePlusCounts = counts.find(c => c.providerId === TEST_PROVIDER_ID);
      expect(bytePlusCounts?.available).toBe(2);
      expect(bytePlusCounts?.assigned).toBe(0);

      const zaiCounts = counts.find(c => c.providerId === 'zai-coding');
      expect(zaiCounts?.available).toBe(1);
    });

    it('filters by providerId when specified', async () => {
      await uploadKeysToInventory(TEST_PROVIDER_ID, ['key-1']);
      await uploadKeysToInventory('zai-coding', ['key-2']);

      const counts = await getKeyInventoryCounts(TEST_PROVIDER_ID);
      expect(counts).toHaveLength(1);
      expect(counts[0].providerId).toBe(TEST_PROVIDER_ID);
    });
  });
});
