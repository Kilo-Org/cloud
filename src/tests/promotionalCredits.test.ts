import { describe, it, expect } from '@jest/globals';
import {
  grantCreditForCategory,
  grantCreditForCategoryConfig,
  redeemSelfServicePromoCode,
} from '../lib/promotionalCredits';
import type { PromoCreditCategoryConfig } from '../lib/PromoCreditCategoryConfig';
import { type User, credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { defineTestUser, insertTestUser } from './helpers/user.helper';
import { db } from '../lib/drizzle';
import { eq, desc } from 'drizzle-orm';
import { millisecondsInDay, millisecondsInHour } from 'date-fns/constants';
import { assertNoError } from '@/lib/maybe-result';

describe('grantCreditForCategory', () => {
  const mockUser: User = defineTestUser({});

  it('should not allow a non-user-redeemable promo code on user redemption', async () => {
    const result = await redeemSelfServicePromoCode(mockUser, 'pull_request');
    expect(result.success).toBe(false);
  });

  it('should return error for non-existent credit category', async () => {
    const result = await grantCreditForCategory(mockUser, {
      credit_category: 'non-existent-category',
      counts_as_selfservice: false,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('should successfully grant credits for valid category', async () => {
    const result = await grantCreditForCategory(mockUser, {
      credit_category: 'vibeday',
      counts_as_selfservice: false,
    });
    expect(result.message).toContain('Successfully added');
    expect(result.success).toBe(true);
  });

  it('should require amount for custom category', async () => {
    const result = await grantCreditForCategory(mockUser, {
      credit_category: 'custom',
      counts_as_selfservice: false,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Missing required amount_usd');
  });

  it('should grant custom category with amount', async () => {
    const result = await grantCreditForCategory(mockUser, {
      credit_category: 'custom',
      amount_usd: 25,
      counts_as_selfservice: false,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('Successfully added');
  });

  it('should grant valid self-serviceable promo codes', async () => {
    const freshUser: User = await insertTestUser();

    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 1);

    const validPromoConfig: PromoCreditCategoryConfig = {
      credit_category: 'MCPJULY',
      is_user_selfservicable: true,
      is_idempotent: true,
      amount_usd: 100,
      promotion_ends_at: futureDate,
      total_redemptions_allowed: 10,
    };

    const result = await grantCreditForCategoryConfig(
      { organization: null, user: freshUser },
      {
        credit_category: 'MCPJULY',
        counts_as_selfservice: true,
      },
      validPromoConfig
    );

    expect(result.success).toBe(true);
  });

  it('should reject expired self-serviceable promo codes', async () => {
    const pastDate = new Date();
    pastDate.setFullYear(pastDate.getFullYear() - 1);

    const expiredPromoConfig: PromoCreditCategoryConfig = {
      credit_category: 'MCPJULY',
      is_user_selfservicable: true,
      is_idempotent: true,
      amount_usd: 100,
      promotion_ends_at: pastDate,
      total_redemptions_allowed: 10,
    };

    const result = await grantCreditForCategoryConfig(
      { organization: null, user: mockUser },
      {
        credit_category: 'MCPJULY',
        counts_as_selfservice: true,
      },
      expiredPromoConfig
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('expired');
  });

  it('should reject non-self-serviceable promo codes when counts_as_selfservice is true', async () => {
    const nonSelfServiceableConfig: PromoCreditCategoryConfig = {
      credit_category: 'vibeday',
      amount_usd: 50,
    };

    const result = await grantCreditForCategoryConfig(
      { organization: null, user: mockUser },
      {
        credit_category: 'vibeday',
        counts_as_selfservice: true,
      },
      nonSelfServiceableConfig
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid promotional code');
  });

  it('should handle idempotent categories', async () => {
    const freshUser: User = await insertTestUser();

    // First call should succeed
    const firstResult = await grantCreditForCategory(freshUser, {
      credit_category: 'stytch-validation',
      counts_as_selfservice: false,
    });
    expect(firstResult.success).toBe(true);

    // Second call should fail due to idempotency
    const secondResult = await grantCreditForCategory(freshUser, {
      credit_category: 'stytch-validation',
      counts_as_selfservice: false,
    });
    expect(secondResult.success).toBe(false);
    expect(secondResult.message).toContain('already been applied');
  });

  it('should enforce total_redemptions_allowed limit', async () => {
    const promoConfigWithLimit: PromoCreditCategoryConfig = {
      credit_category: 'LIMITED_PROMO',
      amount_usd: 10,
      total_redemptions_allowed: 3,
    };

    const results = [];
    for (let i = 0; i < 5; i++) {
      const user = await insertTestUser();
      const options = { credit_category: 'LIMITED_PROMO', counts_as_selfservice: false };
      const result = await grantCreditForCategoryConfig(
        { organization: null, user },
        options,
        promoConfigWithLimit
      );
      results.push(result);
    }

    // First 3 should succeed
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);
    expect(results[2].success).toBe(true);

    // Last 2 should fail due to redemption limit
    expect(results[3].success).toBe(false);
    expect(results[3].message).toContain('reached its redemption limit');
    expect(results[4].success).toBe(false);
    expect(results[4].message).toContain('reached its redemption limit');
  });

  it('should use expiry_hours when set', async () => {
    const promoConfigWithExpiryHours: PromoCreditCategoryConfig = {
      credit_category: 'EXPIRY_HOURS_TEST',
      amount_usd: 10,
      expiry_hours: 24,
    };

    const user = await insertTestUser();
    const options = { credit_category: 'EXPIRY_HOURS_TEST', counts_as_selfservice: false };

    const beforeTime = new Date();
    const result = await grantCreditForCategoryConfig(
      { organization: null, user },
      options,
      promoConfigWithExpiryHours
    );
    assertNoError(result);

    // Query the database to verify the expiry date using credit_category
    const creditTransaction = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.credit_category, 'EXPIRY_HOURS_TEST'))
      .orderBy(desc(credit_transactions.created_at))
      .limit(1);

    expect(creditTransaction).toHaveLength(1);
    expect(creditTransaction[0].original_transaction_id).toBeDefined();
    expect(creditTransaction[0].expiry_date).toBeDefined();
    expect(creditTransaction[0].expiry_date).not.toBeNull();

    const expiryDate = new Date(creditTransaction[0].expiry_date!);

    // Verify the expiry date is approximately 24 hours from now
    const hoursDiff = (expiryDate.getTime() - beforeTime.getTime()) / millisecondsInHour;
    expect(hoursDiff).toBeCloseTo(24, 1); // Within 0.1 hours (6 minutes)

    // Verify next_credit_expiration_at is set on the user
    const updatedUser = await db
      .select({ next_credit_expiration_at: kilocode_users.next_credit_expiration_at })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id))
      .limit(1);
    expect(updatedUser[0].next_credit_expiration_at).not.toBeNull();
    const userExpiry = new Date(updatedUser[0].next_credit_expiration_at!);
    expect(userExpiry.getTime()).toBeCloseTo(expiryDate.getTime(), -3); // Within 1000ms
  });

  it('should update next_credit_expiration_at to earlier date when granting credit with earlier expiry', async () => {
    const user = await insertTestUser();

    // Grant first credit with 48h expiry
    const firstConfig: PromoCreditCategoryConfig = {
      credit_category: 'FIRST_EXPIRY_TEST',
      amount_usd: 10,
      expiry_hours: 48,
    };
    await grantCreditForCategoryConfig(
      { organization: null, user },
      { credit_category: 'FIRST_EXPIRY_TEST', counts_as_selfservice: false },
      firstConfig
    );

    // Get the next_credit_expiration_at after first grant
    const afterFirst = await db
      .select({ next_credit_expiration_at: kilocode_users.next_credit_expiration_at })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id))
      .limit(1);
    const firstExpiry = new Date(afterFirst[0].next_credit_expiration_at!);
    expect(afterFirst[0].next_credit_expiration_at).not.toBeNull();

    // Grant second credit with 24h expiry (earlier than first)
    const secondConfig: PromoCreditCategoryConfig = {
      credit_category: 'SECOND_EXPIRY_TEST',
      amount_usd: 10,
      expiry_hours: 24,
    };
    await grantCreditForCategoryConfig(
      { organization: null, user },
      { credit_category: 'SECOND_EXPIRY_TEST', counts_as_selfservice: false },
      secondConfig
    );

    // Verify next_credit_expiration_at is updated to the earlier date
    const afterSecond = await db
      .select({ next_credit_expiration_at: kilocode_users.next_credit_expiration_at })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id))
      .limit(1);
    const secondExpiry = new Date(afterSecond[0].next_credit_expiration_at!);
    expect(secondExpiry.getTime()).toBeLessThan(firstExpiry.getTime());
  });

  it('should use earlier date between credit_expiry_date and expiry_hours', async () => {
    const futureDate = new Date();
    futureDate.setHours(futureDate.getHours() + 48);
    const promoConfigWithBoth: PromoCreditCategoryConfig = {
      credit_category: 'BOTH_EXPIRY_TEST',
      amount_usd: 10,
      credit_expiry_date: futureDate,
      expiry_hours: 1, // should be earlier than futureDate
    };

    const user = await insertTestUser();
    const options = { credit_category: 'BOTH_EXPIRY_TEST', counts_as_selfservice: false };

    const beforeTime = new Date();
    const result = await grantCreditForCategoryConfig(
      { organization: null, user },
      options,
      promoConfigWithBoth
    );
    assertNoError(result);

    // Query the database to verify the expiry date using credit_category
    const creditTransaction = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.credit_category, 'BOTH_EXPIRY_TEST'))
      .orderBy(desc(credit_transactions.created_at))
      .limit(1);

    expect(creditTransaction).toHaveLength(1);
    expect(creditTransaction[0].original_transaction_id).toBeDefined();
    expect(creditTransaction[0].expiry_date).toBeDefined();

    const expiryDate = new Date(creditTransaction[0].expiry_date!);

    // Should use the earlier date (now + 1 hour) instead of the future date
    // Allow for some processing time variance (up to 1 second)
    const expectedExpiry = new Date(beforeTime.getTime() + millisecondsInHour);
    expect(expiryDate.getTime()).toBeCloseTo(expectedExpiry.getTime(), -3); // Within 1000ms
    expect(expiryDate.getTime()).toBeLessThan(futureDate.getTime());
  });

  it('should use credit_expiry_date when it is earlier than expiry_hours', async () => {
    const nearDate = new Date();
    nearDate.setMinutes(nearDate.getMinutes() + 30);

    const promoConfigWithEarlyExpiry: PromoCreditCategoryConfig = {
      credit_category: 'EARLIER_EXPIRY_DATE_TEST',
      amount_usd: 10,
      credit_expiry_date: nearDate,
      expiry_hours: 24, // should be later than nearDate
    };

    const user = await insertTestUser();
    const options = { credit_category: 'EARLIER_EXPIRY_DATE_TEST', counts_as_selfservice: false };

    const result = await grantCreditForCategoryConfig(
      { organization: null, user },
      options,
      promoConfigWithEarlyExpiry
    );
    assertNoError(result);

    // Query the database to verify the expiry date using credit_category
    const creditTransaction = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.credit_category, 'EARLIER_EXPIRY_DATE_TEST'))
      .orderBy(desc(credit_transactions.created_at))
      .limit(1);

    expect(creditTransaction).toHaveLength(1);
    expect(creditTransaction[0].original_transaction_id).toBeDefined();
    expect(creditTransaction[0].expiry_date).toBeDefined();

    const expiryDate = new Date(creditTransaction[0].expiry_date!);

    expect(expiryDate.getTime()).toBeCloseTo(nearDate.getTime(), -3); // Within 1000ms
  });

  it('should work with only expiry_hours and no credit_expiry_date', async () => {
    const promoConfigOnlyExpiryHours: PromoCreditCategoryConfig = {
      credit_category: 'ONLY_EXPIRY_HOURS_TEST',
      amount_usd: 10,
      expiry_hours: 48,
    };

    const user = await insertTestUser();
    const options = { credit_category: 'ONLY_EXPIRY_HOURS_TEST', counts_as_selfservice: false };

    const beforeTime = new Date();
    const result = await grantCreditForCategoryConfig(
      { organization: null, user },
      options,
      promoConfigOnlyExpiryHours
    );
    assertNoError(result);

    const creditTransaction = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.credit_category, 'ONLY_EXPIRY_HOURS_TEST'))
      .orderBy(desc(credit_transactions.created_at))
      .limit(1);

    expect(creditTransaction).toHaveLength(1);
    expect(creditTransaction[0].original_transaction_id).toBeDefined();
    expect(creditTransaction[0].expiry_date).toBeDefined();

    const expiryDate = new Date(creditTransaction[0].expiry_date!);
    const expectedExpiry = new Date(beforeTime.getTime() + 2 * millisecondsInDay);
    expect(expiryDate.getTime()).toBeCloseTo(expectedExpiry.getTime(), -3); // Within 1000ms
  });
});
