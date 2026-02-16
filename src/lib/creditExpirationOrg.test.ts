import {
  credit_transactions as creditTransactionsTable,
  organizations,
  microdollar_usage,
} from '@/db/schema';
import {
  processOrganizationExpirations,
  fetchExpiringTransactionsForOrganization,
} from './creditExpiration';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization } from '@/lib/organizations/organizations';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

async function createTestOrg(
  ownerId: string,
  overrides: Partial<typeof organizations.$inferInsert> = {}
) {
  const org = await createOrganization(`test-org-${randomUUID().slice(0, 8)}`, ownerId);
  if (Object.keys(overrides).length > 0) {
    await db.update(organizations).set(overrides).where(eq(organizations.id, org.id));
  }
  return await db.query.organizations.findFirst({ where: eq(organizations.id, org.id) });
}

describe('fetchExpiringTransactionsForOrganization', () => {
  let ownerId: string;
  let orgId: string;

  beforeAll(async () => {
    const owner = await insertTestUser({
      google_user_email: `fetch-exp-org-${Date.now()}@example.com`,
    });
    ownerId = owner.id;
  });

  beforeEach(async () => {
    const org = await createTestOrg(ownerId);
    orgId = org!.id;
  });

  afterEach(async () => {
    await db
      .delete(creditTransactionsTable)
      .where(eq(creditTransactionsTable.organization_id, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  it('returns transactions with expiry dates for the org', async () => {
    await db.insert(creditTransactionsTable).values({
      kilo_user_id: ownerId,
      organization_id: orgId,
      amount_microdollars: 5_000_000,
      is_free: true,
      expiry_date: '2024-02-01T00:00:00Z',
      expiration_baseline_microdollars_used: 0,
      original_baseline_microdollars_used: 0,
      description: 'Expiring org credits',
    });

    const result = await fetchExpiringTransactionsForOrganization(orgId);
    expect(result).toHaveLength(1);
    expect(result[0].amount_microdollars).toBe(5_000_000);
    expect(new Date(result[0].expiry_date!).toISOString()).toBe('2024-02-01T00:00:00.000Z');
  });

  it('excludes already-expired transactions', async () => {
    const originalId = randomUUID();
    await db.insert(creditTransactionsTable).values([
      {
        id: originalId,
        kilo_user_id: ownerId,
        organization_id: orgId,
        amount_microdollars: 5_000_000,
        is_free: true,
        expiry_date: '2024-01-10T00:00:00Z',
        expiration_baseline_microdollars_used: 0,
        original_baseline_microdollars_used: 0,
        description: 'Already expired',
      },
      {
        kilo_user_id: ownerId,
        organization_id: orgId,
        amount_microdollars: -5_000_000,
        is_free: true,
        credit_category: 'credits_expired',
        original_transaction_id: originalId,
        original_baseline_microdollars_used: 0,
        description: 'Expiration record',
      },
    ]);

    const result = await fetchExpiringTransactionsForOrganization(orgId);
    expect(result).toHaveLength(0);
  });

  it('does not return transactions without expiry dates', async () => {
    await db.insert(creditTransactionsTable).values({
      kilo_user_id: ownerId,
      organization_id: orgId,
      amount_microdollars: 5_000_000,
      is_free: true,
      expiry_date: null,
      original_baseline_microdollars_used: 0,
      description: 'Non-expiring credits',
    });

    const result = await fetchExpiringTransactionsForOrganization(orgId);
    expect(result).toHaveLength(0);
  });

  it('does not return transactions from other orgs', async () => {
    const otherOrg = await createTestOrg(ownerId);
    await db.insert(creditTransactionsTable).values({
      kilo_user_id: ownerId,
      organization_id: otherOrg!.id,
      amount_microdollars: 5_000_000,
      is_free: true,
      expiry_date: '2024-02-01T00:00:00Z',
      expiration_baseline_microdollars_used: 0,
      original_baseline_microdollars_used: 0,
      description: 'Other org credits',
    });

    const result = await fetchExpiringTransactionsForOrganization(orgId);
    expect(result).toHaveLength(0);

    // cleanup
    await db
      .delete(creditTransactionsTable)
      .where(eq(creditTransactionsTable.organization_id, otherOrg!.id));
    await db.delete(organizations).where(eq(organizations.id, otherOrg!.id));
  });

  it('returns empty when org has no expiring transactions', async () => {
    const result = await fetchExpiringTransactionsForOrganization(orgId);
    expect(result).toHaveLength(0);
  });
});

describe('processOrganizationExpirations', () => {
  let ownerId: string;
  let orgId: string;

  beforeAll(async () => {
    const owner = await insertTestUser({
      google_user_email: `proc-exp-org-${Date.now()}@example.com`,
    });
    ownerId = owner.id;
  });

  beforeEach(async () => {
    const org = await createTestOrg(ownerId, {
      total_microdollars_acquired: 10_000_000,
      microdollars_used: 3_000_000,
      microdollars_balance: 7_000_000,
      next_credit_expiration_at: '2024-01-10T00:00:00Z',
    });
    orgId = org!.id;
  });

  afterEach(async () => {
    await db
      .delete(creditTransactionsTable)
      .where(eq(creditTransactionsTable.organization_id, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  it('creates expiration transaction and updates org columns', async () => {
    const txnId = randomUUID();
    await db.insert(creditTransactionsTable).values({
      id: txnId,
      kilo_user_id: ownerId,
      organization_id: orgId,
      amount_microdollars: 10_000_000,
      is_free: true,
      expiry_date: '2024-01-10T00:00:00Z',
      expiration_baseline_microdollars_used: 0,
      original_baseline_microdollars_used: 0,
      description: 'Expiring credits',
    });

    const result = await processOrganizationExpirations(
      {
        id: orgId,
        microdollars_used: 3_000_000,
        next_credit_expiration_at: '2024-01-10T00:00:00Z',
        total_microdollars_acquired: 10_000_000,
      },
      new Date('2024-01-15T00:00:00Z')
    );

    expect(result).not.toBeNull();
    // total_acquired should decrease by the expired amount (10M - 3M used = 7M expired)
    expect(result!.total_microdollars_acquired).toBe(10_000_000 - 7_000_000);

    // Verify expiration transaction in DB
    const expirations = await db
      .select()
      .from(creditTransactionsTable)
      .where(eq(creditTransactionsTable.credit_category, 'credits_expired'));
    expect(expirations).toHaveLength(1);
    expect(expirations[0].amount_microdollars).toBe(-7_000_000);
    expect(expirations[0].original_transaction_id).toBe(txnId);
    expect(expirations[0].organization_id).toBe(orgId);
    expect(expirations[0].kilo_user_id).toBe('system');

    // Verify org columns updated
    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
    });
    expect(updatedOrg!.total_microdollars_acquired).toBe(3_000_000);
    expect(updatedOrg!.microdollars_balance).toBe(0); // 3M acquired - 3M used
    expect(updatedOrg!.next_credit_expiration_at).toBeNull();
  });

  it('updates next_credit_expiration_at to next unprocessed expiry', async () => {
    await db.insert(creditTransactionsTable).values([
      {
        kilo_user_id: ownerId,
        organization_id: orgId,
        amount_microdollars: 5_000_000,
        is_free: true,
        expiry_date: '2024-01-10T00:00:00Z',
        expiration_baseline_microdollars_used: 0,
        original_baseline_microdollars_used: 0,
        description: 'Expires first',
      },
      {
        kilo_user_id: ownerId,
        organization_id: orgId,
        amount_microdollars: 5_000_000,
        is_free: true,
        expiry_date: '2024-02-15T00:00:00Z',
        expiration_baseline_microdollars_used: 0,
        original_baseline_microdollars_used: 0,
        description: 'Expires later',
      },
    ]);

    await processOrganizationExpirations(
      {
        id: orgId,
        microdollars_used: 3_000_000,
        next_credit_expiration_at: '2024-01-10T00:00:00Z',
        total_microdollars_acquired: 10_000_000,
      },
      new Date('2024-01-15T00:00:00Z')
    );

    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
    });
    expect(new Date(updatedOrg!.next_credit_expiration_at!).toISOString()).toBe(
      '2024-02-15T00:00:00.000Z'
    );
  });

  it('returns null when no expirations are due', async () => {
    await db.insert(creditTransactionsTable).values({
      kilo_user_id: ownerId,
      organization_id: orgId,
      amount_microdollars: 10_000_000,
      is_free: true,
      expiry_date: '2024-03-01T00:00:00Z',
      expiration_baseline_microdollars_used: 0,
      original_baseline_microdollars_used: 0,
      description: 'Future expiry',
    });

    const result = await processOrganizationExpirations(
      {
        id: orgId,
        microdollars_used: 3_000_000,
        next_credit_expiration_at: '2024-03-01T00:00:00Z',
        total_microdollars_acquired: 10_000_000,
      },
      new Date('2024-01-15T00:00:00Z')
    );

    expect(result).toBeNull();
  });

  it('is idempotent — calling twice does not duplicate', async () => {
    await db.insert(creditTransactionsTable).values({
      kilo_user_id: ownerId,
      organization_id: orgId,
      amount_microdollars: 10_000_000,
      is_free: true,
      expiry_date: '2024-01-10T00:00:00Z',
      expiration_baseline_microdollars_used: 0,
      original_baseline_microdollars_used: 0,
      description: 'Expiring credits',
    });

    const orgInput = {
      id: orgId,
      microdollars_used: 3_000_000,
      next_credit_expiration_at: '2024-01-10T00:00:00Z' as string | null,
      total_microdollars_acquired: 10_000_000,
    };
    const now = new Date('2024-01-15T00:00:00Z');

    const result1 = await processOrganizationExpirations(orgInput, now);
    expect(result1).not.toBeNull();

    // Re-fetch org for second call
    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
    });
    const result2 = await processOrganizationExpirations(
      {
        id: orgId,
        microdollars_used: updatedOrg!.microdollars_used,
        next_credit_expiration_at: updatedOrg!.next_credit_expiration_at,
        total_microdollars_acquired: updatedOrg!.total_microdollars_acquired,
      },
      now
    );
    expect(result2).toBeNull();

    const expirations = await db
      .select()
      .from(creditTransactionsTable)
      .where(eq(creditTransactionsTable.credit_category, 'credits_expired'));
    expect(expirations).toHaveLength(1);
  });

  it('handles concurrent execution — one succeeds, other returns null', async () => {
    await db.insert(creditTransactionsTable).values({
      kilo_user_id: ownerId,
      organization_id: orgId,
      amount_microdollars: 10_000_000,
      is_free: true,
      expiry_date: '2024-01-10T00:00:00Z',
      expiration_baseline_microdollars_used: 0,
      original_baseline_microdollars_used: 0,
      description: 'Expiring credits',
    });

    const orgInput = {
      id: orgId,
      microdollars_used: 3_000_000,
      next_credit_expiration_at: '2024-01-10T00:00:00Z',
      total_microdollars_acquired: 10_000_000,
    };
    const now = new Date('2024-01-15T00:00:00Z');

    const [r1, r2] = await Promise.all([
      processOrganizationExpirations(orgInput, now),
      processOrganizationExpirations(orgInput, now),
    ]);

    const successes = [r1, r2].filter(r => r !== null);
    const nulls = [r1, r2].filter(r => r === null);
    expect(successes).toHaveLength(1);
    expect(nulls).toHaveLength(1);

    const expirations = await db
      .select()
      .from(creditTransactionsTable)
      .where(eq(creditTransactionsTable.credit_category, 'credits_expired'));
    expect(expirations).toHaveLength(1);
  });

  it('handles partial expiry correctly', async () => {
    await db.insert(creditTransactionsTable).values({
      kilo_user_id: ownerId,
      organization_id: orgId,
      amount_microdollars: 10_000_000,
      is_free: true,
      expiry_date: '2024-01-10T00:00:00Z',
      expiration_baseline_microdollars_used: 0,
      original_baseline_microdollars_used: 0,
      description: 'Partial expiry',
    });

    // org has used 7M of 10M, so 3M should expire
    const result = await processOrganizationExpirations(
      {
        id: orgId,
        microdollars_used: 7_000_000,
        next_credit_expiration_at: '2024-01-10T00:00:00Z',
        total_microdollars_acquired: 10_000_000,
      },
      new Date('2024-01-15T00:00:00Z')
    );

    expect(result).not.toBeNull();
    expect(result!.total_microdollars_acquired).toBe(10_000_000 - 3_000_000);

    const expirations = await db
      .select()
      .from(creditTransactionsTable)
      .where(eq(creditTransactionsTable.credit_category, 'credits_expired'));
    expect(expirations).toHaveLength(1);
    expect(expirations[0].amount_microdollars).toBe(-3_000_000);
  });

  it('creates zero-amount expiration when credits fully consumed', async () => {
    await db.insert(creditTransactionsTable).values({
      kilo_user_id: ownerId,
      organization_id: orgId,
      amount_microdollars: 5_000_000,
      is_free: true,
      expiry_date: '2024-01-10T00:00:00Z',
      expiration_baseline_microdollars_used: 0,
      original_baseline_microdollars_used: 0,
      description: 'Fully consumed',
    });

    // microdollars_used >= amount, so nothing to expire
    const result = await processOrganizationExpirations(
      {
        id: orgId,
        microdollars_used: 8_000_000,
        next_credit_expiration_at: '2024-01-10T00:00:00Z',
        total_microdollars_acquired: 10_000_000,
      },
      new Date('2024-01-15T00:00:00Z')
    );

    expect(result).not.toBeNull();
    // total_acquired unchanged since expiration amount is 0
    expect(result!.total_microdollars_acquired).toBe(10_000_000);

    const expirations = await db
      .select()
      .from(creditTransactionsTable)
      .where(eq(creditTransactionsTable.credit_category, 'credits_expired'));
    expect(expirations).toHaveLength(1);
    expect(expirations[0].amount_microdollars).toBe(0);
  });
});
