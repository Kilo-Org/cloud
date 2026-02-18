import { db } from '@/lib/drizzle';
import {
  microdollar_usage,
  microdollar_usage_metadata,
  payment_methods,
  kilocode_users,
  user_auth_provider,
  credit_transactions,
  kilo_pass_subscriptions,
  kilo_pass_issuances,
  kilo_pass_issuance_items,
  enrichment_data,
  referral_codes,
  referral_code_usages,
  organization_memberships,
  organization_user_limits,
  organization_user_usage,
  free_model_usage,
  organizations,
} from '@/db/schema';
import { eq, count, sql } from 'drizzle-orm';
import { deleteUserDatabaseRecords, findUserById, findUsersByIds } from './user';
import { createTestPaymentMethod } from '@/tests/helpers/payment-method.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { insertUsageWithOverrides } from '@/tests/helpers/microdollar-usage.helper';
import { forceImmediateExpirationRecomputation } from '@/lib/balanceCache';
import { randomUUID } from 'crypto';
import {
  KiloPassCadence,
  KiloPassIssuanceItemKind,
  KiloPassIssuanceSource,
  KiloPassTier,
} from '@/lib/kilo-pass/enums';

describe('User', () => {
  // Shared cleanup for all tests in this suite to prevent data pollution
  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(user_auth_provider);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(microdollar_usage_metadata);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(microdollar_usage);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(payment_methods);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(kilo_pass_issuance_items);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(kilo_pass_issuances);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(kilo_pass_subscriptions);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(credit_transactions);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(enrichment_data);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(referral_code_usages);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(referral_codes);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_user_usage);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_user_limits);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_memberships);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(free_model_usage);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(kilocode_users);
  });

  describe('deleteUserDatabaseRecords', () => {
    it('should delete all records for a specific user', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();
      const user3 = await insertTestUser();

      // Create MicrodollarUsage records (also creates microdollar_usage_metadata)
      await insertUsageWithOverrides({ kilo_user_id: user1.id });
      await insertUsageWithOverrides({ kilo_user_id: user1.id });
      await insertUsageWithOverrides({ kilo_user_id: user2.id });
      await insertUsageWithOverrides({ kilo_user_id: user3.id });

      // Create PaymentMethod records
      const pm1a = createTestPaymentMethod(user1.id);
      const pm1b = createTestPaymentMethod(user1.id);
      const pm2a = createTestPaymentMethod(user2.id);
      const pm3a = createTestPaymentMethod(user3.id);

      await db.insert(payment_methods).values([pm1a, pm1b, pm2a, pm3a]);

      // Verify initial state
      expect((await db.select({ count: count() }).from(kilocode_users))[0].count).toBe(3);
      expect(
        await db
          .select({ count: count() })
          .from(microdollar_usage)
          .then((r: { count: number }[]) => r[0].count)
      ).toBe(4);
      expect((await db.select({ count: count() }).from(payment_methods))[0].count).toBe(4);

      await deleteUserDatabaseRecords(user1.id);

      expect(await findUserById(user1.id)).toBe(undefined);
      expect(
        await db.query.microdollar_usage.findMany({
          where: eq(microdollar_usage.kilo_user_id, user1.id),
        })
      ).toHaveLength(0);

      expect(
        await db.query.payment_methods.findMany({
          where: eq(payment_methods.user_id, user1.id),
        })
      ).toHaveLength(0);

      // Verify other users' records remain
      expect(
        await db
          .select({ count: count() })
          .from(kilocode_users)
          .then(r => r[0].count)
      ).toBe(2);
      expect(
        await db
          .select({ count: count() })
          .from(microdollar_usage)
          .then(r => r[0].count)
      ).toBe(2);
      expect(await findUserById(user2.id)).not.toBeNull();
      expect(await findUserById(user3.id)).not.toBeNull();
      expect(
        await db
          .select()
          .from(microdollar_usage)
          .where(eq(microdollar_usage.kilo_user_id, user2.id))
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(microdollar_usage)
          .where(eq(microdollar_usage.kilo_user_id, user3.id))
      ).toHaveLength(1);

      expect(
        await db.select().from(payment_methods).where(eq(payment_methods.user_id, user2.id))
      ).toHaveLength(1);
      expect(
        await db.select().from(payment_methods).where(eq(payment_methods.user_id, user3.id))
      ).toHaveLength(1);
    });

    it('should handle deletion of non-existent user gracefully', async () => {
      const user1 = await insertTestUser();
      await insertUsageWithOverrides({ kilo_user_id: user1.id });

      // Verify initial state
      expect(
        await db
          .select({ count: count() })
          .from(kilocode_users)
          .then(r => r[0].count)
      ).toBe(1);
      expect(
        await db
          .select({ count: count() })
          .from(microdollar_usage)
          .then(r => r[0].count)
      ).toBe(1);

      // Try to delete non-existent user
      await expect(deleteUserDatabaseRecords('non-existent-user')).resolves.not.toThrow();

      // Verify existing data is unchanged
      expect(
        await db
          .select({ count: count() })
          .from(kilocode_users)
          .then(r => r[0].count)
      ).toBe(1);
      expect(
        await db
          .select({ count: count() })
          .from(microdollar_usage)
          .then(r => r[0].count)
      ).toBe(1);
      expect(await findUserById(user1.id)).not.toBeUndefined();
    });

    it('should delete user with no related records', async () => {
      const user1 = await insertTestUser();

      // Verify initial state
      expect(
        await db
          .select({ count: count() })
          .from(kilocode_users)
          .then(r => r[0].count)
      ).toBe(1);
      expect(
        await db
          .select({ count: count() })
          .from(microdollar_usage)
          .then((r: { count: number }[]) => r[0].count)
      ).toBe(0);
      expect((await db.select({ count: count() }).from(payment_methods))[0].count).toBe(0);

      // Delete the user
      await deleteUserDatabaseRecords(user1.id);

      // Verify user is deleted
      expect(
        await db
          .select({ count: count() })
          .from(kilocode_users)
          .then(r => r[0].count)
      ).toBe(0);
      expect(await findUserById(user1.id)).toBe(undefined);
    });

    it('should delete user with only some types of related records', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();

      // User1 has only MicrodollarUsage and PaymentMethod records
      await insertUsageWithOverrides({ kilo_user_id: user1.id });
      const pm1 = createTestPaymentMethod(user1.id);
      await db.insert(payment_methods).values(pm1);

      expect(
        await db
          .select({ count: count() })
          .from(kilocode_users)
          .then(r => r[0].count)
      ).toBe(2);
      expect(
        await db
          .select({ count: count() })
          .from(microdollar_usage)
          .then((r: { count: number }[]) => r[0].count)
      ).toBe(1);
      expect((await db.select({ count: count() }).from(payment_methods))[0].count).toBe(1);

      await deleteUserDatabaseRecords(user1.id);

      expect(await findUserById(user1.id)).toBe(undefined);
      expect(
        await db.query.microdollar_usage.findMany({
          where: eq(microdollar_usage.kilo_user_id, user1.id),
        })
      ).toHaveLength(0);
      expect(
        await db.query.payment_methods.findMany({
          where: eq(payment_methods.user_id, user1.id),
        })
      ).toHaveLength(0);

      expect(
        await db
          .select({ count: count() })
          .from(kilocode_users)
          .then(r => r[0].count)
      ).toBe(1);
      expect(await findUserById(user2.id)).not.toBeUndefined();
    });

    it('should delete user with Kilo Pass subscription and issuance items', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();

      // Create a credit transaction for user1 (linked to Kilo Pass issuance)
      const creditTxId = randomUUID();
      await db.insert(credit_transactions).values({
        id: creditTxId,
        kilo_user_id: user1.id,
        amount_microdollars: 19_000_000,
        is_free: false,
        description: 'Kilo Pass base credits',
        credit_category: 'kilo_pass_base',
      });

      // Create a credit transaction for user2 (should not be affected)
      const user2CreditTxId = randomUUID();
      await db.insert(credit_transactions).values({
        id: user2CreditTxId,
        kilo_user_id: user2.id,
        amount_microdollars: 5_000_000,
        is_free: false,
        description: 'User 2 credits',
      });

      // Create Kilo Pass subscription
      const subId = randomUUID();
      await db.insert(kilo_pass_subscriptions).values({
        id: subId,
        kilo_user_id: user1.id,
        stripe_subscription_id: `sub_test_${randomUUID()}`,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
      });

      // Create issuance
      const issuanceId = randomUUID();
      await db.insert(kilo_pass_issuances).values({
        id: issuanceId,
        kilo_pass_subscription_id: subId,
        issue_month: '2025-01-01',
        source: KiloPassIssuanceSource.StripeInvoice,
        stripe_invoice_id: `inv_test_${randomUUID()}`,
      });

      // Create issuance item with RESTRICT FK to credit_transactions
      await db.insert(kilo_pass_issuance_items).values({
        kilo_pass_issuance_id: issuanceId,
        kind: KiloPassIssuanceItemKind.Base,
        credit_transaction_id: creditTxId,
        amount_usd: 19,
      });

      // Verify initial state
      expect((await db.select({ count: count() }).from(kilo_pass_issuance_items))[0].count).toBe(1);
      expect((await db.select({ count: count() }).from(credit_transactions))[0].count).toBe(2);

      // This would fail with the old implementation due to kilo_pass_issuance_items
      // RESTRICT FK on credit_transactions.id
      await deleteUserDatabaseRecords(user1.id);

      // Verify user1 and all related records are deleted
      expect(await findUserById(user1.id)).toBe(undefined);
      expect((await db.select({ count: count() }).from(kilo_pass_issuance_items))[0].count).toBe(0);
      expect((await db.select({ count: count() }).from(kilo_pass_issuances))[0].count).toBe(0);
      expect((await db.select({ count: count() }).from(kilo_pass_subscriptions))[0].count).toBe(0);
      expect(
        await db
          .select({ count: count() })
          .from(credit_transactions)
          .where(eq(credit_transactions.kilo_user_id, user1.id))
          .then(r => r[0].count)
      ).toBe(0);

      // Verify user2's records are untouched
      expect(await findUserById(user2.id)).toBeDefined();
      expect(
        await db
          .select({ count: count() })
          .from(credit_transactions)
          .where(eq(credit_transactions.kilo_user_id, user2.id))
          .then(r => r[0].count)
      ).toBe(1);
    });

    it('should delete microdollar_usage_metadata alongside microdollar_usage', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();

      // insertUsageWithOverrides creates both microdollar_usage and microdollar_usage_metadata
      await insertUsageWithOverrides({ kilo_user_id: user1.id });
      await insertUsageWithOverrides({ kilo_user_id: user2.id });

      // Verify both tables have records
      expect((await db.select({ count: count() }).from(microdollar_usage))[0].count).toBe(2);
      expect((await db.select({ count: count() }).from(microdollar_usage_metadata))[0].count).toBe(
        2
      );

      await deleteUserDatabaseRecords(user1.id);

      // User1's records should be gone from both tables
      expect(
        await db
          .select({ count: count() })
          .from(microdollar_usage)
          .where(eq(microdollar_usage.kilo_user_id, user1.id))
          .then(r => r[0].count)
      ).toBe(0);
      // Metadata rows for user1 should also be gone (they share the same id)
      expect((await db.select({ count: count() }).from(microdollar_usage_metadata))[0].count).toBe(
        1
      );

      // User2's records should remain
      expect(
        await db
          .select({ count: count() })
          .from(microdollar_usage)
          .where(eq(microdollar_usage.kilo_user_id, user2.id))
          .then(r => r[0].count)
      ).toBe(1);
    });

    it('should delete enrichment_data for the user', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();

      await db.insert(enrichment_data).values([
        { user_id: user1.id, github_enrichment_data: { login: 'testuser1' } },
        { user_id: user2.id, github_enrichment_data: { login: 'testuser2' } },
      ]);

      expect((await db.select({ count: count() }).from(enrichment_data))[0].count).toBe(2);

      await deleteUserDatabaseRecords(user1.id);

      expect(
        await db
          .select({ count: count() })
          .from(enrichment_data)
          .where(eq(enrichment_data.user_id, user1.id))
          .then(r => r[0].count)
      ).toBe(0);
      expect(
        await db
          .select({ count: count() })
          .from(enrichment_data)
          .where(eq(enrichment_data.user_id, user2.id))
          .then(r => r[0].count)
      ).toBe(1);
    });

    it('should delete referral codes and usages for the user', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();

      await db.insert(referral_codes).values([
        { kilo_user_id: user1.id, code: 'USER1CODE' },
        { kilo_user_id: user2.id, code: 'USER2CODE' },
      ]);

      await db.insert(referral_code_usages).values({
        referring_kilo_user_id: user1.id,
        redeeming_kilo_user_id: user2.id,
        code: 'USER1CODE',
      });

      await deleteUserDatabaseRecords(user1.id);

      // User1's referral code should be deleted
      expect(
        await db
          .select({ count: count() })
          .from(referral_codes)
          .where(eq(referral_codes.kilo_user_id, user1.id))
          .then(r => r[0].count)
      ).toBe(0);

      // Referral usage involving user1 should be deleted
      expect((await db.select({ count: count() }).from(referral_code_usages))[0].count).toBe(0);

      // User2's referral code should remain
      expect(
        await db
          .select({ count: count() })
          .from(referral_codes)
          .where(eq(referral_codes.kilo_user_id, user2.id))
          .then(r => r[0].count)
      ).toBe(1);
    });

    it('should delete organization memberships and usage data for the user', async () => {
      const user1 = await insertTestUser();
      const user2 = await insertTestUser();

      // Create a minimal organization directly
      const orgId = randomUUID();
      await db.insert(organizations).values({
        id: orgId,
        name: 'Test Org',
        stripe_customer_id: `stripe-org-${orgId}`,
        created_by_kilo_user_id: user1.id,
        plan: 'enterprise' as any,
      });

      // Add both users as members
      await db.insert(organization_memberships).values([
        {
          organization_id: orgId,
          kilo_user_id: user1.id,
          role: 'owner' as any,
          joined_at: new Date().toISOString(),
        },
        {
          organization_id: orgId,
          kilo_user_id: user2.id,
          role: 'member' as any,
          joined_at: new Date().toISOString(),
        },
      ]);

      // Add usage limits and usage tracking
      await db.insert(organization_user_limits).values({
        organization_id: orgId,
        kilo_user_id: user1.id,
        limit_type: 'daily',
        microdollar_limit: 10_000_000,
      });

      await db.insert(organization_user_usage).values({
        organization_id: orgId,
        kilo_user_id: user1.id,
        usage_date: '2025-01-15',
        limit_type: 'daily',
        microdollar_usage: 5_000_000,
      });

      await deleteUserDatabaseRecords(user1.id);

      // User1's membership and usage data should be gone
      expect(
        await db
          .select({ count: count() })
          .from(organization_memberships)
          .where(eq(organization_memberships.kilo_user_id, user1.id))
          .then(r => r[0].count)
      ).toBe(0);
      expect((await db.select({ count: count() }).from(organization_user_limits))[0].count).toBe(0);
      expect((await db.select({ count: count() }).from(organization_user_usage))[0].count).toBe(0);

      // User2's membership should remain
      expect(
        await db
          .select({ count: count() })
          .from(organization_memberships)
          .where(eq(organization_memberships.kilo_user_id, user2.id))
          .then(r => r[0].count)
      ).toBe(1);
    });

    it('should delete free_model_usage for the user', async () => {
      const user1 = await insertTestUser();

      await db.insert(free_model_usage).values([
        { ip_address: '1.2.3.4', model: 'test-model', kilo_user_id: user1.id },
        { ip_address: '1.2.3.4', model: 'test-model', kilo_user_id: null },
      ]);

      expect((await db.select({ count: count() }).from(free_model_usage))[0].count).toBe(2);

      await deleteUserDatabaseRecords(user1.id);

      // User1's free model usage should be gone, anonymous record remains
      expect((await db.select({ count: count() }).from(free_model_usage))[0].count).toBe(1);
    });
  });

  describe('forceImmediateExpirationRecomputation', () => {
    afterEach(async () => {
      // eslint-disable-next-line drizzle/enforce-delete-with-where
      await db.delete(kilocode_users);
    });

    it('should set next_credit_expiration_at to now for existing user', async () => {
      const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
      const user = await insertTestUser({
        next_credit_expiration_at: futureDate,
      });

      const userBefore = await findUserById(user.id);
      expect(userBefore).toBeDefined();
      expect(new Date(userBefore!.next_credit_expiration_at!).toISOString()).toBe(futureDate);

      await forceImmediateExpirationRecomputation(user.id);

      const userAfter = await findUserById(user.id);
      expect(userAfter).toBeDefined();
      expect(new Date(userAfter!.next_credit_expiration_at!).toISOString()).not.toBe(futureDate);
      expect(userAfter!.next_credit_expiration_at).not.toBeNull();
      // Should be roughly now
      const diff = Math.abs(new Date(userAfter!.next_credit_expiration_at!).getTime() - Date.now());
      expect(diff).toBeLessThan(5000); // within 5 seconds
      expect(userAfter!.updated_at).not.toBe(userBefore!.updated_at);
    });

    it('should handle non-existent user gracefully', async () => {
      await expect(
        forceImmediateExpirationRecomputation('non-existent-user')
      ).resolves.not.toThrow();
    });

    it('should work when next_credit_expiration_at is already null', async () => {
      const user = await insertTestUser({
        next_credit_expiration_at: null,
      });

      const userBefore = await findUserById(user.id);
      expect(userBefore).toBeDefined();
      expect(userBefore!.next_credit_expiration_at).toBeNull();

      await forceImmediateExpirationRecomputation(user.id);

      const userAfter = await findUserById(user.id);
      expect(userAfter).toBeDefined();
      expect(userAfter!.next_credit_expiration_at).not.toBeNull();
      expect(userAfter!.updated_at).not.toBe(userBefore!.updated_at);
    });

    it('should only affect the specified user', async () => {
      const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
      const user1 = await insertTestUser({
        next_credit_expiration_at: futureDate,
      });
      const user2 = await insertTestUser({
        next_credit_expiration_at: futureDate,
      });

      const user1Before = await findUserById(user1.id);
      const user2Before = await findUserById(user2.id);
      expect(new Date(user1Before!.next_credit_expiration_at!).toISOString()).toBe(futureDate);
      expect(new Date(user2Before!.next_credit_expiration_at!).toISOString()).toBe(futureDate);

      await forceImmediateExpirationRecomputation(user1.id);

      const user1After = await findUserById(user1.id);
      const user2After = await findUserById(user2.id);

      expect(new Date(user1After!.next_credit_expiration_at!).toISOString()).not.toBe(futureDate);
      expect(new Date(user2After!.next_credit_expiration_at!).toISOString()).toBe(futureDate);
    });
  });

  describe('findUsersByIds', () => {
    test('should return empty Map for empty input', async () => {
      const result = await findUsersByIds([]);
      expect(result.size).toBe(0);
      expect(result).toEqual(new Map());
    });

    test('should return single user for single ID', async () => {
      const testUser = await insertTestUser({
        google_user_name: 'Single User',
        google_user_email: 'single@example.com',
      });

      const result = await findUsersByIds([testUser.id]);

      expect(result.size).toBe(1);
      const user = result.get(testUser.id);
      expect(user?.id).toBe(testUser.id);
      expect(user?.google_user_name).toBe('Single User');
      expect(user?.google_user_email).toBe('single@example.com');
    });

    test('should return multiple users for multiple IDs', async () => {
      const user1 = await insertTestUser({
        google_user_name: 'User One',
        google_user_email: 'user1@example.com',
      });

      const user2 = await insertTestUser({
        google_user_name: 'User Two',
        google_user_email: 'user2@example.com',
      });

      const user3 = await insertTestUser({
        google_user_name: 'User Three',
        google_user_email: 'user3@example.com',
      });

      const result = await findUsersByIds([user1.id, user2.id, user3.id]);

      expect(result.size).toBe(3);

      const resultIds = Array.from(result.keys()).sort();
      const expectedIds = [user1.id, user2.id, user3.id].sort();
      expect(resultIds).toEqual(expectedIds);

      // Verify each user is returned correctly
      expect(result.get(user1.id)?.google_user_name).toBe('User One');
      expect(result.get(user2.id)?.google_user_name).toBe('User Two');
      expect(result.get(user3.id)?.google_user_name).toBe('User Three');
    });

    test('should handle mix of existing and non-existent IDs', async () => {
      const existingUser = await insertTestUser({
        google_user_name: 'Existing User',
        google_user_email: 'existing@example.com',
      });

      const result = await findUsersByIds([
        existingUser.id,
        'non-existent-id-1',
        'non-existent-id-2',
      ]);

      expect(result.size).toBe(1);
      const user = result.get(existingUser.id);
      expect(user?.id).toBe(existingUser.id);
      expect(user?.google_user_name).toBe('Existing User');
    });

    test('should handle duplicate IDs', async () => {
      const testUser = await insertTestUser({
        google_user_name: 'Duplicate Test User',
        google_user_email: 'duplicate@example.com',
      });

      const result = await findUsersByIds([testUser.id, testUser.id, testUser.id]);

      expect(result.size).toBe(1);
      const user = result.get(testUser.id);
      expect(user?.id).toBe(testUser.id);
      expect(user?.google_user_name).toBe('Duplicate Test User');
    });

    test('should return empty Map for all non-existent IDs', async () => {
      const result = await findUsersByIds(['non-existent-1', 'non-existent-2', 'non-existent-3']);

      expect(result.size).toBe(0);
      expect(result).toEqual(new Map());
    });
  });
});
