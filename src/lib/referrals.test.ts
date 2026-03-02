import { referral_codes, referral_code_usages, credit_transactions } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import {
  getReferralCodeForUser,
  getReferralCodeUsages,
  processReferralTopUp,
} from '@/lib/referral';
import { eq, sql } from 'drizzle-orm';
import { referralRedeemingBonus, referralReferringBonus } from '@/lib/promoCreditCategories';
import { REFERRAL_BONUS_AMOUNT } from '@/lib/constants';
import { insertTestUser } from '@/tests/helpers/user.helper';

describe('referrals', () => {
  afterEach(async () => {
    // Clean up test data
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(referral_code_usages);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(referral_codes);
  });

  it('should not create more than 1 code per user', async () => {
    const userId = 'test-user-id';
    const [{ code: code1 }, { code: code2 }, { code: code3 }] = await Promise.all([
      getReferralCodeForUser(userId),
      getReferralCodeForUser(userId),
      getReferralCodeForUser(userId),
    ]);
    expect(code1).toBe(code2);
    expect(code1).toBe(code3);
    const rows = await db
      .select()
      .from(referral_codes)
      .where(eq(referral_codes.kilo_user_id, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe(code1);
  });

  describe('getReferralCodeUsages', () => {
    it('should return empty array when no usages exist', async () => {
      const userId = 'test-user-id';
      const usages = await getReferralCodeUsages(userId);
      expect(usages).toEqual([]);
    });
  });

  describe('processReferralTopUp', () => {
    it('should respect custom max_redemptions value when set to 2', async () => {
      const referringUserId = 'referring-user-id-custom';
      const customCode = 'custom-referral-code';

      // Insert a custom referral code with max_redemptions = 2
      await db.insert(referral_codes).values({
        kilo_user_id: referringUserId,
        code: customCode,
        max_redemptions: 2,
      });

      // Create 2 usages that have been paid out
      await db.insert(referral_code_usages).values([
        {
          code: customCode,
          redeeming_kilo_user_id: 'user-1',
          referring_kilo_user_id: referringUserId,
        },
        {
          code: customCode,
          redeeming_kilo_user_id: 'user-2',
          referring_kilo_user_id: referringUserId,
        },
      ]);

      // Simulate that the first two referrals have already been paid out
      await db
        .update(referral_code_usages)
        .set({ paid_at: sql`NOW()` })
        .where(eq(referral_code_usages.code, customCode));

      const newRedeemingUserId = 'user-3';

      // Insert a new usage record directly (simulating what would have been done by redeemReferralCode)
      await db.insert(referral_code_usages).values({
        code: customCode,
        redeeming_kilo_user_id: newRedeemingUserId,
        referring_kilo_user_id: referringUserId,
      });

      // Usage should be recorded for the new user
      const allUsages = await db
        .select()
        .from(referral_code_usages)
        .where(eq(referral_code_usages.code, customCode));

      expect(allUsages).toHaveLength(3);
      const newUsage = allUsages.find(u => u.redeeming_kilo_user_id === newRedeemingUserId);
      expect(newUsage).toBeTruthy();

      // But top-up processing should NOT grant free credits beyond max_redemptions
      await processReferralTopUp(newRedeemingUserId);

      // Verify no payout was made for the new user
      const [postProcessUsage] = await db
        .select()
        .from(referral_code_usages)
        .where(eq(referral_code_usages.redeeming_kilo_user_id, newRedeemingUserId));

      expect(postProcessUsage).toBeTruthy();
      expect(postProcessUsage.paid_at).toBeNull();
      expect(postProcessUsage.amount_usd).toBeNull();

      // And no credits were granted - check that no credit transactions exist for this user
      const creditTransactions = await db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.kilo_user_id, newRedeemingUserId));
      expect(creditTransactions).toHaveLength(0);
    });

    it('should cap paid top-ups at max_redemptions', async () => {
      const referringUserId = 'referring-user-id';
      const { code } = await getReferralCodeForUser(referringUserId);

      // Get the max_redemptions value from the database
      const referralCodeRows = await db
        .select()
        .from(referral_codes)
        .where(eq(referral_codes.code, code));

      const maxRedemptions = referralCodeRows[0].max_redemptions;

      // Create max_redemptions usages and mark them as paid (simulate successful top-ups)
      const priorUsers = Array.from({ length: maxRedemptions }, (_, i) => `user-${i}`);
      await db.insert(referral_code_usages).values(
        priorUsers.map(u => ({
          code,
          redeeming_kilo_user_id: u,
          referring_kilo_user_id: referringUserId,
        }))
      );
      await db
        .update(referral_code_usages)
        .set({ paid_at: sql`NOW()` })
        .where(eq(referral_code_usages.code, code));

      const newRedeemingUserId = 'new-redeeming-user-id';

      // Insert a new usage record directly
      await db.insert(referral_code_usages).values({
        code,
        redeeming_kilo_user_id: newRedeemingUserId,
        referring_kilo_user_id: referringUserId,
      });

      // Verify the new usage was added
      const newUserUsages = await db
        .select()
        .from(referral_code_usages)
        .where(eq(referral_code_usages.redeeming_kilo_user_id, newRedeemingUserId));
      expect(newUserUsages).toHaveLength(1);

      // But processing top-up should not grant credits or mark as paid
      await processReferralTopUp(newRedeemingUserId);

      const [finalUsage] = await db
        .select()
        .from(referral_code_usages)
        .where(eq(referral_code_usages.redeeming_kilo_user_id, newRedeemingUserId));

      expect(finalUsage.paid_at).toBeNull();
      expect(finalUsage.amount_usd).toBeNull();
    });

    it('should update updated_at when processing referral top up', async () => {
      // Create actual users in the database using insertTestUser
      const redeemingUser = await insertTestUser({
        google_user_email: 'redeeming@example.com',
        google_user_name: 'Redeeming User',
        google_user_image_url: 'https://example.com/image.jpg',
        stripe_customer_id: 'cus_test_redeeming',
      });

      const referringUser = await insertTestUser({
        google_user_email: 'referring@example.com',
        google_user_name: 'Referring User',
        google_user_image_url: 'https://example.com/image.jpg',
        stripe_customer_id: 'cus_test_referring',
      });

      const referringUserId = referringUser.id;
      const redeemingUserId = redeemingUser.id;

      // Create a referral code and usage
      const { code } = await getReferralCodeForUser(referringUserId);

      // Insert usage record directly
      await db.insert(referral_code_usages).values({
        code,
        redeeming_kilo_user_id: redeemingUserId,
        referring_kilo_user_id: referringUserId,
      });

      // Get the initial usage record
      const initialUsages = await db
        .select()
        .from(referral_code_usages)
        .where(eq(referral_code_usages.redeeming_kilo_user_id, redeemingUserId));

      expect(initialUsages).toHaveLength(1);
      const initialUsage = initialUsages[0];
      expect(initialUsage.paid_at).toBeNull();
      const initialUpdatedAt = initialUsage.updated_at;

      // Wait a small amount to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));

      // Process the referral top up
      await processReferralTopUp(redeemingUserId);

      // Verify the usage record was updated
      const updatedUsages = await db
        .select()
        .from(referral_code_usages)
        .where(eq(referral_code_usages.redeeming_kilo_user_id, redeemingUserId));

      expect(updatedUsages).toHaveLength(1);
      const updatedUsage = updatedUsages[0];

      // Verify paid_at was set
      expect(updatedUsage.paid_at).not.toBeNull();

      // Verify updated_at was updated
      expect(updatedUsage.updated_at).not.toEqual(initialUpdatedAt);
      expect(new Date(updatedUsage.updated_at).getTime()).toBeGreaterThan(
        new Date(initialUpdatedAt).getTime()
      );

      // Verify amount_usd was set
      expect(updatedUsage.amount_usd).toBe(10);

      // Verify credit transactions were created for both users
      // Check for redeeming user's credit transaction
      const redeemingUserTransactions = await db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.kilo_user_id, redeemingUserId));

      expect(redeemingUserTransactions).toHaveLength(1);
      expect(redeemingUserTransactions[0].credit_category).toBe(
        referralRedeemingBonus.credit_category
      );
      expect(redeemingUserTransactions[0].description).toContain(
        `Referral bonus for redeeming code ${code}`
      );
      expect(redeemingUserTransactions[0].is_free).toBe(true);
      expect(redeemingUserTransactions[0].amount_microdollars).toBe(10000000); // 10 USD in microdollars

      // Check for referring user's credit transaction
      const referringUserTransactions = await db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.kilo_user_id, referringUserId));

      expect(referringUserTransactions).toHaveLength(1);
      expect(referringUserTransactions[0].credit_category).toBe(
        referralReferringBonus.credit_category
      );
      expect(referringUserTransactions[0].description).toContain(
        `Referral bonus for referring user ${redeemingUserId} with code ${code}`
      );
      expect(referringUserTransactions[0].is_free).toBe(true);
      expect(referringUserTransactions[0].amount_microdollars).toBe(10000000); // 10 USD in microdollars
    });

    it('should not process referral top up if already paid', async () => {
      const referringUserId = 'referring-user-id-2';
      const redeemingUserId = 'redeeming-user-id-2';

      // Create a referral code and usage
      const { code } = await getReferralCodeForUser(referringUserId);

      // Insert usage record directly
      await db.insert(referral_code_usages).values({
        code,
        redeeming_kilo_user_id: redeemingUserId,
        referring_kilo_user_id: referringUserId,
      });

      // Manually mark as already paid
      await db
        .update(referral_code_usages)
        .set({ paid_at: sql`NOW()`, amount_usd: REFERRAL_BONUS_AMOUNT })
        .where(eq(referral_code_usages.redeeming_kilo_user_id, redeemingUserId));

      // Process the referral top up (should return early)
      await processReferralTopUp(redeemingUserId);

      // Verify no credit transactions were created for this user
      const creditTransactionsAfter = await db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.kilo_user_id, redeemingUserId));
      expect(creditTransactionsAfter).toHaveLength(0);
    });

    it('should return early when no referral code usage found', async () => {
      const nonExistentUserId = 'non-existent-user-id';

      await processReferralTopUp(nonExistentUserId);

      // Verify no credit transactions were created for this non-existent user
      const creditTransactions = await db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.kilo_user_id, nonExistentUserId));
      expect(creditTransactions).toHaveLength(0);
    });
  });
});
