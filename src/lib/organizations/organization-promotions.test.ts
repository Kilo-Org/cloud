import { db } from '@/lib/drizzle';
import {
  organizations,
  organization_memberships,
  credit_transactions,
  organization_audit_logs,
} from '@/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { processTopupForOrganization } from '@/lib/organizations/organization-billing';
import { eq } from 'drizzle-orm';
import type { User, Organization } from '@/db/schema';

// Mock the Stripe function to avoid API calls in tests
jest.mock('@/lib/stripe', () => ({
  hasPaymentMethodInStripe: jest.fn().mockResolvedValue(true),
  createStripeCustomer: jest.fn().mockResolvedValue({ id: 'cus_mock_123' }),
  client: {
    customers: {
      create: jest.fn().mockResolvedValue({ id: 'cus_mock_123' }),
    },
  },
}));

describe('Organization Promotions', () => {
  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(credit_transactions);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_audit_logs);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_memberships);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
  });

  const createTestOrg = async (user: User): Promise<Organization> => {
    const org = await db
      .insert(organizations)
      .values({
        name: 'Test Org',
        created_by_kilo_user_id: user.id,
        stripe_customer_id: 'cus_test_123',
      })
      .returning();
    return org[0];
  };

  const addOrganizationMember = async (orgId: string, userId: string): Promise<void> => {
    await db.insert(organization_memberships).values({
      organization_id: orgId,
      kilo_user_id: userId,
      role: 'member',
      invited_by: userId,
    });
  };

  const getOrganizationTransactions = async (orgId: string) => {
    return await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.organization_id, orgId))
      .orderBy(credit_transactions.created_at);
  };

  const getOrganizationBalance = async (orgId: string) => {
    const org = await db
      .select({
        microdollars_balance: organizations.microdollars_balance,
        total_microdollars_acquired: organizations.total_microdollars_acquired,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    return org[0]?.microdollars_balance || 0;
  };

  const getOrganizationTotalAcquired = async (orgId: string) => {
    const org = await db
      .select({ total_microdollars_acquired: organizations.total_microdollars_acquired })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    return org[0]?.total_microdollars_acquired || 0;
  };

  const expectPaymentTransaction = (
    transactions: (typeof credit_transactions.$inferSelect)[],
    paymentId: string,
    expectedAmountMicrodollars: number,
    orgId: string
  ) => {
    const payment = transactions.find(t => t.stripe_payment_id === paymentId);
    expect(payment).toBeDefined();
    expect(payment?.amount_microdollars).toBe(expectedAmountMicrodollars);
    expect(payment?.is_free).toBe(false);
    expect(payment?.organization_id).toBe(orgId);
  };

  const expectBonusTransaction = (
    transactions: (typeof credit_transactions.$inferSelect)[],
    expectedCount: number = 1,
    orgId?: string
  ) => {
    const bonusTransactions = transactions.filter(
      t => t.is_free && t.credit_category === 'team-topup-bonus-2025'
    );
    expect(bonusTransactions).toHaveLength(expectedCount);
    if (expectedCount > 0) {
      expect(bonusTransactions[0].amount_microdollars).toBe(20000000); // $20 bonus
      expect(bonusTransactions[0].is_free).toBe(true);
      if (orgId) {
        expect(bonusTransactions[0].organization_id).toBe(orgId);
      }
    }
  };

  test('org receives bonus credit on topup with team members', async () => {
    const user = await insertTestUser();
    const org = await createTestOrg(user);
    const member = await insertTestUser();
    await addOrganizationMember(org.id, user.id); // Creator
    await addOrganizationMember(org.id, member.id); // Additional member

    const initialBalance = await getOrganizationBalance(org.id);
    await processTopupForOrganization(user.id, org.id, 1000, {
      type: 'stripe',
      stripe_payment_id: 'pi_test_123',
    });

    // Check organization transactions
    const transactions = await getOrganizationTransactions(org.id);
    expect(transactions).toHaveLength(2); // payment + bonus
    expectPaymentTransaction(transactions, 'pi_test_123', 10000000, org.id);
    expectBonusTransaction(transactions, 1, org.id);

    // Check organization balance increased by payment + bonus
    const finalBalance = await getOrganizationBalance(org.id);
    expect(finalBalance).toBe(initialBalance + 10000000 + 20000000); // $10 payment + $20 bonus

    // total_microdollars_acquired should also increase by payment + bonus
    const totalAcquired = await getOrganizationTotalAcquired(org.id);
    expect(totalAcquired).toBe(10000000 + 20000000); // $10 payment + $20 bonus
  });

  test('org does NOT receive bonus credit when requirement fails (memberCount = 1)', async () => {
    const user = await insertTestUser();
    const org = await createTestOrg(user);
    await addOrganizationMember(org.id, user.id); // Only creator, no additional members

    const initialBalance = await getOrganizationBalance(org.id);
    await processTopupForOrganization(user.id, org.id, 1000, {
      type: 'stripe',
      stripe_payment_id: 'pi_test_123',
    });

    // Check organization transactions
    const transactions = await getOrganizationTransactions(org.id);
    expect(transactions).toHaveLength(1); // only payment, no bonus
    expectPaymentTransaction(transactions, 'pi_test_123', 10000000, org.id);
    expectBonusTransaction(transactions, 0);

    // Check organization balance increased by payment only
    const finalBalance = await getOrganizationBalance(org.id);
    expect(finalBalance).toBe(initialBalance + 10000000); // $10 payment only

    // total_microdollars_acquired should also increase by payment only
    const totalAcquired = await getOrganizationTotalAcquired(org.id);
    expect(totalAcquired).toBe(10000000); // $10 payment only
  });

  test('org promotion idempotency: same user multiple topups - bonus granted only once', async () => {
    const user = await insertTestUser();
    const org = await createTestOrg(user);
    const member = await insertTestUser();
    await addOrganizationMember(org.id, user.id); // Creator
    await addOrganizationMember(org.id, member.id); // Additional member

    const initialBalance = await getOrganizationBalance(org.id);

    // First and second topups from same user
    await processTopupForOrganization(user.id, org.id, 1000, {
      type: 'stripe',
      stripe_payment_id: 'pi_test_first',
    });
    await processTopupForOrganization(user.id, org.id, 2000, {
      type: 'stripe',
      stripe_payment_id: 'pi_test_second',
    });

    // Check organization transactions
    const transactions = await getOrganizationTransactions(org.id);
    expect(transactions).toHaveLength(3); // payment1 + bonus + payment2

    expectPaymentTransaction(transactions, 'pi_test_first', 10000000, org.id);
    expectPaymentTransaction(transactions, 'pi_test_second', 20000000, org.id);
    expectBonusTransaction(transactions, 1, org.id); // Only one bonus despite two topups

    // Check organization balance increased by both payments + one bonus
    const finalBalance = await getOrganizationBalance(org.id);
    expect(finalBalance).toBe(initialBalance + 10000000 + 20000000 + 20000000); // $10 + $20 payments + $20 bonus

    // total_microdollars_acquired should also increase by both payments + one bonus
    const totalAcquired = await getOrganizationTotalAcquired(org.id);
    expect(totalAcquired).toBe(10000000 + 20000000 + 20000000); // $10 + $20 payments + $20 bonus
  });

  test('org promotion idempotency: cross-user test - bonus granted only once even when different users topup', async () => {
    const userA = await insertTestUser();
    const userB = await insertTestUser();
    const org = await createTestOrg(userA);
    await addOrganizationMember(org.id, userA.id);
    await addOrganizationMember(org.id, userB.id); // 2+ members

    const initialBalance = await getOrganizationBalance(org.id);

    // User A tops up
    await processTopupForOrganization(userA.id, org.id, 1000, {
      type: 'stripe',
      stripe_payment_id: 'pi_user_a',
    });

    // User B tops up (different user, same organization)
    await processTopupForOrganization(userB.id, org.id, 1000, {
      type: 'stripe',
      stripe_payment_id: 'pi_user_b',
    });

    // Verify only ONE bonus was granted
    const transactions = await getOrganizationTransactions(org.id);
    expect(transactions).toHaveLength(3); // payment1 + bonus + payment2
    expectPaymentTransaction(transactions, 'pi_user_a', 10000000, org.id);
    expectPaymentTransaction(transactions, 'pi_user_b', 10000000, org.id);
    expectBonusTransaction(transactions, 1, org.id); // ONLY ONE bonus

    // Check organization balance: two payments + one bonus
    const finalBalance = await getOrganizationBalance(org.id);
    expect(finalBalance).toBe(initialBalance + 10000000 + 10000000 + 20000000); // $10 + $10 + $20

    // total_microdollars_acquired should also increase by two payments + one bonus
    const totalAcquired = await getOrganizationTotalAcquired(org.id);
    expect(totalAcquired).toBe(10000000 + 10000000 + 20000000); // $10 + $10 + $20
  });
});
