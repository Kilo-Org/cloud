import {
  credit_transactions as creditTransactionsTable,
  organizations,
  microdollar_usage,
  exa_usage_log,
  enkrypt_usage,
  kilo_pass_org_agreements,
  kilo_pass_org_allocation_plan_rows,
  kilo_pass_org_audit_records,
  kilo_pass_org_issuance_snapshots,
  kilo_pass_org_qualifying_spend_events,
} from '@kilocode/db/schema';
import { recomputeOrganizationBalances } from './recomputeOrganizationBalances';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { defineMicrodollarUsage } from '@kilocode/web-shared/tests/helpers/microdollar-usage.helper';
import { createOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { insertUsageRecord } from '@kilocode/web-shared/lib/ai-gateway/processUsage';
import {
  MICRODOLLARS_PER_ENKRYPT_CREDIT,
  recordEnkryptUsageLocally,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage';
import type { EnkryptUsageWrite } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage-write';
import { recordExaUsage } from './exa-usage';
import { activatePaidAgreement, createPendingAgreement } from './kilo-pass-org/service';
import { and, eq, inArray, like } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

jest.mock('next/server', () => ({
  ...jest.requireActual('next/server'),
  after: jest.fn(),
}));

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
      await db.delete(exa_usage_log).where(eq(exa_usage_log.organization_id, orgId));
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

  it('includes Exa charged usage in recomputed microdollars_used', async () => {
    const org = await createTestOrg(ownerId, {
      total_microdollars_acquired: 100_000_000,
      microdollars_used: 5_000_000, // $2 LLM + $3 Exa
      microdollars_balance: 95_000_000,
    });
    orgId = org.id;

    // Credit: $100
    await db.insert(creditTransactionsTable).values({
      kilo_user_id: ownerId,
      organization_id: orgId,
      amount_microdollars: 100_000_000,
      is_free: true,
      original_baseline_microdollars_used: 0,
      description: 'Grant',
      created_at: '2024-01-01T00:00:00Z',
    });

    // LLM usage: $2
    await db.insert(microdollar_usage).values({
      kilo_user_id: ownerId,
      organization_id: orgId,
      cost: 2_000_000,
      input_tokens: 100,
      output_tokens: 50,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      created_at: '2024-02-01T00:00:00Z',
    });

    // Exa charged usage: $3 for this org, two requests
    await db.insert(exa_usage_log).values([
      {
        kilo_user_id: ownerId,
        organization_id: orgId,
        path: '/search',
        cost_microdollars: 2_000_000,
        charged_to_balance: true,
      },
      {
        kilo_user_id: ownerId,
        organization_id: orgId,
        path: '/search',
        cost_microdollars: 1_000_000,
        charged_to_balance: true,
      },
    ]);

    const result = await recomputeOrganizationBalances({ organizationId: orgId });
    expect(result.success).toBe(true);

    const updatedOrg = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
    });
    // Recomputed microdollars_used should be LLM ($2) + Exa ($3) = $5
    expect(updatedOrg!.microdollars_used).toBe(5_000_000);
  });
});

describe('recomputeOrganizationBalances after live usage writes', () => {
  const organizationIds: string[] = [];
  const agreementIds: string[] = [];

  const llmCost = 2_000;
  const exaCost = 3_000;
  const enkryptCredits = 7;
  const enkryptCharge = enkryptCredits * MICRODOLLARS_PER_ENKRYPT_CREDIT;

  afterEach(async () => {
    const ids = organizationIds.splice(0);
    const agreements = agreementIds.splice(0);
    if (ids.length === 0) return;
    await db
      .delete(kilo_pass_org_qualifying_spend_events)
      .where(
        inArray(kilo_pass_org_qualifying_spend_events.allocation_container_organization_id, ids)
      );
    await db
      .delete(kilo_pass_org_issuance_snapshots)
      .where(inArray(kilo_pass_org_issuance_snapshots.allocation_container_organization_id, ids));
    if (agreements.length > 0) {
      await db
        .delete(kilo_pass_org_audit_records)
        .where(inArray(kilo_pass_org_audit_records.agreement_id, agreements));
    }
    await db
      .delete(kilo_pass_org_allocation_plan_rows)
      .where(inArray(kilo_pass_org_allocation_plan_rows.allocation_container_organization_id, ids));
    await db
      .delete(kilo_pass_org_agreements)
      .where(inArray(kilo_pass_org_agreements.parent_organization_id, ids));
    await db
      .delete(creditTransactionsTable)
      .where(inArray(creditTransactionsTable.organization_id, ids));
    await db.delete(microdollar_usage).where(inArray(microdollar_usage.organization_id, ids));
    await db.delete(exa_usage_log).where(inArray(exa_usage_log.organization_id, ids));
    await db.delete(enkrypt_usage).where(inArray(enkrypt_usage.organization_id, ids));
    await db.delete(organizations).where(inArray(organizations.id, ids));
  });

  async function ordinaryOrganization() {
    const owner = await insertTestUser();
    const organization = await createTestOrganization(
      `recompute-live-${randomUUID()}`,
      owner.id,
      0
    );
    organizationIds.push(organization.id);
    return { owner, organization };
  }

  async function kiloPassOrganization() {
    const now = new Date();
    const window = {
      start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
    };
    const { owner, organization } = await ordinaryOrganization();
    const agreement = await createPendingAgreement({
      parentOrganizationId: organization.id,
      actorUserId: owner.id,
      tier: 'tier_19',
      cadence: 'monthly',
      paidSeatCount: 1,
      issuanceAnchorAt: window.start,
      providerSubscriptionId: `sub_${randomUUID()}`,
      providerSeatAddOnItemId: `si_${randomUUID()}`,
      initialAllocations: [],
    });
    agreementIds.push(agreement.agreementId);
    await activatePaidAgreement({
      agreementId: agreement.agreementId,
      recipientUserId: owner.id,
      paidFrom: window.start,
      paidUntil: window.end,
      paidSeatCount: 1,
      firstWindow: window,
      isBridge: false,
    });
    return { owner, organization };
  }

  function enkryptWrite(
    organizationId: string,
    kiloUserId: string,
    creditsCost: number | null
  ): EnkryptUsageWrite {
    return {
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      organizationId,
      kiloUserId,
      sessionId: null,
      apiKind: 'messages',
      decision: 'allowed',
      creditsCost,
      addedLatencyMs: null,
      guardrail: 'input',
    };
  }

  async function writeLlmExaAndEnkryptUsage(organizationId: string, kiloUserId: string) {
    const { core, metadata } = await defineMicrodollarUsage();
    const llmOutcome = await insertUsageRecord(
      {
        ...core,
        kilo_user_id: kiloUserId,
        organization_id: organizationId,
        cost: llmCost,
        created_at: new Date().toISOString(),
      },
      metadata
    );
    expect(llmOutcome).toMatchObject({ wasRedelivery: false });
    await expect(
      recordExaUsage({
        id: randomUUID(),
        occurredAt: new Date().toISOString(),
        userId: kiloUserId,
        organizationId,
        path: '/search',
        costMicrodollars: exaCost,
        chargedToBalance: true,
        freeAllowanceMicrodollars: 0,
      })
    ).resolves.toBe('recorded');
    await expect(
      recordEnkryptUsageLocally(enkryptWrite(organizationId, kiloUserId, enkryptCredits))
    ).resolves.toBe('recorded');
  }

  async function balanceColumns(organizationId: string) {
    const [row] = await db
      .select({
        microdollars_used: organizations.microdollars_used,
        total_microdollars_acquired: organizations.total_microdollars_acquired,
        microdollars_balance: organizations.microdollars_balance,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    return row;
  }

  it('keeps the balance the live writers produced for an ordinary organization', async () => {
    const { owner, organization } = await ordinaryOrganization();
    await writeLlmExaAndEnkryptUsage(organization.id, owner.id);
    const live = await balanceColumns(organization.id);
    expect(live.microdollars_used).toBe(llmCost + exaCost + enkryptCharge);

    const result = await recomputeOrganizationBalances({ organizationId: organization.id });

    expect(result).toMatchObject({ success: true, accounting_error_mUsd: 0 });
    expect(await balanceColumns(organization.id)).toEqual(live);
  });

  it('keeps the usage the live writers produced for a Kilo Pass allocation container', async () => {
    const { owner, organization } = await kiloPassOrganization();
    await writeLlmExaAndEnkryptUsage(organization.id, owner.id);
    const enkryptDebits = await db
      .select({ amount: creditTransactionsTable.amount_microdollars })
      .from(creditTransactionsTable)
      .where(
        and(
          eq(creditTransactionsTable.organization_id, organization.id),
          like(creditTransactionsTable.credit_category, 'kpo:consumption:enkrypt-guardrail:%')
        )
      );
    expect(enkryptDebits).toEqual([{ amount: -enkryptCharge }]);
    const live = await balanceColumns(organization.id);
    expect(live.microdollars_used).toBe(llmCost + exaCost + enkryptCharge);

    const result = await recomputeOrganizationBalances({ organizationId: organization.id });

    expect(result.success).toBe(true);
    expect(await balanceColumns(organization.id)).toEqual(live);
  });

  it('leaves an organization with only zero-charge Enkrypt usage unchanged', async () => {
    const { owner, organization } = await ordinaryOrganization();
    for (const creditsCost of [null, 0]) {
      await expect(
        recordEnkryptUsageLocally(enkryptWrite(organization.id, owner.id, creditsCost))
      ).resolves.toBe('recorded');
    }
    const live = await balanceColumns(organization.id);
    expect(live).toEqual({
      microdollars_used: 0,
      total_microdollars_acquired: 0,
      microdollars_balance: 0,
    });

    const result = await recomputeOrganizationBalances({ organizationId: organization.id });

    expect(result).toMatchObject({ success: true, accounting_error_mUsd: 0 });
    expect(await balanceColumns(organization.id)).toEqual(live);
  });
});
