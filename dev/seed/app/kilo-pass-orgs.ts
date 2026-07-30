import { randomUUID } from 'node:crypto';

import {
  credit_transactions,
  kilocode_users,
  kilo_pass_org_agreements,
  kilo_pass_org_allocation_plan_rows,
  kilo_pass_org_allocation_plans,
  kilo_pass_org_audit_records,
  kilo_pass_org_issuance_snapshots,
  kilo_pass_org_processing_runs,
  kilo_pass_org_term_versions,
  organization_memberships,
  organization_seats_purchases,
  organizations,
} from '@kilocode/db/schema';
import { eq, ilike, inArray } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { createSeedStripeCustomer, deleteSeedStripeCustomer } from '../lib/stripe';
import type { SeedResult } from '../index';

const PREFIX = 'dev-seed:kilo-pass-orgs';
const ORG_PREFIX = `[${PREFIX}]`;
const USER_EMAIL_PATTERN = 'dev-seed-kilo-pass-orgs-%';
const CUSTOM_TERM_KEY = `${PREFIX}:custom-tier-49-monthly-v1`;
const STANDARD_TERM_KEY = 'standard-tier_49-monthly-v1';

export const usage =
  '[--database-url=<postgres-url>] [--seat-subscription-id=<stripe-test-subscription-id>]';

function printUsage(): void {
  console.log(
    'Usage: pnpm dev:seed app:kilo-pass-orgs [--database-url=<postgres-url>] ' +
      '[--seat-subscription-id=<stripe-test-subscription-id>] [--json]'
  );
  console.log('');
  console.log(
    'Creates role, setup, active, pending, cancellation, processing-failure, and ended fixtures.'
  );
  console.log('');
  console.log(
    'Pass a real test-mode seat subscription ID to make the clean setup organization ready for '
  );
  console.log(
    'the Stripe-backed purchase flow. The seed never creates or modifies that subscription.'
  );
}

function isoAtUtcMonthOffset(offset: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString();
}

async function cleanup(): Promise<void> {
  const db = getSeedDb();
  const seedOrganizations = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(ilike(organizations.name, `${ORG_PREFIX}%`));
  const organizationIds = seedOrganizations.map(organization => organization.id);

  if (organizationIds.length > 0) {
    const agreements = await db
      .select({ id: kilo_pass_org_agreements.id })
      .from(kilo_pass_org_agreements)
      .where(inArray(kilo_pass_org_agreements.parent_organization_id, organizationIds));
    const agreementIds = agreements.map(agreement => agreement.id);

    await db
      .delete(kilo_pass_org_issuance_snapshots)
      .where(
        inArray(
          kilo_pass_org_issuance_snapshots.allocation_container_organization_id,
          organizationIds
        )
      );
    if (agreementIds.length > 0) {
      await db
        .delete(kilo_pass_org_audit_records)
        .where(inArray(kilo_pass_org_audit_records.agreement_id, agreementIds));
      await db
        .delete(kilo_pass_org_processing_runs)
        .where(inArray(kilo_pass_org_processing_runs.agreement_id, agreementIds));
      await db
        .delete(kilo_pass_org_allocation_plans)
        .where(inArray(kilo_pass_org_allocation_plans.agreement_id, agreementIds));
      await db
        .delete(kilo_pass_org_agreements)
        .where(inArray(kilo_pass_org_agreements.id, agreementIds));
    }
    await db
      .delete(credit_transactions)
      .where(inArray(credit_transactions.organization_id, organizationIds));
    await db
      .delete(organization_seats_purchases)
      .where(inArray(organization_seats_purchases.organization_id, organizationIds));
    await db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.organization_id, organizationIds));
    await db
      .update(organizations)
      .set({ parent_organization_id: null })
      .where(inArray(organizations.parent_organization_id, organizationIds));
    await db.delete(organizations).where(inArray(organizations.id, organizationIds));
  }

  await db
    .delete(kilo_pass_org_term_versions)
    .where(eq(kilo_pass_org_term_versions.version_key, CUSTOM_TERM_KEY));

  const seedUsers = await db
    .select({ id: kilocode_users.id, stripeCustomerId: kilocode_users.stripe_customer_id })
    .from(kilocode_users)
    .where(ilike(kilocode_users.google_user_email, USER_EMAIL_PATTERN));
  if (seedUsers.length > 0) {
    const userIds = seedUsers.map(user => user.id);
    await db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.kilo_user_id, userIds));
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, userIds));
    await Promise.all(seedUsers.map(user => deleteSeedStripeCustomer(user.stripeCustomerId)));
  }
}

async function insertUser(input: {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
}): Promise<string> {
  const db = getSeedDb();
  const customer = await createSeedStripeCustomer({
    email: input.email,
    name: input.name,
    kiloUserId: input.id,
  });
  try {
    await db.insert(kilocode_users).values({
      id: input.id,
      google_user_email: input.email,
      google_user_name: input.name,
      google_user_image_url: `https://example.com/${input.id}.png`,
      normalized_email: input.email,
      stripe_customer_id: customer.id,
      has_validation_stytch: true,
      customer_source: 'dev-seed',
      is_admin: input.isAdmin,
    });
    return customer.id;
  } catch (error) {
    await deleteSeedStripeCustomer(customer.id);
    throw error;
  }
}

async function insertPlan(input: {
  agreementId: string;
  effectiveWindowStart: string;
  version: number;
  actorId: string;
  allocations: Array<{ organizationId: string; passCapacity: number }>;
}): Promise<string> {
  const db = getSeedDb();
  const [plan] = await db
    .insert(kilo_pass_org_allocation_plans)
    .values({
      agreement_id: input.agreementId,
      effective_window_start: input.effectiveWindowStart,
      version: input.version,
      created_by_kilo_user_id: input.actorId,
    })
    .returning({ id: kilo_pass_org_allocation_plans.id });
  if (!plan) throw new Error('allocation plan insert failed');
  if (input.allocations.length > 0) {
    await db.insert(kilo_pass_org_allocation_plan_rows).values(
      input.allocations.map(allocation => ({
        allocation_plan_id: plan.id,
        allocation_container_organization_id: allocation.organizationId,
        pass_capacity: allocation.passCapacity,
      }))
    );
  }
  return plan.id;
}

async function insertSeatPurchase(input: {
  organizationId: string;
  seatCount: number;
  subscriptionId?: string;
}): Promise<string> {
  const subscriptionId = input.subscriptionId ?? `sub_dev_seed_kpo_${randomUUID()}`;
  await getSeedDb()
    .insert(organization_seats_purchases)
    .values({
      organization_id: input.organizationId,
      subscription_stripe_id: subscriptionId,
      seat_count: input.seatCount,
      amount_usd: input.seatCount * 49,
      subscription_status: 'active',
      starts_at: isoAtUtcMonthOffset(-1),
      expires_at: isoAtUtcMonthOffset(1),
      billing_cycle: 'monthly',
      idempotency_key: `${PREFIX}:seats:${randomUUID()}`,
    });
  return subscriptionId;
}

async function insertScenarioParent(input: {
  label: string;
  ownerId: string;
  stripeCustomerId: string;
  seatCount: number;
}): Promise<string> {
  const [organization] = await getSeedDb()
    .insert(organizations)
    .values({
      name: `${ORG_PREFIX} ${input.label}`,
      created_by_kilo_user_id: input.ownerId,
      stripe_customer_id: input.stripeCustomerId,
      plan: 'teams',
      seat_count: input.seatCount,
      require_seats: true,
    })
    .returning({ id: organizations.id });
  if (!organization) throw new Error(`${input.label} organization insert failed`);
  await getSeedDb().insert(organization_memberships).values({
    organization_id: organization.id,
    kilo_user_id: input.ownerId,
    role: 'owner',
  });
  return organization.id;
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const databaseUrlArgument = args.find(argument => argument.startsWith('--database-url='));
  const seatSubscriptionArgument = args.find(argument =>
    argument.startsWith('--seat-subscription-id=')
  );
  const unexpectedArguments = args.filter(
    argument =>
      !argument.startsWith('--database-url=') && !argument.startsWith('--seat-subscription-id=')
  );
  if (unexpectedArguments.length > 0) {
    printUsage();
    throw new Error(`Unexpected arguments: ${unexpectedArguments.join(' ')}`);
  }
  if (databaseUrlArgument) {
    const databaseUrl = databaseUrlArgument.slice('--database-url='.length);
    if (!databaseUrl) throw new Error('--database-url requires a PostgreSQL URL');
    process.env.POSTGRES_URL = databaseUrl;
  }
  const suppliedSeatSubscriptionId = seatSubscriptionArgument?.slice(
    '--seat-subscription-id='.length
  );
  if (seatSubscriptionArgument && !suppliedSeatSubscriptionId) {
    throw new Error('--seat-subscription-id requires a Stripe test subscription ID');
  }
  if (suppliedSeatSubscriptionId && !suppliedSeatSubscriptionId.startsWith('sub_')) {
    throw new Error('--seat-subscription-id must start with sub_');
  }

  console.log('Resetting the Kilo Pass organization fixture...');
  await cleanup();

  const db = getSeedDb();
  const ownerId = randomUUID();
  const adminId = randomUUID();
  const memberId = randomUUID();
  const childOwnerId = randomUUID();
  const unrelatedUserId = randomUUID();
  const ownerEmail = 'dev-seed-kilo-pass-orgs-owner@example.com';
  const adminEmail = 'dev-seed-kilo-pass-orgs-admin@admin.example.com';
  const memberEmail = 'dev-seed-kilo-pass-orgs-member@example.com';
  const childOwnerEmail = 'dev-seed-kilo-pass-orgs-child-owner@example.com';
  const unrelatedUserEmail = 'dev-seed-kilo-pass-orgs-unrelated@example.com';
  let ownerStripeCustomerId: string | null = null;
  let adminStripeCustomerId: string | null = null;
  let memberStripeCustomerId: string | null = null;
  let childOwnerStripeCustomerId: string | null = null;
  let unrelatedStripeCustomerId: string | null = null;

  try {
    ownerStripeCustomerId = await insertUser({
      id: ownerId,
      email: ownerEmail,
      name: 'Kilo Pass Org Owner',
      isAdmin: false,
    });
    adminStripeCustomerId = await insertUser({
      id: adminId,
      email: adminEmail,
      name: 'Kilo Pass Org Admin',
      isAdmin: true,
    });
    memberStripeCustomerId = await insertUser({
      id: memberId,
      email: memberEmail,
      name: 'Kilo Pass Org Member',
      isAdmin: false,
    });
    childOwnerStripeCustomerId = await insertUser({
      id: childOwnerId,
      email: childOwnerEmail,
      name: 'Kilo Pass Child Owner',
      isAdmin: false,
    });
    unrelatedStripeCustomerId = await insertUser({
      id: unrelatedUserId,
      email: unrelatedUserEmail,
      name: 'Kilo Pass Unrelated User',
      isAdmin: false,
    });

    const [standardTerm] = await db
      .insert(kilo_pass_org_term_versions)
      .values({
        version_key: STANDARD_TERM_KEY,
        tier: 'tier_49',
        cadence: 'monthly',
        billing_price_microdollars_per_pass: 49_000_000,
        base_credit_microdollars_per_pass: 49_000_000,
        bonus_credit_microdollars_per_pass: 12_000_000,
        unlock_spend_microdollars_per_pass: 49_000_000,
        bonus_mode: 'after_base',
      })
      .onConflictDoNothing()
      .returning({ id: kilo_pass_org_term_versions.id });
    const standardTermId =
      standardTerm?.id ??
      (
        await db
          .select({ id: kilo_pass_org_term_versions.id })
          .from(kilo_pass_org_term_versions)
          .where(eq(kilo_pass_org_term_versions.version_key, STANDARD_TERM_KEY))
          .limit(1)
      )[0]?.id;
    if (!standardTermId) throw new Error('standard Kilo Pass organization term is unavailable');

    const [customTerm] = await db
      .insert(kilo_pass_org_term_versions)
      .values({
        version_key: CUSTOM_TERM_KEY,
        tier: 'tier_49',
        cadence: 'monthly',
        billing_price_microdollars_per_pass: 55_000_000,
        base_credit_microdollars_per_pass: 52_000_000,
        bonus_credit_microdollars_per_pass: 15_000_000,
        unlock_spend_microdollars_per_pass: 52_000_000,
        bonus_mode: 'upfront',
        created_by_kilo_user_id: adminId,
      })
      .returning({ id: kilo_pass_org_term_versions.id });
    if (!customTerm) throw new Error('custom Kilo Pass organization term insert failed');

    const setupParentId = await insertScenarioParent({
      label: 'Setup parent',
      ownerId,
      stripeCustomerId: ownerStripeCustomerId,
      seatCount: 6,
    });
    const [setupChildOne, setupChildTwo] = await db
      .insert(organizations)
      .values([
        {
          name: `${ORG_PREFIX} Setup child one`,
          parent_organization_id: setupParentId,
          plan: 'teams',
        },
        {
          name: `${ORG_PREFIX} Setup child two`,
          parent_organization_id: setupParentId,
          plan: 'teams',
        },
      ])
      .returning({ id: organizations.id });
    if (!setupChildOne || !setupChildTwo) throw new Error('setup child organization insert failed');
    await db.insert(organization_memberships).values([
      { organization_id: setupParentId, kilo_user_id: adminId, role: 'billing_manager' },
      { organization_id: setupParentId, kilo_user_id: memberId, role: 'member' },
      { organization_id: setupChildOne.id, kilo_user_id: childOwnerId, role: 'owner' },
    ]);
    const setupSeatSubscriptionId = await insertSeatPurchase({
      organizationId: setupParentId,
      seatCount: 6,
      subscriptionId: suppliedSeatSubscriptionId,
    });

    const unrelatedOrganizationId = await insertScenarioParent({
      label: 'Unrelated organization',
      ownerId: unrelatedUserId,
      stripeCustomerId: unrelatedStripeCustomerId,
      seatCount: 2,
    });

    const [parent] = await db
      .insert(organizations)
      .values({
        name: `${ORG_PREFIX} Active parent`,
        created_by_kilo_user_id: ownerId,
        stripe_customer_id: ownerStripeCustomerId,
        plan: 'teams',
        seat_count: 6,
        require_seats: true,
      })
      .returning({ id: organizations.id });
    const [childOne] = await db
      .insert(organizations)
      .values({
        name: `${ORG_PREFIX} Child one`,
        parent_organization_id: parent?.id,
        plan: 'teams',
      })
      .returning({ id: organizations.id });
    const [childTwo] = await db
      .insert(organizations)
      .values({
        name: `${ORG_PREFIX} Child two`,
        parent_organization_id: parent?.id,
        plan: 'teams',
      })
      .returning({ id: organizations.id });
    if (!parent || !childOne || !childTwo) throw new Error('organization insert failed');

    await db.insert(organization_memberships).values([
      { organization_id: parent.id, kilo_user_id: ownerId, role: 'owner' },
      { organization_id: parent.id, kilo_user_id: adminId, role: 'billing_manager' },
      { organization_id: parent.id, kilo_user_id: memberId, role: 'member' },
      { organization_id: childOne.id, kilo_user_id: childOwnerId, role: 'owner' },
      { organization_id: childTwo.id, kilo_user_id: childOwnerId, role: 'owner' },
    ]);
    await insertSeatPurchase({ organizationId: parent.id, seatCount: 6 });

    const pastWindowStart = isoAtUtcMonthOffset(-1);
    const currentWindowStart = isoAtUtcMonthOffset(0);
    const futureWindowStart = isoAtUtcMonthOffset(1);
    const currentWindowEnd = futureWindowStart;
    const [activeAgreement] = await db
      .insert(kilo_pass_org_agreements)
      .values({
        parent_organization_id: parent.id,
        term_version_id: standardTermId,
        state: 'active',
        processing_condition: 'failed',
        purchase_channel: 'manual',
        cadence: 'monthly',
        purchased_pass_capacity: 6,
        paid_from: pastWindowStart,
        paid_until: futureWindowStart,
        issuance_anchor_at: pastWindowStart,
        external_contract_id: `${PREFIX}:active-contract:${randomUUID()}`,
      })
      .returning({ id: kilo_pass_org_agreements.id });
    if (!activeAgreement) throw new Error('active agreement insert failed');

    const priorPlanId = await insertPlan({
      agreementId: activeAgreement.id,
      effectiveWindowStart: pastWindowStart,
      version: 1,
      actorId: ownerId,
      allocations: [
        { organizationId: childOne.id, passCapacity: 2 },
        { organizationId: childTwo.id, passCapacity: 1 },
      ],
    });
    const currentPlanId = await insertPlan({
      agreementId: activeAgreement.id,
      effectiveWindowStart: currentWindowStart,
      version: 2,
      actorId: ownerId,
      allocations: [
        { organizationId: childOne.id, passCapacity: 3 },
        { organizationId: childTwo.id, passCapacity: 1 },
      ],
    });
    const futurePlanId = await insertPlan({
      agreementId: activeAgreement.id,
      effectiveWindowStart: futureWindowStart,
      version: 3,
      actorId: ownerId,
      allocations: [
        { organizationId: childOne.id, passCapacity: 2 },
        { organizationId: childTwo.id, passCapacity: 2 },
      ],
    });

    const [failedRun] = await db
      .insert(kilo_pass_org_processing_runs)
      .values({
        agreement_id: activeAgreement.id,
        window_start: pastWindowStart,
        window_end: currentWindowStart,
        state: 'failed',
        idempotency_key: `${PREFIX}:retry:${randomUUID()}`,
        attempt_count: 1,
        failure_code: 'seeded_retryable_failure',
      })
      .returning({ id: kilo_pass_org_processing_runs.id });
    const [currentRun] = await db
      .insert(kilo_pass_org_processing_runs)
      .values({
        agreement_id: activeAgreement.id,
        window_start: currentWindowStart,
        window_end: currentWindowEnd,
        state: 'succeeded',
        idempotency_key: `${PREFIX}:current:${randomUUID()}`,
        attempt_count: 1,
      })
      .returning({ id: kilo_pass_org_processing_runs.id });
    if (!failedRun || !currentRun) throw new Error('processing run insert failed');

    const snapshotInputs = [
      {
        organizationId: childOne.id,
        passCapacity: 3,
        qualifyingSpendMicrodollars: 100_000_000,
        label: 'child-one',
      },
      {
        organizationId: childTwo.id,
        passCapacity: 1,
        qualifyingSpendMicrodollars: 40_000_000,
        label: 'child-two',
      },
      {
        organizationId: parent.id,
        passCapacity: 2,
        qualifyingSpendMicrodollars: 0,
        label: 'parent-remainder',
      },
    ];
    const snapshotIds: Record<string, string> = {};
    const creditIds: Record<string, string> = {};
    for (const input of snapshotInputs) {
      const baseMicrodollars = 49_000_000 * input.passCapacity;
      const bonusMicrodollars = 12_000_000 * input.passCapacity;
      const [baseCredit] = await db
        .insert(credit_transactions)
        .values({
          kilo_user_id: ownerId,
          organization_id: input.organizationId,
          amount_microdollars: baseMicrodollars,
          is_free: false,
          description: 'Kilo Pass organization base issuance',
          credit_category: `${PREFIX}:base:${input.label}:${currentWindowStart}`,
          expiry_date: currentWindowEnd,
          created_by_kilo_user_id: ownerId,
        })
        .returning({ id: credit_transactions.id });
      if (!baseCredit) throw new Error('base credit insert failed');
      const [snapshot] = await db
        .insert(kilo_pass_org_issuance_snapshots)
        .values({
          agreement_id: activeAgreement.id,
          processing_run_id: currentRun.id,
          allocation_plan_id: currentPlanId,
          term_version_id: standardTermId,
          allocation_container_organization_id: input.organizationId,
          window_start: currentWindowStart,
          window_end: currentWindowEnd,
          qualifying_spend_starts_at: currentWindowStart,
          kind: 'regular',
          tranche_key: 'base',
          allocated_pass_capacity: input.passCapacity,
          base_credit_microdollars: baseMicrodollars,
          bonus_credit_microdollars: bonusMicrodollars,
          unlock_spend_microdollars: baseMicrodollars,
          qualifying_spend_microdollars: input.qualifyingSpendMicrodollars,
          bonus_mode: 'after_base',
          base_credit_transaction_id: baseCredit.id,
        })
        .returning({ id: kilo_pass_org_issuance_snapshots.id });
      if (!snapshot) throw new Error('issuance snapshot insert failed');
      snapshotIds[input.label] = snapshot.id;
      creditIds[input.label] = baseCredit.id;
    }

    await db.insert(kilo_pass_org_audit_records).values([
      {
        agreement_id: activeAgreement.id,
        actor_kilo_user_id: ownerId,
        action: 'agreement_activated',
        reason: 'Seeded active Kilo Pass organization agreement',
        after_json: { state: 'active', planVersion: 2 },
        idempotency_key: `${PREFIX}:audit:activated:${randomUUID()}`,
      },
      {
        agreement_id: activeAgreement.id,
        actor_kilo_user_id: adminId,
        action: 'processing_run_failed',
        reason: 'Seeded retryable original-window processing failure',
        after_json: { runId: failedRun.id, state: 'failed' },
        idempotency_key: `${PREFIX}:audit:failed:${randomUUID()}`,
      },
    ]);

    const pendingParentId = await insertScenarioParent({
      label: 'Pending payment parent',
      ownerId,
      stripeCustomerId: ownerStripeCustomerId,
      seatCount: 4,
    });
    await insertSeatPurchase({ organizationId: pendingParentId, seatCount: 4 });
    const [pendingAgreement] = await db
      .insert(kilo_pass_org_agreements)
      .values({
        parent_organization_id: pendingParentId,
        term_version_id: standardTermId,
        state: 'pending_payment',
        processing_condition: 'ready',
        purchase_channel: 'self_serve',
        cadence: 'monthly',
        purchased_pass_capacity: 4,
        issuance_anchor_at: currentWindowStart,
        provider_subscription_id: `sub_dev_seed_pending_${randomUUID()}`,
        provider_seat_add_on_item_id: `si_dev_seed_pending_${randomUUID()}`,
      })
      .returning({ id: kilo_pass_org_agreements.id });
    if (!pendingAgreement) throw new Error('pending agreement insert failed');
    await insertPlan({
      agreementId: pendingAgreement.id,
      effectiveWindowStart: currentWindowStart,
      version: 1,
      actorId: ownerId,
      allocations: [],
    });

    const cancellationParentId = await insertScenarioParent({
      label: 'Cancellation scheduled parent',
      ownerId,
      stripeCustomerId: ownerStripeCustomerId,
      seatCount: 4,
    });
    await insertSeatPurchase({ organizationId: cancellationParentId, seatCount: 4 });
    const [cancellationAgreement] = await db
      .insert(kilo_pass_org_agreements)
      .values({
        parent_organization_id: cancellationParentId,
        term_version_id: standardTermId,
        state: 'cancel_at_period_end',
        processing_condition: 'ready',
        purchase_channel: 'self_serve',
        cadence: 'monthly',
        purchased_pass_capacity: 4,
        paid_from: currentWindowStart,
        paid_until: futureWindowStart,
        issuance_anchor_at: currentWindowStart,
        provider_subscription_id: `sub_dev_seed_cancel_${randomUUID()}`,
        provider_seat_add_on_item_id: `si_dev_seed_cancel_${randomUUID()}`,
        cancellation_effective_at: futureWindowStart,
      })
      .returning({ id: kilo_pass_org_agreements.id });
    if (!cancellationAgreement) throw new Error('cancellation agreement insert failed');
    await insertPlan({
      agreementId: cancellationAgreement.id,
      effectiveWindowStart: currentWindowStart,
      version: 1,
      actorId: ownerId,
      allocations: [],
    });

    const overallocatedParentId = await insertScenarioParent({
      label: 'Overallocated parent',
      ownerId,
      stripeCustomerId: ownerStripeCustomerId,
      seatCount: 3,
    });
    const [overallocatedChild] = await db
      .insert(organizations)
      .values({
        name: `${ORG_PREFIX} Overallocated child`,
        parent_organization_id: overallocatedParentId,
        plan: 'teams',
      })
      .returning({ id: organizations.id });
    if (!overallocatedChild) throw new Error('overallocated child insert failed');
    await db.insert(organization_memberships).values({
      organization_id: overallocatedChild.id,
      kilo_user_id: childOwnerId,
      role: 'owner',
    });
    await insertSeatPurchase({ organizationId: overallocatedParentId, seatCount: 3 });
    const [overallocatedAgreement] = await db
      .insert(kilo_pass_org_agreements)
      .values({
        parent_organization_id: overallocatedParentId,
        term_version_id: standardTermId,
        state: 'active',
        processing_condition: 'overallocated',
        purchase_channel: 'manual',
        cadence: 'monthly',
        purchased_pass_capacity: 3,
        paid_from: currentWindowStart,
        paid_until: futureWindowStart,
        issuance_anchor_at: currentWindowStart,
        external_contract_id: `${PREFIX}:overallocated-contract:${randomUUID()}`,
      })
      .returning({ id: kilo_pass_org_agreements.id });
    if (!overallocatedAgreement) throw new Error('overallocated agreement insert failed');
    const overallocatedPlanId = await insertPlan({
      agreementId: overallocatedAgreement.id,
      effectiveWindowStart: currentWindowStart,
      version: 1,
      actorId: ownerId,
      allocations: [{ organizationId: overallocatedChild.id, passCapacity: 5 }],
    });
    const [blockedRun] = await db
      .insert(kilo_pass_org_processing_runs)
      .values({
        agreement_id: overallocatedAgreement.id,
        window_start: currentWindowStart,
        window_end: currentWindowEnd,
        state: 'blocked',
        idempotency_key: `${PREFIX}:blocked:${randomUUID()}`,
        attempt_count: 1,
        failure_code: 'allocation_exceeds_purchased_capacity',
      })
      .returning({ id: kilo_pass_org_processing_runs.id });
    if (!blockedRun) throw new Error('blocked processing run insert failed');

    const paymentReviewParentId = await insertScenarioParent({
      label: 'Payment review parent',
      ownerId,
      stripeCustomerId: ownerStripeCustomerId,
      seatCount: 5,
    });
    await insertSeatPurchase({ organizationId: paymentReviewParentId, seatCount: 5 });
    const [paymentReviewAgreement] = await db
      .insert(kilo_pass_org_agreements)
      .values({
        parent_organization_id: paymentReviewParentId,
        term_version_id: standardTermId,
        state: 'active',
        processing_condition: 'suspended_for_review',
        purchase_channel: 'self_serve',
        cadence: 'monthly',
        purchased_pass_capacity: 5,
        paid_from: currentWindowStart,
        paid_until: futureWindowStart,
        issuance_anchor_at: currentWindowStart,
        provider_subscription_id: `sub_dev_seed_review_${randomUUID()}`,
        provider_seat_add_on_item_id: `si_dev_seed_review_${randomUUID()}`,
        payment_review_required_at: new Date().toISOString(),
      })
      .returning({ id: kilo_pass_org_agreements.id });
    if (!paymentReviewAgreement) throw new Error('payment-review agreement insert failed');
    await insertPlan({
      agreementId: paymentReviewAgreement.id,
      effectiveWindowStart: currentWindowStart,
      version: 1,
      actorId: ownerId,
      allocations: [],
    });

    const [endedParent] = await db
      .insert(organizations)
      .values({
        name: `${ORG_PREFIX} Ended parent`,
        created_by_kilo_user_id: ownerId,
        plan: 'teams',
        seat_count: 3,
      })
      .returning({ id: organizations.id });
    if (!endedParent) throw new Error('ended organization insert failed');
    await db.insert(organization_memberships).values({
      organization_id: endedParent.id,
      kilo_user_id: ownerId,
      role: 'owner',
    });
    const [endedAgreement] = await db
      .insert(kilo_pass_org_agreements)
      .values({
        parent_organization_id: endedParent.id,
        term_version_id: customTerm.id,
        state: 'ended',
        processing_condition: 'ready',
        purchase_channel: 'manual',
        cadence: 'monthly',
        purchased_pass_capacity: 3,
        paid_from: isoAtUtcMonthOffset(-3),
        paid_until: pastWindowStart,
        issuance_anchor_at: isoAtUtcMonthOffset(-3),
        external_contract_id: `${PREFIX}:ended-contract:${randomUUID()}`,
        cancellation_effective_at: pastWindowStart,
      })
      .returning({ id: kilo_pass_org_agreements.id });
    if (!endedAgreement) throw new Error('ended agreement insert failed');
    await db.insert(kilo_pass_org_audit_records).values({
      agreement_id: endedAgreement.id,
      actor_kilo_user_id: adminId,
      action: 'agreement_ended',
      reason: 'Seeded terminal agreement for restart visibility',
      after_json: { state: 'ended' },
      idempotency_key: `${PREFIX}:audit:ended:${randomUUID()}`,
    });

    console.log('This fixture represents the Kilo Pass for Organizations E2E validation matrix.');
    console.log(
      suppliedSeatSubscriptionId
        ? 'The setup parent uses the supplied Stripe test subscription for the real purchase flow.'
        : 'The setup parent uses a placeholder seat subscription; setup UI works, but checkout does not.'
    );
    console.log(
      'Provider actions on prebuilt pending/cancellation/payment-review fixtures are visual-only.'
    );
    console.log(
      'Suggested next step: fake-login as the owner and open the setup subscription path.'
    );
    return {
      ownerId,
      ownerEmail,
      ownerStripeCustomerId,
      ownerSetupLoginPath: `/users/sign_in?fakeUser=${ownerEmail}&callbackPath=/organizations/${setupParentId}/subscriptions`,
      adminId,
      adminEmail,
      adminStripeCustomerId,
      billingManagerSetupLoginPath: `/users/sign_in?fakeUser=${adminEmail}&callbackPath=/organizations/${setupParentId}/subscriptions`,
      memberId,
      memberEmail,
      memberStripeCustomerId,
      memberUnauthorizedLoginPath: `/users/sign_in?fakeUser=${memberEmail}&callbackPath=/organizations/${setupParentId}/subscriptions`,
      childOwnerId,
      childOwnerEmail,
      childOwnerStripeCustomerId,
      childOwnerUnauthorizedLoginPath: `/users/sign_in?fakeUser=${childOwnerEmail}&callbackPath=/organizations/${setupParentId}/subscriptions`,
      unrelatedUserId,
      unrelatedUserEmail,
      unrelatedStripeCustomerId,
      unrelatedUnauthorizedLoginPath: `/users/sign_in?fakeUser=${unrelatedUserEmail}&callbackPath=/organizations/${setupParentId}/subscriptions`,
      setupParentOrganizationId: setupParentId,
      setupChildOneOrganizationId: setupChildOne.id,
      setupChildTwoOrganizationId: setupChildTwo.id,
      setupSeatSubscriptionId,
      setupStripeCheckoutReady: suppliedSeatSubscriptionId !== undefined,
      setupSubscriptionsPath: `/organizations/${setupParentId}/subscriptions`,
      setupKiloPassPath: `/organizations/${setupParentId}/subscriptions/kilo-pass/setup`,
      unrelatedOrganizationId,
      parentOrganizationId: parent.id,
      childOneOrganizationId: childOne.id,
      childTwoOrganizationId: childTwo.id,
      activeAgreementId: activeAgreement.id,
      activeKiloPassPath: `/organizations/${parent.id}/subscriptions/kilo-pass`,
      pendingParentOrganizationId: pendingParentId,
      pendingAgreementId: pendingAgreement.id,
      pendingKiloPassPath: `/organizations/${pendingParentId}/subscriptions/kilo-pass`,
      cancellationParentOrganizationId: cancellationParentId,
      cancellationAgreementId: cancellationAgreement.id,
      cancellationKiloPassPath: `/organizations/${cancellationParentId}/subscriptions/kilo-pass`,
      overallocatedParentOrganizationId: overallocatedParentId,
      overallocatedChildOrganizationId: overallocatedChild.id,
      overallocatedAgreementId: overallocatedAgreement.id,
      overallocatedAllocationPlanId: overallocatedPlanId,
      blockedProcessingRunId: blockedRun.id,
      overallocatedKiloPassPath: `/organizations/${overallocatedParentId}/subscriptions/kilo-pass`,
      paymentReviewParentOrganizationId: paymentReviewParentId,
      paymentReviewAgreementId: paymentReviewAgreement.id,
      paymentReviewKiloPassPath: `/organizations/${paymentReviewParentId}/subscriptions/kilo-pass`,
      endedParentOrganizationId: endedParent.id,
      endedAgreementId: endedAgreement.id,
      endedSubscriptionsPath: `/organizations/${endedParent.id}/subscriptions`,
      standardTermId,
      customTermId: customTerm.id,
      priorAllocationPlanId: priorPlanId,
      currentAllocationPlanId: currentPlanId,
      futureAllocationPlanId: futurePlanId,
      failedProcessingRunId: failedRun.id,
      currentProcessingRunId: currentRun.id,
      currentChildOneIssuanceSnapshotId: snapshotIds['child-one'] ?? null,
      currentChildTwoIssuanceSnapshotId: snapshotIds['child-two'] ?? null,
      currentParentIssuanceSnapshotId: snapshotIds['parent-remainder'] ?? null,
      currentChildOneBaseCreditTransactionId: creditIds['child-one'] ?? null,
      currentChildTwoBaseCreditTransactionId: creditIds['child-two'] ?? null,
      currentParentBaseCreditTransactionId: creditIds['parent-remainder'] ?? null,
      pastWindowStart,
      currentWindowStart,
      futureWindowStart,
    };
  } catch (error) {
    await cleanup();
    if (ownerStripeCustomerId) await deleteSeedStripeCustomer(ownerStripeCustomerId);
    if (adminStripeCustomerId) await deleteSeedStripeCustomer(adminStripeCustomerId);
    if (memberStripeCustomerId) await deleteSeedStripeCustomer(memberStripeCustomerId);
    if (childOwnerStripeCustomerId) await deleteSeedStripeCustomer(childOwnerStripeCustomerId);
    if (unrelatedStripeCustomerId) await deleteSeedStripeCustomer(unrelatedStripeCustomerId);
    throw error;
  }
}
