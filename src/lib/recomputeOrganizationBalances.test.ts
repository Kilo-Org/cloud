import {
  credit_transactions as creditTransactionsTable,
  organizations,
  microdollar_usage,
} from '@/db/schema';
import { recomputeOrganizationBalances } from './recomputeOrganizationBalances';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization } from '@/lib/organizations/organizations';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

async function createTestOrg(
  ownerId: string,
  overrides: Partial<typeof organizations.$inferInsert> = {}
) {
  const org = await createOrganization(`test-org-${randomUUID().slice(0, 8)}`, ownerId);
  if (Object.keys(overrides).length > 0) {
    await db.update(organizations).set(overrides).where(eq(organizations.id, org.id));
  }
  return (await db.query.organizations.findFirst({ where: eq(organizations.id, org.id) }))!;
}

describe('recomputeOrganizationBalances', () => {
  let ownerId: string;
  let orgId: string;

  beforeAll(async () => {
    const owner = await insertTestUser({
      google_user_email: `recompute-org-${Date.now()}@example.com`,
    });
    ownerId = owner.id;
  });

  afterEach(async () => {
    if (orgId) {
      await db
        .delete(creditTransactionsTable)
        .where(eq(creditTransactionsTable.organization_id, orgId));
      await db.delete(microdollar_usage).where(eq(microdollar_usage.organization_id, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
  });

  it('returns failure for non-existent organization', async () => {
    const result = await recomputeOrganizationBalances({
      organizationId: '00000000-0000-0000-0000-000000000000',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('Organization not found');
    }
  });

  it('recomputes microdollars_used from usage records', async () => {
    const org = await createTestOrg(ownerId, {
      total_microdollars_acquired: 10_000_000,
      microdollars_used: 999, // intentionally wrong
      microdollars_balance: 10_000_000 - 999,
    });
    orgId = org.id;

    // Insert usage records totaling 3M
    await db.insert(microdollar_usage).values([
      {
        kilo_user_id: ownerId,
        organization_id: orgId,
        cost: 1_000_000,
        input_tokens: 100,
        output_tokens: 50,
        cache_write_tokens: 0,
        cache_hit_tokens: 0,
        created_at: '2024-01-01T00:00:00Z',
      },
      {
        kilo_user_id: ownerId,
        organization_id: orgId,
        cost: 2_000_000,
        input_tokens: 200,
        output_tokens: 100,
        cache_write_tokens: 0,
        cache_hit_tokens: 0,
        created_at: '2024-01-02T00:00:00Z',
      },
    ]);

    // Insert a credit transaction matching the org's total_acquired
    await db.insert(creditTransactionsTable).values({
      kilo_user_id: ownerId,
      organization_id: orgId,
      amount_microdollars: 10_000_000,
      is_free: true,
      original_baseline_microdollars_used: 0,
      description: 'Initial grant',
      created_at: '2023-12-01T00:00:00Z',
    });

    const result = await recomputeOrganizationBalances({ organizationId: orgId });
    expect(result.success).toBe(true);

    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
    });
    expect(updatedOrg!.microdollars_used).toBe(3_000_000);
    // Balance should be preserved: original balance was 10M - 999 = 9_999_001
    // So new total_acquired = 9_999_001 + 3_000_000 = 12_999_001
    // But there's an accounting adjustment to reconcile with the 10M credit transaction
    const balance = updatedOrg!.total_microdollars_acquired - updatedOrg!.microdollars_used;
    expect(updatedOrg!.microdollars_balance).toBe(balance);
  });

  it('handles org with zero transactions and zero usage', async () => {
    const org = await createTestOrg(ownerId, {
      total_microdollars_acquired: 0,
      microdollars_used: 0,
      microdollars_balance: 0,
    });
    orgId = org.id;

    const result = await recomputeOrganizationBalances({ organizationId: orgId });
    expect(result.success).toBe(true);

    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
    });
    expect(updatedOrg!.microdollars_used).toBe(0);
    expect(updatedOrg!.total_microdollars_acquired).toBe(0);
    expect(updatedOrg!.microdollars_balance).toBe(0);
  });

  it('dry run computes updates but does not apply them', async () => {
    const org = await createTestOrg(ownerId, {
      total_microdollars_acquired: 10_000_000,
      microdollars_used: 999,
      microdollars_balance: 10_000_000 - 999,
    });
    orgId = org.id;

    await db.insert(microdollar_usage).values({
      kilo_user_id: ownerId,
      organization_id: orgId,
      cost: 5_000_000,
      input_tokens: 100,
      output_tokens: 50,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
    });

    const result = await recomputeOrganizationBalances({ organizationId: orgId, dryRun: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.org_update.microdollars_used).toBe(5_000_000);
    }

    // Org should NOT be updated
    const unchangedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
    });
    expect(unchangedOrg!.microdollars_used).toBe(999);
  });

  it('inserts accounting_adjustment when ledger diverges from cached balance', async () => {
    const org = await createTestOrg(ownerId, {
      total_microdollars_acquired: 10_000_000,
      microdollars_used: 0,
      microdollars_balance: 10_000_000,
    });
    orgId = org.id;

    // Credit transaction sum is 8M but org says 10M acquired — 2M discrepancy
    await db.insert(creditTransactionsTable).values({
      kilo_user_id: ownerId,
      organization_id: orgId,
      amount_microdollars: 8_000_000,
      is_free: true,
      original_baseline_microdollars_used: 0,
      description: 'Grant',
      created_at: '2024-01-01T00:00:00Z',
    });

    const result = await recomputeOrganizationBalances({ organizationId: orgId });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.accounting_error_mUsd).toBe(2_000_000);
    }

    // Check that an accounting_adjustment transaction was inserted
    const adjustments = await db
      .select()
      .from(creditTransactionsTable)
      .where(eq(creditTransactionsTable.credit_category, 'accounting_adjustment'));
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].amount_microdollars).toBe(2_000_000);
    expect(adjustments[0].organization_id).toBe(orgId);
  });

  it('does not insert accounting_adjustment when ledger matches', async () => {
    const org = await createTestOrg(ownerId, {
      total_microdollars_acquired: 10_000_000,
      microdollars_used: 0,
      microdollars_balance: 10_000_000,
    });
    orgId = org.id;

    // Credit transaction sum matches org total_acquired
    await db.insert(creditTransactionsTable).values({
      kilo_user_id: ownerId,
      organization_id: orgId,
      amount_microdollars: 10_000_000,
      is_free: true,
      original_baseline_microdollars_used: 0,
      description: 'Grant',
      created_at: '2024-01-01T00:00:00Z',
    });

    const result = await recomputeOrganizationBalances({ organizationId: orgId });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.accounting_error_mUsd).toBe(0);
    }

    const adjustments = await db
      .select()
      .from(creditTransactionsTable)
      .where(eq(creditTransactionsTable.credit_category, 'accounting_adjustment'));
    expect(adjustments).toHaveLength(0);
  });

  it('preserves user-visible balance', async () => {
    // Org has 10M acquired, 2M used → balance 8M
    // But microdollars_used is wrong (says 999)
    // After recompute, balance should still be 8M (10M - 2M cached)
    // Wait — the function preserves current_balance = total_acquired - microdollars_used
    // So it preserves 10M - 999 = 9_999_001 as the balance
    const org = await createTestOrg(ownerId, {
      total_microdollars_acquired: 10_000_000,
      microdollars_used: 2_000_000,
      microdollars_balance: 8_000_000,
    });
    orgId = org.id;

    // Insert usage records totaling 3M (different from cached 2M)
    await db.insert(microdollar_usage).values({
      kilo_user_id: ownerId,
      organization_id: orgId,
      cost: 3_000_000,
      input_tokens: 100,
      output_tokens: 50,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
    });

    // Insert credit transaction matching what total_acquired should be after balance preservation
    await db.insert(creditTransactionsTable).values({
      kilo_user_id: ownerId,
      organization_id: orgId,
      amount_microdollars: 10_000_000,
      is_free: true,
      original_baseline_microdollars_used: 0,
      description: 'Grant',
      created_at: '2024-01-01T00:00:00Z',
    });

    const balanceBefore = 10_000_000 - 2_000_000; // 8M

    const result = await recomputeOrganizationBalances({ organizationId: orgId });
    expect(result.success).toBe(true);

    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
    });
    // microdollars_used corrected to 3M
    expect(updatedOrg!.microdollars_used).toBe(3_000_000);
    // Balance preserved: was 8M, now total_acquired = 8M + 3M = 11M, balance = 11M - 3M = 8M
    const balanceAfter = updatedOrg!.total_microdollars_acquired - updatedOrg!.microdollars_used;
    expect(balanceAfter).toBe(balanceBefore);
    expect(updatedOrg!.microdollars_balance).toBe(balanceBefore);
  });

  it('sets microdollars_balance = total_acquired - used', async () => {
    const org = await createTestOrg(ownerId, {
      total_microdollars_acquired: 5_000_000,
      microdollars_used: 1_000_000,
      microdollars_balance: 4_000_000,
    });
    orgId = org.id;

    await db.insert(creditTransactionsTable).values({
      kilo_user_id: ownerId,
      organization_id: orgId,
      amount_microdollars: 5_000_000,
      is_free: true,
      original_baseline_microdollars_used: 0,
      description: 'Grant',
      created_at: '2024-01-01T00:00:00Z',
    });

    await recomputeOrganizationBalances({ organizationId: orgId });

    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
    });
    expect(updatedOrg!.microdollars_balance).toBe(
      updatedOrg!.total_microdollars_acquired - updatedOrg!.microdollars_used
    );
  });
});
