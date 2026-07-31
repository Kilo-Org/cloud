import 'server-only';

import {
  credit_transactions,
  kilo_pass_org_agreements,
  kilo_pass_org_allocation_plan_rows,
  kilo_pass_org_audit_records,
  kilo_pass_org_allocation_plans,
  kilo_pass_org_issuance_snapshots,
  kilo_pass_org_notification_deliveries,
  kilo_pass_org_processing_runs,
  kilo_pass_org_supplements,
  kilo_pass_org_term_versions,
  organization_memberships,
  organization_seats_purchases,
  organizations,
} from '@kilocode/db/schema';
import {
  KiloPassOrgAgreementState,
  KiloPassOrgBonusMode,
  KiloPassOrgIssuanceKind,
  KiloPassOrgProcessingCondition,
  KiloPassOrgProcessingRunState,
  KiloPassOrgPurchaseChannel,
  KiloPassCadence,
  KiloPassTier,
} from '@kilocode/db/schema-types';
import { and, asc, desc, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import {
  bridgeRatio,
  monthlyWindowFromOriginalAnchor,
  monthlyWindowContaining,
  roundHalfUpMicrodollars,
  type IssuanceWindow,
  validateAllocation,
} from './calculations';

export type OrganizationKiloPassState =
  | 'unavailable'
  | 'pending_payment'
  | 'active'
  | 'cancel_at_period_end'
  | 'ended'
  | 'blocked'
  | 'failed';
export type OrganizationKiloPassCommercialState =
  | 'pending_payment'
  | 'active'
  | 'cancel_at_period_end'
  | 'ended';
export type OrganizationKiloPassProcessingCondition =
  | 'ready'
  | 'manual'
  | 'blocked'
  | 'overallocated'
  | 'failed'
  | 'suspended_for_review';
type Tier = 'tier_19' | 'tier_49' | 'tier_199';
type Cadence = 'monthly' | 'yearly';
type Allocation = { organizationId: string; passCapacity: number };
type DisplayTerms = {
  tier: Tier;
  tierName: string;
  pricePerPassUsd: number;
  baseCreditsPerPassUsd: number;
  bonusCreditsPerPassUsd: number;
  unlockSpendPerPassUsd: number;
  bonusMode: 'after_base' | 'upfront';
};

export type OrganizationKiloPassService = {
  getSummary(input: { organizationId: string }): Promise<{
    state: OrganizationKiloPassState;
    commercialState: OrganizationKiloPassCommercialState | null;
    processingCondition: OrganizationKiloPassProcessingCondition | null;
    agreement: {
      tier: Tier;
      cadence: Cadence;
      paidSeatCount: number;
      planVersion: number;
      paidThrough: string | null;
      terms: DisplayTerms;
    } | null;
  }>;
  getSetup(input: { organizationId: string }): Promise<{
    paidSeatCount: number;
    cadence: 'monthly' | 'yearly';
    renewalAt: string;
    planVersion: number;
    children: { id: string; name: string }[];
    terms: DisplayTerms[];
  }>;
  getDetail(input: { organizationId: string }): Promise<{
    state: OrganizationKiloPassState;
    commercialState: OrganizationKiloPassCommercialState;
    processingCondition: OrganizationKiloPassProcessingCondition;
    tier: Tier;
    cadence: Cadence;
    terms: DisplayTerms;
    paidSeatCount: number;
    nextPaidSeatCount: number;
    planVersion: number;
    paidThrough: string | null;
    currentWindow: { startsAt: string; endsAt: string } | null;
    nextWindowStartsAt: string | null;
    latestRun: {
      id: string;
      state: 'pending' | 'running' | 'succeeded' | 'blocked' | 'failed';
      window: { startsAt: string; endsAt: string };
      failureCode: string | null;
      attemptCount: number;
    } | null;
    currentAllocations: {
      organizationId: string;
      organizationName: string;
      passCount: number;
      kind: 'parent' | 'child';
      hasProratedCredits: boolean;
      baseCreditsMicrodollars: number;
      qualifyingSpendMicrodollars: number;
      unlockTargetMicrodollars: number;
      bonusCreditsMicrodollars: number;
      bonusState: 'locked' | 'unlocked' | 'upfront_granted' | 'expired' | 'missed';
    }[];
    nextAllocations: {
      organizationId: string;
      organizationName: string;
      passCount: number;
      kind: 'parent' | 'child';
    }[];
  }>;
  getUsage(input: { organizationId: string }): Promise<{
    tier: Tier;
    terms: DisplayTerms;
    currentWindow: { startsAt: string; endsAt: string };
    currentAllocations: Awaited<
      ReturnType<OrganizationKiloPassService['getDetail']>
    >['currentAllocations'];
  } | null>;
  createCheckout(
    input: {
      organizationId: string;
      actorUserId: string;
      tier: Tier;
      allocations: { childOrganizationId: string; passCount: number }[];
    },
    createProviderCheckout: OrganizationKiloPassProviderOperations['createCheckout']
  ): Promise<
    { kind: 'payment_action'; clientSecret: string } | { kind: 'completed' } | { kind: 'pending' }
  >;
  updateAllocation(input: {
    organizationId: string;
    actorUserId: string;
    expectedPlanVersion: number;
    allocations: { childOrganizationId: string; passCount: number }[];
  }): Promise<{ planVersion: number; nextWindowStartsAt: string }>;
  cancel(
    input: {
      organizationId: string;
      actorUserId: string;
    },
    scheduleProviderCancellation: OrganizationKiloPassProviderOperations['scheduleCancellation']
  ): Promise<{
    state: 'cancel_at_period_end';
    effectiveAt: string;
  }>;
  resume(
    input: { organizationId: string; actorUserId: string },
    resumeProviderCancellation: OrganizationKiloPassProviderOperations['resumeCancellation']
  ): Promise<{ state: 'active' }>;
  retryRun(input: { organizationId: string; actorUserId: string; runId: string }): Promise<{
    runId: string;
    window: { startsAt: string; endsAt: string };
  }>;
};

/** Stripe-facing operations are supplied by the application boundary. */
export type OrganizationKiloPassProviderOperations = {
  createCheckout(input: {
    organizationId: string;
    actorUserId: string;
    tier: Tier;
    allocations: { childOrganizationId: string; passCount: number }[];
  }): Promise<
    { kind: 'payment_action'; clientSecret: string } | { kind: 'completed' } | { kind: 'pending' }
  >;
  scheduleCancellation(input: {
    providerSubscriptionId: string;
    providerSeatAddOnItemId: string;
  }): Promise<void>;
  resumeCancellation(input: {
    providerSubscriptionId: string;
    providerSeatAddOnItemId: string;
  }): Promise<void>;
};

const iso = (value: string | Date | null) =>
  value === null ? null : new Date(value).toISOString();
const requiredIso = (value: string | Date) => new Date(value).toISOString();
const asDate = (value: string | Date) => new Date(value);
const termPrice: Record<Tier, number> = {
  tier_19: 19_000_000,
  tier_49: 49_000_000,
  tier_199: 199_000_000,
};
const termBonus: Record<Tier, number> = {
  tier_19: 4_000_000,
  tier_49: 12_000_000,
  tier_199: 50_000_000,
};
const tierName: Record<Tier, string> = {
  tier_19: 'Starter',
  tier_49: 'Pro',
  tier_199: 'Expert',
};
const dbTier: Record<Tier, KiloPassTier> = {
  tier_19: KiloPassTier.Tier19,
  tier_49: KiloPassTier.Tier49,
  tier_199: KiloPassTier.Tier199,
};
const dbCadence: Record<Cadence, KiloPassCadence> = {
  monthly: KiloPassCadence.Monthly,
  yearly: KiloPassCadence.Yearly,
};

/** Standard terms are immutable and deliberately do not derive from personal Pass rules. */
export const standardOrgPassTerms = (Object.entries(termPrice) as [Tier, number][]).flatMap(
  ([tier, price]) =>
    (['monthly', 'yearly'] as const).map(cadence => ({
      versionKey: `standard-${tier}-${cadence}-v1`,
      tier,
      cadence,
      billingPriceMicrodollarsPerPass: price,
      baseCreditMicrodollarsPerPass: price,
      bonusCreditMicrodollarsPerPass: termBonus[tier],
      unlockSpendMicrodollarsPerPass: price,
    }))
);

function displayTerms(term: {
  tier: string;
  billing_price_microdollars_per_pass: number;
  base_credit_microdollars_per_pass: number;
  bonus_credit_microdollars_per_pass: number;
  unlock_spend_microdollars_per_pass: number;
  bonus_mode: string;
}): DisplayTerms {
  const tier = term.tier as Tier;
  return {
    tier,
    tierName: tierName[tier],
    pricePerPassUsd: term.billing_price_microdollars_per_pass / 1_000_000,
    baseCreditsPerPassUsd: term.base_credit_microdollars_per_pass / 1_000_000,
    bonusCreditsPerPassUsd: term.bonus_credit_microdollars_per_pass / 1_000_000,
    unlockSpendPerPassUsd: term.unlock_spend_microdollars_per_pass / 1_000_000,
    bonusMode: term.bonus_mode === KiloPassOrgBonusMode.Upfront ? 'upfront' : 'after_base',
  };
}

function standardDisplayTerms(cadence: Cadence): DisplayTerms[] {
  return standardOrgPassTerms
    .filter(term => term.cadence === cadence)
    .map(term => ({
      tier: term.tier,
      tierName: tierName[term.tier],
      pricePerPassUsd: term.billingPriceMicrodollarsPerPass / 1_000_000,
      baseCreditsPerPassUsd: term.baseCreditMicrodollarsPerPass / 1_000_000,
      bonusCreditsPerPassUsd: term.bonusCreditMicrodollarsPerPass / 1_000_000,
      unlockSpendPerPassUsd: term.unlockSpendMicrodollarsPerPass / 1_000_000,
      bonusMode: 'after_base',
    }));
}

async function seedTerms(tx: DrizzleTransaction) {
  for (const term of standardOrgPassTerms) {
    await tx
      .insert(kilo_pass_org_term_versions)
      .values([
        {
          version_key: term.versionKey,
          tier: dbTier[term.tier],
          cadence: dbCadence[term.cadence],
          billing_price_microdollars_per_pass: term.billingPriceMicrodollarsPerPass,
          base_credit_microdollars_per_pass: term.baseCreditMicrodollarsPerPass,
          bonus_credit_microdollars_per_pass: term.bonusCreditMicrodollarsPerPass,
          unlock_spend_microdollars_per_pass: term.unlockSpendMicrodollarsPerPass,
          bonus_mode: KiloPassOrgBonusMode.AfterBase,
        },
      ])
      .onConflictDoNothing();
  }
}

async function assertParentAndChildren(
  tx: DrizzleTransaction,
  parentId: string,
  allocations: readonly Allocation[]
) {
  const [parent] = await tx
    .select({ parentId: organizations.parent_organization_id })
    .from(organizations)
    .where(eq(organizations.id, parentId))
    .for('update');
  if (!parent || parent.parentId)
    throw new Error('Kilo Pass organization agreement owner must be a top-level organization');
  if (new Set(allocations.map(a => a.organizationId)).size !== allocations.length)
    throw new Error('allocation containers must be unique');
  if (!allocations.length) return;
  const children = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.parent_organization_id, parentId),
        isNull(organizations.deleted_at),
        inArray(
          organizations.id,
          allocations.map(a => a.organizationId)
        )
      )
    );
  if (children.length !== allocations.length)
    throw new Error('allocation container must be a direct child organization');
}

async function recordAudit(
  tx: DrizzleTransaction,
  input: {
    agreementId: string;
    actorUserId?: string;
    action: string;
    reason: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    idempotencyKey?: string;
  }
) {
  await tx.insert(kilo_pass_org_audit_records).values({
    agreement_id: input.agreementId,
    actor_kilo_user_id: input.actorUserId,
    action: input.action,
    reason: input.reason,
    before_json: input.before,
    after_json: input.after,
    idempotency_key: input.idempotencyKey,
  });
}

async function insertPlan(
  tx: DrizzleTransaction,
  input: {
    agreementId: string;
    effectiveAt: Date;
    version: number;
    actorId: string;
    allocations: readonly Allocation[];
  }
) {
  const [plan] = await tx
    .insert(kilo_pass_org_allocation_plans)
    .values({
      agreement_id: input.agreementId,
      effective_window_start: input.effectiveAt.toISOString(),
      version: input.version,
      created_by_kilo_user_id: input.actorId,
    })
    .returning({ id: kilo_pass_org_allocation_plans.id });
  if (!plan) throw new Error('allocation plan insert failed');
  if (input.allocations.length)
    await tx.insert(kilo_pass_org_allocation_plan_rows).values(
      input.allocations.map(a => ({
        allocation_plan_id: plan.id,
        allocation_container_organization_id: a.organizationId,
        pass_capacity: a.passCapacity,
      }))
    );
  return plan.id;
}

async function replacePlanAtWindow(
  tx: DrizzleTransaction,
  input: {
    agreementId: string;
    effectiveAt: Date;
    version: number;
    actorId: string;
    allocations: readonly Allocation[];
  }
) {
  await tx
    .delete(kilo_pass_org_allocation_plans)
    .where(
      and(
        eq(kilo_pass_org_allocation_plans.agreement_id, input.agreementId),
        eq(kilo_pass_org_allocation_plans.effective_window_start, input.effectiveAt.toISOString())
      )
    );
  return insertPlan(tx, input);
}

async function effectivePlan(tx: DrizzleTransaction, agreementId: string, at: Date) {
  const [plan] = await tx
    .select()
    .from(kilo_pass_org_allocation_plans)
    .where(
      and(
        eq(kilo_pass_org_allocation_plans.agreement_id, agreementId),
        lte(kilo_pass_org_allocation_plans.effective_window_start, at.toISOString())
      )
    )
    .orderBy(
      desc(kilo_pass_org_allocation_plans.effective_window_start),
      desc(kilo_pass_org_allocation_plans.version)
    )
    .limit(1);
  if (!plan) throw new Error('no allocation plan is effective for this issuance window');
  const allocations = await tx
    .select({
      organizationId: kilo_pass_org_allocation_plan_rows.allocation_container_organization_id,
      passCapacity: kilo_pass_org_allocation_plan_rows.pass_capacity,
    })
    .from(kilo_pass_org_allocation_plan_rows)
    .where(eq(kilo_pass_org_allocation_plan_rows.allocation_plan_id, plan.id));
  return { plan, allocations };
}

/** Creates the pre-payment source of truth; Stripe integration supplies its stable IDs. */
export async function createPendingAgreement(input: {
  parentOrganizationId: string;
  actorUserId: string;
  tier: Tier;
  cadence: Cadence;
  paidSeatCount: number;
  issuanceAnchorAt: Date;
  providerSubscriptionId: string;
  providerSeatAddOnItemId: string;
  initialAllocations: readonly Allocation[];
}) {
  return db.transaction(async tx => {
    await seedTerms(tx);
    await assertParentAndChildren(tx, input.parentOrganizationId, input.initialAllocations);
    const validation = validateAllocation(
      input.paidSeatCount,
      input.initialAllocations.map(a => a.passCapacity)
    );
    if (!validation.valid) throw new Error(`invalid initial allocation: ${validation.reason}`);
    const [existing] = await tx
      .select({ id: kilo_pass_org_agreements.id })
      .from(kilo_pass_org_agreements)
      .where(eq(kilo_pass_org_agreements.provider_subscription_id, input.providerSubscriptionId));
    if (existing) return { agreementId: existing.id, created: false };
    const [term] = await tx
      .select({ id: kilo_pass_org_term_versions.id })
      .from(kilo_pass_org_term_versions)
      .where(
        eq(kilo_pass_org_term_versions.version_key, `standard-${input.tier}-${input.cadence}-v1`)
      );
    if (!term) throw new Error('standard organization Pass term unavailable');
    const [agreement] = await tx
      .insert(kilo_pass_org_agreements)
      .values([
        {
          parent_organization_id: input.parentOrganizationId,
          term_version_id: term.id,
          state: KiloPassOrgAgreementState.PendingPayment,
          purchase_channel: KiloPassOrgPurchaseChannel.SelfServe,
          cadence: dbCadence[input.cadence],
          purchased_pass_capacity: input.paidSeatCount,
          issuance_anchor_at: input.issuanceAnchorAt.toISOString(),
          provider_subscription_id: input.providerSubscriptionId,
          provider_seat_add_on_item_id: input.providerSeatAddOnItemId,
        },
      ])
      .returning({ id: kilo_pass_org_agreements.id });
    if (!agreement) throw new Error('agreement insert failed');
    await insertPlan(tx, {
      agreementId: agreement.id,
      effectiveAt: input.issuanceAnchorAt,
      version: 1,
      actorId: input.actorUserId,
      allocations: input.initialAllocations,
    });
    return { agreementId: agreement.id, created: true };
  });
}

async function grant(
  tx: DrizzleTransaction,
  input: {
    organizationId: string;
    userId: string;
    microdollars: number;
    identity: string;
    description: string;
    expiresAt?: Date;
  }
) {
  if (input.microdollars === 0) return null;
  const [organization] = await tx
    .select({ microdollarsUsed: organizations.microdollars_used })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .for('update');
  if (!organization) throw new Error('allocation container no longer exists');
  const expiresAt = input.expiresAt?.toISOString();
  const [credit] = await tx
    .insert(credit_transactions)
    .values({
      kilo_user_id: input.userId,
      organization_id: input.organizationId,
      amount_microdollars: input.microdollars,
      is_free: true,
      description: input.description,
      credit_category: input.identity,
      check_category_uniqueness: true,
      expiry_date: expiresAt ?? null,
      expiration_baseline_microdollars_used: expiresAt ? organization.microdollarsUsed : null,
      original_baseline_microdollars_used: organization.microdollarsUsed,
    })
    .returning({ id: credit_transactions.id });
  if (!credit) throw new Error('organization credit grant failed');
  const updated = await tx
    .update(organizations)
    .set({
      total_microdollars_acquired: sql`${organizations.total_microdollars_acquired} + ${input.microdollars}`,
      microdollars_balance: sql`${organizations.microdollars_balance} + ${input.microdollars}`,
      ...(expiresAt && {
        next_credit_expiration_at: sql`COALESCE(LEAST(${organizations.next_credit_expiration_at}, ${expiresAt}), ${expiresAt})`,
      }),
    })
    .where(eq(organizations.id, input.organizationId))
    .returning({ id: organizations.id });
  if (!updated[0]) throw new Error('allocation container no longer exists');
  return credit.id;
}

async function issue(
  tx: DrizzleTransaction,
  input: {
    agreementId: string;
    recipientUserId: string;
    window: IssuanceWindow;
    kind: 'regular' | 'bridge';
    bridgeProrationWindow?: IssuanceWindow;
  }
) {
  const [row] = await tx
    .select({ agreement: kilo_pass_org_agreements, term: kilo_pass_org_term_versions })
    .from(kilo_pass_org_agreements)
    .innerJoin(
      kilo_pass_org_term_versions,
      eq(kilo_pass_org_agreements.term_version_id, kilo_pass_org_term_versions.id)
    )
    .where(eq(kilo_pass_org_agreements.id, input.agreementId))
    .for('update');
  if (!row || !row.agreement.paid_from || !row.agreement.paid_until)
    throw new Error('agreement is not paid');
  // A bridge may cover only part of its containing agreement month. Keep the
  // immutable paid service interval on the snapshot, but price it against the
  // complete anchored month so a partial invoice cannot receive a full month.
  const runKey = `kpo:run:${row.agreement.id}:${input.window.start.toISOString()}`;
  const [existingRun] = await tx
    .select({
      id: kilo_pass_org_processing_runs.id,
      windowStart: kilo_pass_org_processing_runs.window_start,
      windowEnd: kilo_pass_org_processing_runs.window_end,
      state: kilo_pass_org_processing_runs.state,
      leaseExpiresAt: kilo_pass_org_processing_runs.lease_expires_at,
    })
    .from(kilo_pass_org_processing_runs)
    .where(
      and(
        eq(kilo_pass_org_processing_runs.agreement_id, row.agreement.id),
        eq(kilo_pass_org_processing_runs.window_start, input.window.start.toISOString())
      )
    )
    .for('update');
  if (existingRun?.state === KiloPassOrgProcessingRunState.Succeeded)
    return { issued: false, blocked: false };
  const now = new Date();
  if (
    existingRun?.state === KiloPassOrgProcessingRunState.Running &&
    existingRun.leaseExpiresAt &&
    asDate(existingRun.leaseExpiresAt) > now
  ) {
    return { issued: false, blocked: false };
  }
  const window = existingRun
    ? { start: asDate(existingRun.windowStart), end: asDate(existingRun.windowEnd) }
    : input.window;
  const containingWindow =
    input.bridgeProrationWindow ??
    monthlyWindowContaining(asDate(row.agreement.issuance_anchor_at), window.start);
  const ratio =
    input.kind === 'bridge'
      ? bridgeRatio(containingWindow, window)
      : { numerator: 1, denominator: 1 };
  if (!ratio.numerator) throw new Error('issuance window is not paid');
  const { plan, allocations } = await effectivePlan(tx, row.agreement.id, window.start);
  await assertParentAndChildren(tx, row.agreement.parent_organization_id, allocations);
  const valid = validateAllocation(
    row.agreement.purchased_pass_capacity,
    allocations.map(a => a.passCapacity)
  );
  const run = existingRun
    ? { id: existingRun.id }
    : (
        await tx
          .insert(kilo_pass_org_processing_runs)
          .values({
            agreement_id: row.agreement.id,
            window_start: window.start.toISOString(),
            window_end: window.end.toISOString(),
            state: KiloPassOrgProcessingRunState.Pending,
            idempotency_key: runKey,
          })
          .onConflictDoNothing()
          .returning({ id: kilo_pass_org_processing_runs.id })
      )[0];
  if (!run) return { issued: false, blocked: false };
  if (!valid.valid) {
    await tx
      .update(kilo_pass_org_processing_runs)
      .set({
        state: KiloPassOrgProcessingRunState.Blocked,
        failure_code: valid.reason,
        lease_expires_at: null,
      })
      .where(eq(kilo_pass_org_processing_runs.id, run.id));
    await tx
      .update(kilo_pass_org_agreements)
      .set({ processing_condition: KiloPassOrgProcessingCondition.Overallocated })
      .where(eq(kilo_pass_org_agreements.id, row.agreement.id));
    const recipients = await tx
      .select({ userId: organization_memberships.kilo_user_id })
      .from(organization_memberships)
      .where(
        and(
          eq(organization_memberships.organization_id, row.agreement.parent_organization_id),
          inArray(organization_memberships.role, ['owner', 'billing_manager'])
        )
      );
    const recipientIds = new Set(recipients.map(recipient => recipient.userId));
    if (!recipientIds.size) recipientIds.add(input.recipientUserId);
    if (recipientIds.size) {
      await tx
        .insert(kilo_pass_org_notification_deliveries)
        .values(
          [...recipientIds].map(userId => ({
            processing_run_id: run.id,
            recipient_kilo_user_id: userId,
            status: 'pending' as const,
          }))
        )
        .onConflictDoNothing();
    }
    return { issued: false, blocked: true };
  }
  await tx
    .update(kilo_pass_org_processing_runs)
    .set({
      state: KiloPassOrgProcessingRunState.Running,
      attempt_count: sql`${kilo_pass_org_processing_runs.attempt_count} + 1`,
      lease_expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
      failure_code: null,
    })
    .where(eq(kilo_pass_org_processing_runs.id, run.id));
  const containers = [
    ...allocations,
    {
      organizationId: row.agreement.parent_organization_id,
      passCapacity: valid.parentDefaultCapacity,
    },
  ].filter(a => a.passCapacity > 0);
  for (const container of containers) {
    const multiplier = container.passCapacity;
    const base = roundHalfUpMicrodollars(
      row.term.base_credit_microdollars_per_pass * multiplier,
      ratio.numerator,
      ratio.denominator
    );
    const bonus = roundHalfUpMicrodollars(
      row.term.bonus_credit_microdollars_per_pass * multiplier,
      ratio.numerator,
      ratio.denominator
    );
    const threshold = roundHalfUpMicrodollars(
      row.term.unlock_spend_microdollars_per_pass * multiplier,
      ratio.numerator,
      ratio.denominator
    );
    const grantKey = `kpo:base:${row.agreement.id}:${container.organizationId}:${window.start.toISOString()}`;
    const baseId = await grant(tx, {
      organizationId: container.organizationId,
      userId: input.recipientUserId,
      microdollars: base,
      identity: grantKey,
      description: 'Kilo Pass organization base issuance',
    });
    const bonusId =
      row.term.bonus_mode === KiloPassOrgBonusMode.Upfront
        ? await grant(tx, {
            organizationId: container.organizationId,
            userId: input.recipientUserId,
            microdollars: bonus,
            identity: `kpo:bonus:${row.agreement.id}:${container.organizationId}:${window.start.toISOString()}`,
            description: 'Kilo Pass organization upfront bonus',
            expiresAt: window.end,
          })
        : null;
    await tx.insert(kilo_pass_org_issuance_snapshots).values({
      agreement_id: row.agreement.id,
      processing_run_id: run.id,
      allocation_plan_id: plan.id,
      term_version_id: row.term.id,
      allocation_container_organization_id: container.organizationId,
      window_start: window.start.toISOString(),
      window_end: window.end.toISOString(),
      qualifying_spend_starts_at: window.start.toISOString(),
      kind:
        input.kind === 'bridge' ? KiloPassOrgIssuanceKind.Bridge : KiloPassOrgIssuanceKind.Regular,
      tranche_key: 'base',
      allocated_pass_capacity: multiplier,
      base_credit_microdollars: base,
      bonus_credit_microdollars: bonus,
      unlock_spend_microdollars: threshold,
      bonus_mode: row.term.bonus_mode,
      base_credit_transaction_id: baseId,
      bonus_credit_transaction_id: bonusId,
      bonus_unlocked_at: bonusId ? new Date().toISOString() : null,
    });
  }
  await tx
    .update(kilo_pass_org_processing_runs)
    .set({
      state: KiloPassOrgProcessingRunState.Succeeded,
      lease_expires_at: null,
      failure_code: null,
    })
    .where(eq(kilo_pass_org_processing_runs.id, run.id));
  await tx
    .update(kilo_pass_org_agreements)
    .set({
      processing_condition: conditionAfterRecovery(processingCondition(row.agreement)),
    })
    .where(eq(kilo_pass_org_agreements.id, row.agreement.id));
  return { issued: true, blocked: false };
}

async function reclaimBlockedProcessingRun(tx: DrizzleTransaction, runId: string) {
  await tx
    .update(kilo_pass_org_processing_runs)
    .set({
      state: KiloPassOrgProcessingRunState.Pending,
      lease_expires_at: null,
      failure_code: null,
    })
    .where(
      and(
        eq(kilo_pass_org_processing_runs.id, runId),
        eq(kilo_pass_org_processing_runs.state, KiloPassOrgProcessingRunState.Blocked)
      )
    );
}

/** Provider adapters call this only from a recognized paid event. Paid-through never regresses. */
export async function activatePaidAgreement(input: {
  agreementId: string;
  recipientUserId: string;
  paidFrom: Date;
  paidUntil: Date;
  paidSeatCount: number;
  /** The bridge service interval, or the full agreement month for regular issuance. */
  firstWindow: IssuanceWindow;
  isBridge: boolean;
  /** Immutable paid provider interval for a bridge snapshot. */
  paidBridgeInterval?: IssuanceWindow;
  providerEventId?: string;
}) {
  if (input.paidFrom >= input.paidUntil) throw new Error('paid interval must be non-empty');
  return db.transaction(async tx => {
    const [existing] = await tx
      .select()
      .from(kilo_pass_org_agreements)
      .where(eq(kilo_pass_org_agreements.id, input.agreementId))
      .for('update');
    if (!existing) throw new Error('agreement not found');
    if (existing.activation_provider_event_id === input.providerEventId && input.providerEventId) {
      return { issued: false, blocked: false };
    }
    const paidUntil =
      existing.paid_until && asDate(existing.paid_until) > input.paidUntil
        ? asDate(existing.paid_until)
        : input.paidUntil;
    const pendingCapacityEffectiveAt = existing.next_capacity_effective_at
      ? asDate(existing.next_capacity_effective_at)
      : null;
    const appliesPendingCapacity =
      pendingCapacityEffectiveAt !== null && input.paidFrom >= pendingCapacityEffectiveAt;
    // A paid provider quantity above the scheduled quantity supersedes that
    // schedule even when it remains below the pre-decrease capacity.
    const replacesPendingCapacity =
      existing.next_purchased_pass_capacity !== null &&
      input.paidSeatCount > existing.next_purchased_pass_capacity;
    await tx
      .update(kilo_pass_org_agreements)
      .set({
        state:
          existing.state === KiloPassOrgAgreementState.CancelAtPeriodEnd
            ? KiloPassOrgAgreementState.CancelAtPeriodEnd
            : KiloPassOrgAgreementState.Active,
        purchased_pass_capacity: input.paidSeatCount,
        next_purchased_pass_capacity:
          appliesPendingCapacity || replacesPendingCapacity
            ? null
            : existing.next_purchased_pass_capacity,
        next_capacity_effective_at:
          appliesPendingCapacity || replacesPendingCapacity
            ? null
            : existing.next_capacity_effective_at,
        paid_from: input.paidFrom.toISOString(),
        paid_until: paidUntil.toISOString(),
        activation_provider_event_id:
          existing.activation_provider_event_id ?? input.providerEventId,
      })
      .where(eq(kilo_pass_org_agreements.id, input.agreementId));
    if (
      processingCondition(existing) === KiloPassOrgProcessingCondition.Manual ||
      processingCondition(existing) === KiloPassOrgProcessingCondition.SuspendedForReview
    ) {
      return { issued: false, blocked: false };
    }
    const firstWindow = input.isBridge
      ? input.paidBridgeInterval
        ? intersectionWindow(input.firstWindow, input.paidBridgeInterval)
        : input.firstWindow
      : existing.cadence === KiloPassCadence.Yearly
        ? monthlyWindowContaining(asDate(existing.issuance_anchor_at), input.paidFrom)
        : input.firstWindow;
    if (!firstWindow) throw new Error('paid bridge interval does not overlap its agreement month');
    return issue(tx, {
      agreementId: input.agreementId,
      recipientUserId: input.recipientUserId,
      window: firstWindow,
      kind: input.isBridge ? 'bridge' : 'regular',
      bridgeProrationWindow:
        input.isBridge && input.paidBridgeInterval ? input.firstWindow : undefined,
    });
  });
}

export async function scheduleOrganizationPassCapacity(input: {
  organizationId: string;
  paidSeatCount: number;
}) {
  const row = await nonEndedAgreement(input.organizationId);
  if (!row) return { scheduled: false };
  if (!Number.isSafeInteger(input.paidSeatCount) || input.paidSeatCount < 0) {
    throw new Error('invalid paid seat count');
  }
  if (!row.agreement.paid_until) return { scheduled: false };
  return db.transaction(async tx => {
    const [agreement] = await tx
      .select()
      .from(kilo_pass_org_agreements)
      .where(eq(kilo_pass_org_agreements.id, row.agreement.id))
      .for('update');
    if (!agreement) throw new Error('agreement not found');
    if (!agreement.paid_until) return { scheduled: false };
    const effectiveAt = asDate(agreement.paid_until);
    const { allocations } = await effectivePlan(tx, agreement.id, effectiveAt);
    const valid = validateAllocation(
      input.paidSeatCount,
      allocations.map(allocation => allocation.passCapacity)
    );
    const nextCondition = valid.valid
      ? conditionAfterRecovery(processingCondition(agreement))
      : processingCondition(agreement) === KiloPassOrgProcessingCondition.Manual ||
          processingCondition(agreement) === KiloPassOrgProcessingCondition.SuspendedForReview
        ? processingCondition(agreement)
        : KiloPassOrgProcessingCondition.Overallocated;
    await tx
      .update(kilo_pass_org_agreements)
      .set({
        next_purchased_pass_capacity: input.paidSeatCount,
        next_capacity_effective_at: agreement.paid_until,
        processing_condition: nextCondition,
      })
      .where(eq(kilo_pass_org_agreements.id, agreement.id));
    await recordAudit(tx, {
      agreementId: agreement.id,
      action: 'capacity_change_scheduled',
      reason: 'paid_seat_decrease',
      before: {
        purchasedPassCapacity: agreement.purchased_pass_capacity,
        nextPurchasedPassCapacity: agreement.next_purchased_pass_capacity,
        processingCondition: agreement.processing_condition,
      },
      after: {
        nextPurchasedPassCapacity: input.paidSeatCount,
        effectiveAt: agreement.paid_until,
        processingCondition: nextCondition,
      },
    });
    return { scheduled: true, overallocated: !valid.valid };
  });
}

export async function retryOrganizationPassRun(input: { agreementId: string; runId: string }) {
  const retry = await db.transaction(async tx => {
    const [run] = await tx
      .select()
      .from(kilo_pass_org_processing_runs)
      .where(
        and(
          eq(kilo_pass_org_processing_runs.id, input.runId),
          eq(kilo_pass_org_processing_runs.agreement_id, input.agreementId)
        )
      )
      .for('update');
    if (!run) throw new Error('processing run not found');
    if (
      run.state !== KiloPassOrgProcessingRunState.Blocked &&
      run.state !== KiloPassOrgProcessingRunState.Failed
    ) {
      throw new Error('processing run is not recoverable');
    }
    const [owner] = await tx
      .select({
        parentOrganizationId: kilo_pass_org_agreements.parent_organization_id,
        fallbackUserId: organizations.created_by_kilo_user_id,
        processingCondition: kilo_pass_org_agreements.processing_condition,
      })
      .from(kilo_pass_org_agreements)
      .innerJoin(
        organizations,
        eq(kilo_pass_org_agreements.parent_organization_id, organizations.id)
      )
      .where(eq(kilo_pass_org_agreements.id, input.agreementId));
    if (!owner) throw new Error('agreement owner is unavailable');
    if (
      owner.processingCondition === KiloPassOrgProcessingCondition.Manual ||
      owner.processingCondition === KiloPassOrgProcessingCondition.SuspendedForReview
    ) {
      throw new Error('agreement processing condition requires explicit review');
    }
    const recipientUserId = await agreementRecipientUserId(
      tx,
      owner.parentOrganizationId,
      owner.fallbackUserId
    );
    if (!recipientUserId) throw new Error('agreement owner is unavailable');
    await tx
      .update(kilo_pass_org_processing_runs)
      .set({
        state: KiloPassOrgProcessingRunState.Pending,
        failure_code: null,
        lease_expires_at: null,
      })
      .where(eq(kilo_pass_org_processing_runs.id, run.id));
    await tx
      .update(kilo_pass_org_agreements)
      .set({
        processing_condition: conditionAfterRecovery(owner.processingCondition),
      })
      .where(eq(kilo_pass_org_agreements.id, input.agreementId));
    return {
      recipientUserId,
      window: { start: asDate(run.window_start), end: asDate(run.window_end) },
    };
  });
  try {
    return await db.transaction(tx =>
      issue(tx, {
        agreementId: input.agreementId,
        recipientUserId: retry.recipientUserId,
        window: retry.window,
        kind: 'regular',
      })
    );
  } catch (error) {
    await db.transaction(async tx => {
      await tx
        .update(kilo_pass_org_processing_runs)
        .set({
          state: KiloPassOrgProcessingRunState.Failed,
          lease_expires_at: null,
          failure_code: 'retry_failed',
        })
        .where(eq(kilo_pass_org_processing_runs.id, input.runId));
      await tx
        .update(kilo_pass_org_agreements)
        .set({ processing_condition: KiloPassOrgProcessingCondition.Failed })
        .where(eq(kilo_pass_org_agreements.id, input.agreementId));
    });
    throw error;
  }
}

/** The provider item is created after the durable pending agreement. */
export async function bindProviderSeatAddOnItem(input: {
  agreementId: string;
  providerSeatAddOnItemId: string;
}) {
  await db
    .update(kilo_pass_org_agreements)
    .set({ provider_seat_add_on_item_id: input.providerSeatAddOnItemId })
    .where(eq(kilo_pass_org_agreements.id, input.agreementId));
}

/** Adverse payment events stop future issuance without reversing already granted credits. */
export async function suspendAgreementForPaymentReview(providerSubscriptionId: string) {
  await db.transaction(async tx => {
    const [agreement] = await tx
      .select()
      .from(kilo_pass_org_agreements)
      .where(eq(kilo_pass_org_agreements.provider_subscription_id, providerSubscriptionId))
      .for('update');
    if (!agreement) return;
    if (
      processingCondition(agreement) === KiloPassOrgProcessingCondition.SuspendedForReview &&
      agreement.payment_review_required_at
    ) {
      return;
    }
    const suspendedAt = new Date().toISOString();
    await tx
      .update(kilo_pass_org_agreements)
      .set({
        processing_condition: KiloPassOrgProcessingCondition.SuspendedForReview,
        payment_review_required_at: suspendedAt,
      })
      .where(eq(kilo_pass_org_agreements.id, agreement.id));
    await recordAudit(tx, {
      agreementId: agreement.id,
      action: 'payment_review_suspended',
      reason: 'provider_adverse_payment_event',
      before: { processingCondition: agreement.processing_condition },
      after: {
        processingCondition: KiloPassOrgProcessingCondition.SuspendedForReview,
        paymentReviewRequiredAt: suspendedAt,
      },
      idempotencyKey: `kpo:payment-review:${agreement.id}`,
    });
  });
}

export async function clearAgreementPaymentReview(input: {
  organizationId: string;
  actorUserId: string;
  reason: string;
}) {
  return db.transaction(async tx => {
    const [agreement] = await tx
      .select()
      .from(kilo_pass_org_agreements)
      .where(
        and(
          eq(kilo_pass_org_agreements.parent_organization_id, input.organizationId),
          ne(kilo_pass_org_agreements.state, KiloPassOrgAgreementState.Ended)
        )
      )
      .for('update');
    if (!agreement) throw new Error('Kilo Pass organization agreement not found');
    if (processingCondition(agreement) !== KiloPassOrgProcessingCondition.SuspendedForReview) {
      throw new Error('agreement is not suspended for payment review');
    }
    const capacity = agreement.next_purchased_pass_capacity ?? agreement.purchased_pass_capacity;
    const { allocations } = await effectivePlan(
      tx,
      agreement.id,
      agreement.next_capacity_effective_at
        ? asDate(agreement.next_capacity_effective_at)
        : nextIssuanceBoundary(asDate(agreement.issuance_anchor_at), new Date())
    );
    const valid = validateAllocation(
      capacity,
      allocations.map(allocation => allocation.passCapacity)
    );
    const nextCondition = valid.valid
      ? KiloPassOrgProcessingCondition.Ready
      : KiloPassOrgProcessingCondition.Overallocated;
    await tx
      .update(kilo_pass_org_agreements)
      .set({ processing_condition: nextCondition, payment_review_required_at: null })
      .where(eq(kilo_pass_org_agreements.id, agreement.id));
    await recordAudit(tx, {
      agreementId: agreement.id,
      actorUserId: input.actorUserId,
      action: 'payment_review_cleared',
      reason: input.reason,
      before: {
        processingCondition: agreement.processing_condition,
        paymentReviewRequiredAt: agreement.payment_review_required_at,
      },
      after: { processingCondition: nextCondition, paymentReviewRequiredAt: null },
    });
    return { processingCondition: nextCondition };
  });
}

export async function createParentSupplement(input: {
  agreementId: string;
  recipientUserId: string;
  window: IssuanceWindow;
  paidSeatCount: number;
  providerInvoiceLineId: string;
  now: Date;
}) {
  return db.transaction(async tx => {
    const [agreement] = await tx
      .select({ agreement: kilo_pass_org_agreements, term: kilo_pass_org_term_versions })
      .from(kilo_pass_org_agreements)
      .innerJoin(
        kilo_pass_org_term_versions,
        eq(kilo_pass_org_agreements.term_version_id, kilo_pass_org_term_versions.id)
      )
      .where(eq(kilo_pass_org_agreements.id, input.agreementId))
      .for('update');
    if (!agreement) throw new Error('agreement not found');
    const snapshots = await tx
      .select()
      .from(kilo_pass_org_issuance_snapshots)
      .where(
        and(
          eq(kilo_pass_org_issuance_snapshots.agreement_id, input.agreementId),
          eq(kilo_pass_org_issuance_snapshots.window_start, input.window.start.toISOString())
        )
      );
    const issuedCapacity = snapshots.reduce(
      (total, snapshot) => total + snapshot.allocated_pass_capacity,
      0
    );
    const delta = Math.max(0, input.paidSeatCount - issuedCapacity);
    if (!delta) return { created: false };
    const ratio = bridgeRatio(input.window, { start: input.now, end: input.window.end });
    if (!ratio.numerator) return { created: false };
    const baseAmount = roundHalfUpMicrodollars(
      agreement.term.base_credit_microdollars_per_pass * delta,
      ratio.numerator,
      ratio.denominator
    );
    const bonusAmount = roundHalfUpMicrodollars(
      agreement.term.bonus_credit_microdollars_per_pass * delta,
      ratio.numerator,
      ratio.denominator
    );
    const threshold = roundHalfUpMicrodollars(
      agreement.term.unlock_spend_microdollars_per_pass * delta,
      ratio.numerator,
      ratio.denominator
    );
    const baseId = await grant(tx, {
      organizationId: agreement.agreement.parent_organization_id,
      userId: input.recipientUserId,
      microdollars: baseAmount,
      identity: `kpo:supplement:base:${input.providerInvoiceLineId}`,
      description: 'Kilo Pass organization supplement',
    });
    const bonusId =
      agreement.term.bonus_mode === KiloPassOrgBonusMode.Upfront
        ? await grant(tx, {
            organizationId: agreement.agreement.parent_organization_id,
            userId: input.recipientUserId,
            microdollars: bonusAmount,
            identity: `kpo:supplement:bonus:${input.providerInvoiceLineId}`,
            description: 'Kilo Pass organization upfront supplement bonus',
            expiresAt: input.window.end,
          })
        : null;
    const allocationPlanId =
      snapshots[0]?.allocation_plan_id ??
      (await effectivePlan(tx, input.agreementId, input.window.start)).plan.id;
    const [snapshot] = await tx
      .insert(kilo_pass_org_issuance_snapshots)
      .values({
        agreement_id: input.agreementId,
        allocation_plan_id: allocationPlanId,
        term_version_id: agreement.term.id,
        allocation_container_organization_id: agreement.agreement.parent_organization_id,
        window_start: input.window.start.toISOString(),
        window_end: input.window.end.toISOString(),
        qualifying_spend_starts_at: input.now.toISOString(),
        kind: KiloPassOrgIssuanceKind.Supplement,
        tranche_key: `supplement:${input.providerInvoiceLineId}`,
        allocated_pass_capacity: delta,
        base_credit_microdollars: baseAmount,
        bonus_credit_microdollars: bonusAmount,
        unlock_spend_microdollars: threshold,
        bonus_mode: agreement.term.bonus_mode,
        base_credit_transaction_id: baseId,
        bonus_credit_transaction_id: bonusId,
        bonus_unlocked_at: bonusId ? input.now.toISOString() : null,
      })
      .returning({ id: kilo_pass_org_issuance_snapshots.id });
    if (!snapshot) throw new Error('supplement snapshot insert failed');
    await tx.insert(kilo_pass_org_supplements).values({
      issuance_snapshot_id: snapshot.id,
      provider_invoice_line_id: input.providerInvoiceLineId,
      remaining_service_numerator: ratio.numerator,
      remaining_service_denominator: ratio.denominator,
    });
    return { created: true };
  });
}

/** Mutations must never revive or alter a completed agreement. */
async function nonEndedAgreement(organizationId: string) {
  const [result] = await db
    .select({ agreement: kilo_pass_org_agreements, term: kilo_pass_org_term_versions })
    .from(kilo_pass_org_agreements)
    .innerJoin(
      kilo_pass_org_term_versions,
      eq(kilo_pass_org_agreements.term_version_id, kilo_pass_org_term_versions.id)
    )
    .where(
      and(
        eq(kilo_pass_org_agreements.parent_organization_id, organizationId),
        ne(kilo_pass_org_agreements.state, KiloPassOrgAgreementState.Ended)
      )
    )
    .orderBy(desc(kilo_pass_org_agreements.created_at))
    .limit(1);
  return result ?? null;
}

/** Read APIs retain the last ended agreement until a newer live agreement exists. */
async function visibleAgreement(organizationId: string) {
  return (await nonEndedAgreement(organizationId)) ?? (await latestEndedAgreement(organizationId));
}

async function latestEndedAgreement(organizationId: string) {
  const [result] = await db
    .select({ agreement: kilo_pass_org_agreements, term: kilo_pass_org_term_versions })
    .from(kilo_pass_org_agreements)
    .innerJoin(
      kilo_pass_org_term_versions,
      eq(kilo_pass_org_agreements.term_version_id, kilo_pass_org_term_versions.id)
    )
    .where(
      and(
        eq(kilo_pass_org_agreements.parent_organization_id, organizationId),
        eq(kilo_pass_org_agreements.state, KiloPassOrgAgreementState.Ended)
      )
    )
    .orderBy(desc(kilo_pass_org_agreements.created_at))
    .limit(1);
  return result ?? null;
}
async function planVersion(agreementId: string) {
  const [plan] = await db
    .select({ version: kilo_pass_org_allocation_plans.version })
    .from(kilo_pass_org_allocation_plans)
    .where(eq(kilo_pass_org_allocation_plans.agreement_id, agreementId))
    .orderBy(desc(kilo_pass_org_allocation_plans.version))
    .limit(1);
  return plan?.version ?? 0;
}
function commercialState(row: { state: string }): OrganizationKiloPassCommercialState {
  return row.state as OrganizationKiloPassCommercialState;
}

function processingCondition(row: {
  processing_condition: string;
}): OrganizationKiloPassProcessingCondition {
  return row.processing_condition as OrganizationKiloPassProcessingCondition;
}

const recoverableProcessingConditions = new Set<OrganizationKiloPassProcessingCondition>([
  KiloPassOrgProcessingCondition.Blocked,
  KiloPassOrgProcessingCondition.Overallocated,
  KiloPassOrgProcessingCondition.Failed,
]);

function conditionAfterRecovery(
  condition: OrganizationKiloPassProcessingCondition
): OrganizationKiloPassProcessingCondition {
  return recoverableProcessingConditions.has(condition)
    ? KiloPassOrgProcessingCondition.Ready
    : condition;
}

function processingRunState(row: { state: string }): KiloPassOrgProcessingRunState {
  if (
    Object.values(KiloPassOrgProcessingRunState).includes(
      row.state as KiloPassOrgProcessingRunState
    )
  ) {
    return row.state as KiloPassOrgProcessingRunState;
  }
  throw new Error('invalid Kilo Pass organization processing-run state');
}

async function latestRunForAgreement(agreementId: string) {
  const [unresolvedRun] = await db
    .select()
    .from(kilo_pass_org_processing_runs)
    .where(
      and(
        eq(kilo_pass_org_processing_runs.agreement_id, agreementId),
        inArray(kilo_pass_org_processing_runs.state, [
          KiloPassOrgProcessingRunState.Blocked,
          KiloPassOrgProcessingRunState.Failed,
        ])
      )
    )
    .orderBy(asc(kilo_pass_org_processing_runs.window_start))
    .limit(1);
  if (unresolvedRun) return unresolvedRun;

  const [latestRun] = await db
    .select()
    .from(kilo_pass_org_processing_runs)
    .where(eq(kilo_pass_org_processing_runs.agreement_id, agreementId))
    .orderBy(
      desc(kilo_pass_org_processing_runs.window_start),
      desc(kilo_pass_org_processing_runs.created_at)
    )
    .limit(1);
  return latestRun ?? null;
}

async function agreementRecipientUserId(
  tx: DrizzleTransaction,
  parentOrganizationId: string,
  fallbackUserId: string | null
): Promise<string | null> {
  const [manager] = await tx
    .select({ userId: organization_memberships.kilo_user_id })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, parentOrganizationId),
        inArray(organization_memberships.role, ['owner', 'billing_manager'])
      )
    )
    .orderBy(asc(organization_memberships.joined_at))
    .limit(1);
  return manager?.userId ?? fallbackUserId;
}

async function latestIssuedCapacity(agreementId: string) {
  const [latestSnapshot] = await db
    .select({ start: kilo_pass_org_issuance_snapshots.window_start })
    .from(kilo_pass_org_issuance_snapshots)
    .where(eq(kilo_pass_org_issuance_snapshots.agreement_id, agreementId))
    .orderBy(desc(kilo_pass_org_issuance_snapshots.window_start))
    .limit(1);
  if (!latestSnapshot) return 0;
  const snapshots = await db
    .select({ capacity: kilo_pass_org_issuance_snapshots.allocated_pass_capacity })
    .from(kilo_pass_org_issuance_snapshots)
    .where(
      and(
        eq(kilo_pass_org_issuance_snapshots.agreement_id, agreementId),
        eq(kilo_pass_org_issuance_snapshots.window_start, latestSnapshot.start)
      )
    );
  return snapshots.reduce((total, snapshot) => total + snapshot.capacity, 0);
}

export const organizationKiloPassService: OrganizationKiloPassService = {
  async getSummary({ organizationId }) {
    const row = await visibleAgreement(organizationId);
    const issuedCapacity = row ? await latestIssuedCapacity(row.agreement.id) : 0;
    return !row
      ? {
          state: 'unavailable',
          commercialState: null,
          processingCondition: null,
          agreement: null,
        }
      : {
          state: commercialState(row.agreement),
          commercialState: commercialState(row.agreement),
          processingCondition: processingCondition(row.agreement),
          agreement: {
            tier: row.term.tier as Tier,
            cadence: row.agreement.cadence === KiloPassCadence.Yearly ? 'yearly' : 'monthly',
            paidSeatCount:
              processingCondition(row.agreement) === KiloPassOrgProcessingCondition.Ready
                ? Math.max(row.agreement.purchased_pass_capacity, issuedCapacity)
                : row.agreement.purchased_pass_capacity,
            planVersion: await planVersion(row.agreement.id),
            paidThrough: iso(row.agreement.paid_until),
            terms: displayTerms(row.term),
          },
        };
  },
  async getSetup({ organizationId }) {
    const [org] = await db
      .select({ seats: organizations.seat_count })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    if (!org) throw new Error('organization not found');
    const row = await nonEndedAgreement(organizationId);
    const [seatPurchase] = row
      ? []
      : await db
          .select({
            billingCycle: organization_seats_purchases.billing_cycle,
            expiresAt: organization_seats_purchases.expires_at,
            seatCount: organization_seats_purchases.seat_count,
          })
          .from(organization_seats_purchases)
          .where(
            and(
              eq(organization_seats_purchases.organization_id, organizationId),
              eq(organization_seats_purchases.subscription_status, 'active')
            )
          )
          .orderBy(desc(organization_seats_purchases.created_at))
          .limit(1);
    if (!row && !seatPurchase) throw new Error('active organization seat subscription required');
    const renewalAt = row
      ? (row.agreement.paid_until ?? row.agreement.issuance_anchor_at)
      : seatPurchase.expiresAt;
    const children = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(
        and(
          eq(organizations.parent_organization_id, organizationId),
          isNull(organizations.deleted_at)
        )
      );
    const cadence =
      (row?.agreement.cadence ?? seatPurchase?.billingCycle) === 'yearly' ? 'yearly' : 'monthly';
    return {
      paidSeatCount: row?.agreement.purchased_pass_capacity ?? seatPurchase?.seatCount ?? org.seats,
      cadence,
      renewalAt: requiredIso(renewalAt),
      planVersion: row ? await planVersion(row.agreement.id) : 0,
      children,
      terms: standardDisplayTerms(cadence),
    };
  },
  async getDetail({ organizationId }) {
    const row = await visibleAgreement(organizationId);
    if (!row) throw new Error('Kilo Pass organization agreement not found');
    const now = new Date();
    const nextWindowStart = nextIssuanceBoundary(asDate(row.agreement.issuance_anchor_at), now);
    const { allocations } = await db.transaction(tx =>
      effectivePlan(tx, row.agreement.id, nextWindowStart)
    );
    const directChildren = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(
        and(
          eq(organizations.parent_organization_id, organizationId),
          isNull(organizations.deleted_at)
        )
      );
    const [latestSnapshot] = await db
      .select({
        start: kilo_pass_org_issuance_snapshots.window_start,
        end: kilo_pass_org_issuance_snapshots.window_end,
      })
      .from(kilo_pass_org_issuance_snapshots)
      .where(eq(kilo_pass_org_issuance_snapshots.agreement_id, row.agreement.id))
      .orderBy(desc(kilo_pass_org_issuance_snapshots.window_start))
      .limit(1);
    const snapshots = latestSnapshot
      ? await db
          .select()
          .from(kilo_pass_org_issuance_snapshots)
          .where(
            and(
              eq(kilo_pass_org_issuance_snapshots.agreement_id, row.agreement.id),
              eq(kilo_pass_org_issuance_snapshots.window_start, latestSnapshot.start)
            )
          )
      : [];
    const issuedCapacity = snapshots.reduce(
      (total, snapshot) => total + snapshot.allocated_pass_capacity,
      0
    );
    const paidSeatCount =
      processingCondition(row.agreement) === KiloPassOrgProcessingCondition.Ready
        ? Math.max(row.agreement.purchased_pass_capacity, issuedCapacity)
        : row.agreement.purchased_pass_capacity;
    const pendingCapacityApplies =
      row.agreement.next_purchased_pass_capacity !== null &&
      row.agreement.next_capacity_effective_at !== null &&
      nextWindowStart >= asDate(row.agreement.next_capacity_effective_at);
    const nextPaidSeatCount = pendingCapacityApplies
      ? (row.agreement.next_purchased_pass_capacity ?? paidSeatCount)
      : paidSeatCount;
    const valid = validateAllocation(
      nextPaidSeatCount,
      allocations.map(a => a.passCapacity)
    );
    const organizationIds = [
      organizationId,
      ...allocations.map(allocation => allocation.organizationId),
      ...directChildren.map(child => child.id),
      ...snapshots.map(snapshot => snapshot.allocation_container_organization_id),
    ];
    const allocationOrganizations = organizationIds.length
      ? await db
          .select({ id: organizations.id, name: organizations.name })
          .from(organizations)
          .where(inArray(organizations.id, organizationIds))
      : [];
    const names = new Map(
      allocationOrganizations.map(organization => [organization.id, organization.name])
    );
    const currentAllocations = new Map<
      string,
      {
        organizationId: string;
        passCount: number;
        baseCreditsMicrodollars: number;
        qualifyingSpendMicrodollars: number;
        unlockTargetMicrodollars: number;
        bonusCreditsMicrodollars: number;
        bonusMode: KiloPassOrgBonusMode;
        allBonusUnlocked: boolean;
        hasProratedCredits: boolean;
      }
    >();
    for (const snapshot of snapshots) {
      const current = currentAllocations.get(snapshot.allocation_container_organization_id);
      currentAllocations.set(snapshot.allocation_container_organization_id, {
        organizationId: snapshot.allocation_container_organization_id,
        passCount: (current?.passCount ?? 0) + snapshot.allocated_pass_capacity,
        baseCreditsMicrodollars:
          (current?.baseCreditsMicrodollars ?? 0) + snapshot.base_credit_microdollars,
        qualifyingSpendMicrodollars:
          (current?.qualifyingSpendMicrodollars ?? 0) + snapshot.qualifying_spend_microdollars,
        unlockTargetMicrodollars:
          (current?.unlockTargetMicrodollars ?? 0) + snapshot.unlock_spend_microdollars,
        bonusCreditsMicrodollars:
          (current?.bonusCreditsMicrodollars ?? 0) + snapshot.bonus_credit_microdollars,
        bonusMode: snapshot.bonus_mode,
        allBonusUnlocked:
          (current?.allBonusUnlocked ?? true) && snapshot.bonus_unlocked_at !== null,
        hasProratedCredits:
          (current?.hasProratedCredits ?? false) ||
          snapshot.kind === KiloPassOrgIssuanceKind.Bridge ||
          snapshot.kind === KiloPassOrgIssuanceKind.Supplement,
      });
    }
    for (const child of directChildren) {
      if (currentAllocations.has(child.id)) continue;
      currentAllocations.set(child.id, {
        organizationId: child.id,
        passCount: 0,
        baseCreditsMicrodollars: 0,
        qualifyingSpendMicrodollars: 0,
        unlockTargetMicrodollars: 0,
        bonusCreditsMicrodollars: 0,
        bonusMode: KiloPassOrgBonusMode.AfterBase,
        allBonusUnlocked: false,
        hasProratedCredits: false,
      });
    }
    const currentWindowEnded = latestSnapshot ? asDate(latestSnapshot.end) <= now : false;
    const latestRun = await latestRunForAgreement(row.agreement.id);
    return {
      state: commercialState(row.agreement),
      commercialState: commercialState(row.agreement),
      processingCondition: processingCondition(row.agreement),
      tier: row.term.tier as Tier,
      cadence: row.agreement.cadence === KiloPassCadence.Yearly ? 'yearly' : 'monthly',
      terms: displayTerms(row.term),
      paidSeatCount,
      nextPaidSeatCount,
      planVersion: await planVersion(row.agreement.id),
      paidThrough: iso(row.agreement.paid_until),
      currentWindow: latestSnapshot
        ? { startsAt: requiredIso(latestSnapshot.start), endsAt: requiredIso(latestSnapshot.end) }
        : null,
      nextWindowStartsAt: nextWindowStart.toISOString(),
      latestRun: latestRun
        ? {
            id: latestRun.id,
            state: processingRunState(latestRun),
            window: {
              startsAt: requiredIso(latestRun.window_start),
              endsAt: requiredIso(latestRun.window_end),
            },
            failureCode: latestRun.failure_code,
            attemptCount: latestRun.attempt_count,
          }
        : null,
      currentAllocations: [...currentAllocations.values()].map(allocation => ({
        organizationId: allocation.organizationId,
        organizationName: names.get(allocation.organizationId) ?? 'Unknown organization',
        passCount: allocation.passCount,
        kind:
          allocation.organizationId === organizationId ? ('parent' as const) : ('child' as const),
        hasProratedCredits: allocation.hasProratedCredits,
        baseCreditsMicrodollars: allocation.baseCreditsMicrodollars,
        qualifyingSpendMicrodollars: allocation.qualifyingSpendMicrodollars,
        unlockTargetMicrodollars: allocation.unlockTargetMicrodollars,
        bonusCreditsMicrodollars: allocation.bonusCreditsMicrodollars,
        bonusState:
          allocation.passCount === 0
            ? 'locked'
            : allocation.bonusMode === KiloPassOrgBonusMode.Upfront
              ? 'upfront_granted'
              : allocation.allBonusUnlocked
                ? 'unlocked'
                : currentWindowEnded &&
                    allocation.qualifyingSpendMicrodollars >= allocation.unlockTargetMicrodollars
                  ? 'missed'
                  : currentWindowEnded
                    ? 'expired'
                    : 'locked',
      })),
      nextAllocations: [
        ...directChildren.map(child => ({
          organizationId: child.id,
          organizationName: child.name,
          passCount:
            allocations.find(allocation => allocation.organizationId === child.id)?.passCapacity ??
            0,
          kind: 'child' as const,
        })),
        ...allocations
          .filter(
            allocation => !directChildren.some(child => child.id === allocation.organizationId)
          )
          .map(allocation => ({
            organizationId: allocation.organizationId,
            organizationName: names.get(allocation.organizationId) ?? 'Unknown organization',
            passCount: allocation.passCapacity,
            kind: 'child' as const,
          })),
        {
          organizationId,
          organizationName: names.get(organizationId) ?? 'Unknown organization',
          passCount: valid.valid ? valid.parentDefaultCapacity : 0,
          kind: 'parent' as const,
        },
      ],
    };
  },
  async getUsage({ organizationId }) {
    const summary = await this.getSummary({ organizationId });
    if (!summary.agreement || summary.commercialState === 'ended') return null;
    const detail = await this.getDetail({ organizationId });
    if (!detail.currentWindow) return null;
    return {
      tier: detail.tier,
      terms: detail.terms,
      currentWindow: detail.currentWindow,
      currentAllocations: detail.currentAllocations,
    };
  },
  async createCheckout(input, createProviderCheckout) {
    return createProviderCheckout(input);
  },
  async updateAllocation(input) {
    const row = await nonEndedAgreement(input.organizationId);
    if (!row) throw new Error('Kilo Pass organization agreement not found');
    const anchor = asDate(row.agreement.issuance_anchor_at);
    const result = await db.transaction(async tx => {
      const [agreement] = await tx
        .select()
        .from(kilo_pass_org_agreements)
        .where(eq(kilo_pass_org_agreements.id, row.agreement.id))
        .for('update');
      if (!agreement) throw new Error('agreement not found');
      const blockedRuns = await tx
        .select({
          id: kilo_pass_org_processing_runs.id,
          windowStart: kilo_pass_org_processing_runs.window_start,
        })
        .from(kilo_pass_org_processing_runs)
        .where(
          and(
            eq(kilo_pass_org_processing_runs.agreement_id, agreement.id),
            eq(kilo_pass_org_processing_runs.state, KiloPassOrgProcessingRunState.Blocked)
          )
        )
        .orderBy(asc(kilo_pass_org_processing_runs.window_start))
        .for('update');
      let blockedRun: (typeof blockedRuns)[number] | null = null;
      for (const candidate of blockedRuns) {
        const [snapshot] = await tx
          .select({ id: kilo_pass_org_issuance_snapshots.id })
          .from(kilo_pass_org_issuance_snapshots)
          .where(
            and(
              eq(kilo_pass_org_issuance_snapshots.agreement_id, agreement.id),
              eq(kilo_pass_org_issuance_snapshots.window_start, candidate.windowStart)
            )
          )
          .limit(1);
        if (!snapshot) {
          blockedRun = candidate;
          break;
        }
      }
      const effectiveWindowStart = blockedRun
        ? asDate(blockedRun.windowStart)
        : nextIssuanceBoundary(anchor, new Date());
      const [latest] = await tx
        .select({ version: kilo_pass_org_allocation_plans.version })
        .from(kilo_pass_org_allocation_plans)
        .where(eq(kilo_pass_org_allocation_plans.agreement_id, agreement.id))
        .orderBy(desc(kilo_pass_org_allocation_plans.version))
        .limit(1);
      if (!latest || latest.version !== input.expectedPlanVersion)
        throw new Error('STALE_PLAN_VERSION');
      const allocations = input.allocations.map(allocation => ({
        organizationId: allocation.childOrganizationId,
        passCapacity: allocation.passCount,
      }));
      await assertParentAndChildren(tx, agreement.parent_organization_id, allocations);
      const valid = validateAllocation(
        agreement.next_purchased_pass_capacity ?? agreement.purchased_pass_capacity,
        allocations.map(allocation => allocation.passCapacity)
      );
      if (!valid.valid) throw new Error(`invalid allocation: ${valid.reason}`);
      await replacePlanAtWindow(tx, {
        agreementId: agreement.id,
        effectiveAt: effectiveWindowStart,
        version: latest.version + 1,
        actorId: input.actorUserId,
        allocations,
      });
      if (blockedRun) await reclaimBlockedProcessingRun(tx, blockedRun.id);
      const nextCondition = conditionAfterRecovery(processingCondition(agreement));
      await tx
        .update(kilo_pass_org_agreements)
        .set({ processing_condition: nextCondition })
        .where(eq(kilo_pass_org_agreements.id, agreement.id));
      await recordAudit(tx, {
        agreementId: agreement.id,
        actorUserId: input.actorUserId,
        action: 'allocation_plan_updated',
        reason: blockedRun ? 'blocked_window_reconciliation' : 'future_allocation_update',
        before: { planVersion: latest.version },
        after: {
          planVersion: latest.version + 1,
          effectiveWindowStart: effectiveWindowStart.toISOString(),
          allocations,
          processingCondition: nextCondition,
        },
      });
      return { planVersion: latest.version + 1, effectiveWindowStart };
    });
    return {
      planVersion: result.planVersion,
      nextWindowStartsAt: result.effectiveWindowStart.toISOString(),
    };
  },
  async cancel({ organizationId, actorUserId }, scheduleProviderCancellation) {
    const row = await nonEndedAgreement(organizationId);
    if (!row) throw new Error('Kilo Pass organization agreement not found');
    const { provider_subscription_id, provider_seat_add_on_item_id } = row.agreement;
    if (!provider_subscription_id || !provider_seat_add_on_item_id) {
      throw new Error('Kilo Pass organization agreement has no provider subscription item');
    }
    await scheduleProviderCancellation({
      providerSubscriptionId: provider_subscription_id,
      providerSeatAddOnItemId: provider_seat_add_on_item_id,
    });
    await db.transaction(async tx => {
      await tx
        .update(kilo_pass_org_agreements)
        .set({
          state: KiloPassOrgAgreementState.CancelAtPeriodEnd,
          cancellation_effective_at: row.agreement.paid_until,
        })
        .where(eq(kilo_pass_org_agreements.id, row.agreement.id));
      await recordAudit(tx, {
        agreementId: row.agreement.id,
        actorUserId,
        action: 'cancellation_scheduled',
        reason: 'self_service',
        before: { state: row.agreement.state },
        after: {
          state: KiloPassOrgAgreementState.CancelAtPeriodEnd,
          effectiveAt: row.agreement.paid_until,
        },
      });
    });
    return {
      state: 'cancel_at_period_end',
      effectiveAt: iso(row.agreement.paid_until) ?? new Date().toISOString(),
    };
  },
  async resume({ organizationId, actorUserId }, resumeProviderCancellation) {
    const row = await nonEndedAgreement(organizationId);
    if (!row) throw new Error('Kilo Pass organization agreement not found');
    if (row.agreement.state === KiloPassOrgAgreementState.Active) return { state: 'active' };
    if (row.agreement.state !== KiloPassOrgAgreementState.CancelAtPeriodEnd) {
      throw new Error('Kilo Pass organization agreement cannot be resumed');
    }
    if (!row.agreement.provider_subscription_id || !row.agreement.provider_seat_add_on_item_id) {
      throw new Error('Kilo Pass organization agreement has no provider subscription item');
    }
    await resumeProviderCancellation({
      providerSubscriptionId: row.agreement.provider_subscription_id,
      providerSeatAddOnItemId: row.agreement.provider_seat_add_on_item_id,
    });
    await db.transaction(async tx => {
      await tx
        .update(kilo_pass_org_agreements)
        .set({ state: KiloPassOrgAgreementState.Active, cancellation_effective_at: null })
        .where(eq(kilo_pass_org_agreements.id, row.agreement.id));
      await recordAudit(tx, {
        agreementId: row.agreement.id,
        actorUserId,
        action: 'cancellation_resumed',
        reason: 'self_service',
        before: { state: row.agreement.state },
        after: { state: KiloPassOrgAgreementState.Active },
      });
    });
    return { state: 'active' };
  },
  async retryRun({ organizationId, runId, actorUserId }) {
    const row = await nonEndedAgreement(organizationId);
    if (!row) throw new Error('Kilo Pass organization agreement not found');
    const run = await db
      .select({
        windowStart: kilo_pass_org_processing_runs.window_start,
        windowEnd: kilo_pass_org_processing_runs.window_end,
      })
      .from(kilo_pass_org_processing_runs)
      .where(
        and(
          eq(kilo_pass_org_processing_runs.id, runId),
          eq(kilo_pass_org_processing_runs.agreement_id, row.agreement.id)
        )
      )
      .limit(1);
    if (!run[0]) throw new Error('processing run not found');
    await retryOrganizationPassRun({ agreementId: row.agreement.id, runId });
    await db.transaction(tx =>
      recordAudit(tx, {
        agreementId: row.agreement.id,
        actorUserId,
        action: 'processing_run_retried',
        reason: 'self_service',
        before: { runId },
        after: { runId, state: 'retried' },
      })
    );
    return {
      runId,
      window: { startsAt: requiredIso(run[0].windowStart), endsAt: requiredIso(run[0].windowEnd) },
    };
  },
};

export function nextIssuanceBoundary(anchor: Date, now: Date): Date {
  let monthIndex = Math.max(
    0,
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + now.getUTCMonth() - anchor.getUTCMonth()
  );
  let boundary = monthlyWindowFromOriginalAnchor(anchor, monthIndex).start;
  while (boundary <= now) {
    monthIndex += 1;
    boundary = monthlyWindowFromOriginalAnchor(anchor, monthIndex).start;
  }
  return boundary;
}

function intersectionWindow(left: IssuanceWindow, right: IssuanceWindow): IssuanceWindow | null {
  const start = new Date(Math.max(left.start.getTime(), right.start.getTime()));
  const end = new Date(Math.min(left.end.getTime(), right.end.getTime()));
  return start < end ? { start, end } : null;
}

export type OrganizationPassIssuanceCronResult = {
  examined: number;
  processed: number;
  issued: number;
  blocked: number;
  failed: number;
  failures: { agreementId: string; message: string }[];
};

/**
 * Replays due agreement-relative monthly windows in chronological order. Each
 * agreement's catch-up sequence is one transaction: a blocked or failed window
 * cannot leave later windows issued ahead of it.
 */
export async function runOrganizationPassIssuanceCron(
  database: typeof db = db,
  now = new Date()
): Promise<OrganizationPassIssuanceCronResult> {
  const agreements = await database
    .select({
      agreementId: kilo_pass_org_agreements.id,
      anchor: kilo_pass_org_agreements.issuance_anchor_at,
      paidFrom: kilo_pass_org_agreements.paid_from,
      paidUntil: kilo_pass_org_agreements.paid_until,
      cadence: kilo_pass_org_agreements.cadence,
      parentOrganizationId: organizations.id,
      fallbackUserId: organizations.created_by_kilo_user_id,
    })
    .from(kilo_pass_org_agreements)
    .innerJoin(organizations, eq(kilo_pass_org_agreements.parent_organization_id, organizations.id))
    .where(
      and(
        inArray(kilo_pass_org_agreements.state, [
          KiloPassOrgAgreementState.Active,
          KiloPassOrgAgreementState.CancelAtPeriodEnd,
        ]),
        eq(kilo_pass_org_agreements.processing_condition, KiloPassOrgProcessingCondition.Ready),
        isNull(organizations.deleted_at)
      )
    )
    .orderBy(asc(kilo_pass_org_agreements.paid_until));

  let processed = 0;
  let issued = 0;
  let blocked = 0;
  const failures: { agreementId: string; message: string }[] = [];
  for (const agreement of agreements) {
    if (!agreement.paidFrom || !agreement.paidUntil) continue;
    const paidFrom = agreement.paidFrom;
    const paidUntil = agreement.paidUntil;
    const recipientUserId = await database.transaction(tx =>
      agreementRecipientUserId(tx, agreement.parentOrganizationId, agreement.fallbackUserId)
    );
    if (!recipientUserId) {
      failures.push({
        agreementId: agreement.agreementId,
        message: 'agreement owner is unavailable',
      });
      continue;
    }
    let result: { didIssue: number; didBlock: number };
    try {
      result = await database.transaction(async tx => {
        const anchor = asDate(agreement.anchor);
        const paid = { start: asDate(paidFrom), end: asDate(paidUntil) };
        const firstMonthIndex = monthIndexForDate(anchor, paid.start);
        let monthIndex = firstMonthIndex;
        let window = monthlyWindowFromOriginalAnchor(anchor, monthIndex);
        let didIssue = 0;
        let didBlock = 0;
        const maximumWindows =
          agreement.cadence === KiloPassCadence.Yearly ? 12 : Number.MAX_SAFE_INTEGER;
        while (
          window.start < paid.end &&
          window.start <= now &&
          monthIndex - firstMonthIndex < maximumWindows
        ) {
          // The partial bridge already covers the containing month. Begin regular
          // issuance at the first complete agreement month after paid-from.
          if (window.start < paid.start) {
            monthIndex += 1;
            window = monthlyWindowFromOriginalAnchor(anchor, monthIndex);
            continue;
          }
          if (window.end > paid.end) break;
          const outcome = await issue(tx, {
            agreementId: agreement.agreementId,
            recipientUserId,
            window,
            kind: 'regular',
          });
          if (outcome.blocked) {
            didBlock += 1;
            break;
          }
          if (outcome.issued) didIssue += 1;
          monthIndex += 1;
          window = monthlyWindowFromOriginalAnchor(anchor, monthIndex);
        }
        return { didIssue, didBlock };
      });
    } catch (error) {
      await database.transaction(async tx => {
        await tx
          .update(kilo_pass_org_processing_runs)
          .set({
            state: KiloPassOrgProcessingRunState.Failed,
            lease_expires_at: null,
            failure_code: 'issuance_failed',
          })
          .where(
            and(
              eq(kilo_pass_org_processing_runs.agreement_id, agreement.agreementId),
              eq(kilo_pass_org_processing_runs.state, KiloPassOrgProcessingRunState.Running)
            )
          );
        await tx
          .update(kilo_pass_org_agreements)
          .set({ processing_condition: KiloPassOrgProcessingCondition.Failed })
          .where(eq(kilo_pass_org_agreements.id, agreement.agreementId));
      });
      failures.push({
        agreementId: agreement.agreementId,
        message: error instanceof Error ? error.message : 'Unknown issuance failure',
      });
      continue;
    }
    processed += 1;
    issued += result.didIssue;
    blocked += result.didBlock;
  }
  return {
    examined: agreements.length,
    processed,
    issued,
    blocked,
    failed: failures.length,
    failures,
  };
}

function monthIndexForDate(anchor: Date, date: Date): number {
  let index = Math.max(
    0,
    (date.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
      date.getUTCMonth() -
      anchor.getUTCMonth()
  );
  while (monthlyWindowFromOriginalAnchor(anchor, index).start > date && index > 0) index -= 1;
  while (monthlyWindowFromOriginalAnchor(anchor, index).end <= date) index += 1;
  return index;
}
