/**
 * Seed fixture for the admin organizations dashboard.
 *
 * Creates a representative set of organizations covering every filter/column
 * visible on /admin/organizations and /admin/organizations/trials:
 *
 *   - Paying Teams orgs: active, past_due, canceled
 *   - Paying Enterprise orgs: active, ended (churned)
 *   - Trial orgs (no seats purchase): teams + enterprise
 *   - A deleted org
 *   - Orgs with KiloClaw instances
 *   - Orgs whose members have active Kilo Pass subscriptions
 *   - Varying member counts and seat counts
 *
 * Idempotent: deletes all orgs/users matching the seed prefix before recreating.
 *
 * Usage: pnpm dev:seed app:org-dashboard
 */

import { randomUUID } from 'node:crypto';

import {
  kilocode_users,
  organizations,
  organization_memberships,
  organization_seats_purchases,
  kiloclaw_instances,
  kilo_pass_subscriptions,
  platform_integrations,
} from '@kilocode/db/schema';
import { ilike, inArray } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import type { SeedResult } from '../index';

const ORG_PREFIX = '[seed:org-dashboard]';
const USER_EMAIL_PATTERN = 'seed-org-dashboard-%@example.com';
const SANDBOX_PREFIX = 'seed-org-dash-';

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function daysAgo(n: number) {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

function daysFromNow(n: number) {
  return new Date(Date.now() + n * 86_400_000).toISOString();
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanup() {
  const db = getSeedDb();

  const seedOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(ilike(organizations.name, `${ORG_PREFIX}%`));

  const orgIds = seedOrgs.map(o => o.id);

  if (orgIds.length > 0) {
    await db.delete(kiloclaw_instances).where(inArray(kiloclaw_instances.organization_id, orgIds));
    await db
      .delete(organization_seats_purchases)
      .where(inArray(organization_seats_purchases.organization_id, orgIds));
    await db
      .delete(platform_integrations)
      .where(inArray(platform_integrations.owned_by_organization_id, orgIds));
    await db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.organization_id, orgIds));
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
  }

  const seedUsers = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(ilike(kilocode_users.google_user_email, USER_EMAIL_PATTERN));

  if (seedUsers.length > 0) {
    const userIds = seedUsers.map(u => u.id);
    await db
      .delete(kilo_pass_subscriptions)
      .where(inArray(kilo_pass_subscriptions.kilo_user_id, userIds));
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, userIds));
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

async function createUser(handle: string, displayName: string) {
  const db = getSeedDb();
  const id = randomUUID();
  const email = `seed-org-dashboard-${handle}@example.com`;
  await db.insert(kilocode_users).values({
    id,
    google_user_email: email,
    google_user_name: displayName,
    google_user_image_url: `https://example.com/${id}.png`,
    stripe_customer_id: `cus_seed_${id.replace(/-/g, '').slice(0, 14)}`,
    normalized_email: email,
    has_validation_stytch: true,
    customer_source: 'dev-seed',
  });
  return id;
}

type OrgSettingsOverrides = {
  provider_allow_list?: string[];
  model_deny_list?: string[];
  data_collection?: 'allow' | 'deny';
};

async function createOrg(
  label: string,
  plan: 'teams' | 'enterprise',
  opts: {
    seatCount?: number;
    requireSeats?: boolean;
    deleted?: boolean;
    freeTrialEndAt?: string | null;
    withStripeCustomer?: boolean;
    autoTopUp?: boolean;
    ssoDomain?: string;
    settings?: OrgSettingsOverrides;
  } = {}
) {
  const db = getSeedDb();
  const id = randomUUID();
  const stripeCustomerId = opts.withStripeCustomer
    ? `cus_seed_${id.replace(/-/g, '').slice(0, 14)}`
    : null;
  await db.insert(organizations).values({
    id,
    name: `${ORG_PREFIX} ${label}`,
    plan,
    seat_count: opts.seatCount ?? 0,
    require_seats: opts.requireSeats ?? plan === 'teams',
    deleted_at: opts.deleted ? daysAgo(5) : null,
    free_trial_end_at: opts.freeTrialEndAt ?? null,
    microdollars_used: Math.floor(Math.random() * 30_000_000),
    total_microdollars_acquired: Math.floor(Math.random() * 60_000_000) + 40_000_000,
    stripe_customer_id: stripeCustomerId,
    auto_top_up_enabled: opts.autoTopUp ?? false,
    sso_domain: opts.ssoDomain ?? null,
    settings: opts.settings ?? {},
  });
  return id;
}

type IntegrationStatus = 'active' | 'pending' | 'suspended';
type IntegrationPlatform = 'github' | 'gitlab' | 'slack';

async function addPlatformIntegration(
  orgId: string,
  platform: IntegrationPlatform,
  status: IntegrationStatus = 'active'
) {
  const db = getSeedDb();
  await db.insert(platform_integrations).values({
    id: randomUUID(),
    owned_by_organization_id: orgId,
    platform,
    integration_type: platform === 'github' || platform === 'gitlab' ? 'app' : 'oauth',
    integration_status: status,
    platform_installation_id: `seed_${platform}_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
  });
}

async function addMember(orgId: string, userId: string, role: 'owner' | 'member' = 'member') {
  const db = getSeedDb();
  await db.insert(organization_memberships).values({
    organization_id: orgId,
    kilo_user_id: userId,
    role,
  });
}

type SubStatus = 'active' | 'past_due' | 'canceled' | 'ended' | 'incomplete' | 'unpaid';

async function addSubscription(
  orgId: string,
  status: SubStatus,
  opts: {
    amountUsd?: number;
    seatCount?: number;
    billingCycle?: 'monthly' | 'yearly';
    createdDaysAgo?: number;
  } = {}
) {
  const db = getSeedDb();
  const subId = `sub_seed_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const daysBack = opts.createdDaysAgo ?? 90;
  await db.insert(organization_seats_purchases).values({
    organization_id: orgId,
    subscription_stripe_id: subId,
    seat_count: opts.seatCount ?? 5,
    amount_usd: opts.amountUsd ?? 299,
    subscription_status: status,
    billing_cycle: opts.billingCycle ?? 'monthly',
    starts_at: daysAgo(daysBack),
    expires_at: daysFromNow(30),
    idempotency_key: randomUUID(),
  });
}

async function addKiloClawInstance(orgId: string, userId: string) {
  const db = getSeedDb();
  await db.insert(kiloclaw_instances).values({
    id: randomUUID(),
    user_id: userId,
    organization_id: orgId,
    sandbox_id: `${SANDBOX_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 10)}`,
    provider: 'fly',
  });
}

async function addKiloPass(userId: string) {
  const db = getSeedDb();
  const subId = `sub_seed_kp_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await db.insert(kilo_pass_subscriptions).values({
    kilo_user_id: userId,
    payment_provider: 'stripe',
    provider_subscription_id: subId,
    stripe_subscription_id: subId,
    tier: 'tier_49',
    cadence: 'monthly',
    status: 'active',
    started_at: daysAgo(60),
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function run(): Promise<SeedResult> {
  console.log('Cleaning up existing seed data...');
  await cleanup();

  // --- Users ---
  console.log('Creating seed users...');
  const alice = await createUser('alice', 'Alice Chen');
  const bob = await createUser('bob', 'Bob Martinez');
  const carol = await createUser('carol', 'Carol Zhang');
  const david = await createUser('david', 'David Okonkwo');
  const eve = await createUser('eve', 'Eve Johansson');
  const frank = await createUser('frank', 'Frank Nguyen');
  const grace = await createUser('grace', 'Grace Patel');
  const henry = await createUser('henry', 'Henry Silva');
  const iris = await createUser('iris', 'Iris Müller');
  const jack = await createUser('jack', 'Jack Thompson');
  const kate = await createUser('kate', 'Kate Williams');
  const leo = await createUser('leo', 'Leo Nakamura');

  // Give three users active Kilo Pass — they'll appear in Kilo Pass column
  await addKiloPass(alice);
  await addKiloPass(carol);
  await addKiloPass(grace);

  // --- Paying Teams: active ---
  console.log('Creating paying Teams orgs...');

  const acme = await createOrg('Acme Corp (Teams active)', 'teams', {
    seatCount: 10,
    withStripeCustomer: true,
    autoTopUp: true,
  });
  await addMember(acme, alice, 'owner');
  await addMember(acme, bob);
  await addMember(acme, carol);
  await addSubscription(acme, 'active', { amountUsd: 990, seatCount: 10, createdDaysAgo: 120 });
  await addKiloClawInstance(acme, alice);
  await addKiloClawInstance(acme, bob);
  await addPlatformIntegration(acme, 'github', 'active');
  await addPlatformIntegration(acme, 'slack', 'active');

  const buildco = await createOrg('BuildCo (Teams active yearly)', 'teams', {
    seatCount: 25,
    withStripeCustomer: true,
  });
  await addMember(buildco, david, 'owner');
  await addMember(buildco, eve);
  await addSubscription(buildco, 'active', {
    amountUsd: 7_500,
    seatCount: 25,
    billingCycle: 'yearly',
    createdDaysAgo: 180,
  });
  await addPlatformIntegration(buildco, 'gitlab', 'active');

  const codelab = await createOrg('CodeLab (Teams active small)', 'teams', {
    seatCount: 3,
    withStripeCustomer: true,
  });
  await addMember(codelab, frank, 'owner');
  await addSubscription(codelab, 'active', { amountUsd: 297, seatCount: 3, createdDaysAgo: 30 });
  await addKiloClawInstance(codelab, frank);
  await addPlatformIntegration(codelab, 'github', 'pending');

  // --- Paying Teams: past_due (two subscription rows — active then past_due) ---
  const debtco = await createOrg('DebtCo (Teams past_due)', 'teams', {
    seatCount: 8,
    withStripeCustomer: true,
    settings: { data_collection: 'deny' },
  });
  await addMember(debtco, grace, 'owner');
  await addMember(debtco, henry);
  await addSubscription(debtco, 'active', { amountUsd: 792, seatCount: 8, createdDaysAgo: 60 });
  await addSubscription(debtco, 'past_due', { amountUsd: 792, seatCount: 8, createdDaysAgo: 5 });

  // --- Paying Teams: canceled (churned) ---
  const exstartup = await createOrg('ExStartup (Teams canceled)', 'teams', { seatCount: 0 });
  await addMember(exstartup, iris, 'owner');
  await addSubscription(exstartup, 'active', {
    amountUsd: 1485,
    seatCount: 15,
    createdDaysAgo: 240,
  });
  await addSubscription(exstartup, 'canceled', {
    amountUsd: 1485,
    seatCount: 15,
    createdDaysAgo: 45,
  });

  // --- Paying Enterprise: active ---
  console.log('Creating paying Enterprise orgs...');

  const megacorp = await createOrg('MegaCorp (Enterprise active)', 'enterprise', {
    seatCount: 200,
    requireSeats: false,
    withStripeCustomer: true,
    autoTopUp: true,
    ssoDomain: 'megacorp.example.com',
    settings: {
      provider_allow_list: ['anthropic', 'openai'],
      model_deny_list: ['openai/gpt-3.5-turbo'],
      data_collection: 'deny',
    },
  });
  await addMember(megacorp, jack, 'owner');
  await addMember(megacorp, kate);
  await addMember(megacorp, leo);
  await addSubscription(megacorp, 'active', {
    amountUsd: 25_000,
    seatCount: 200,
    billingCycle: 'yearly',
    createdDaysAgo: 365,
  });
  await addKiloClawInstance(megacorp, jack);
  await addKiloClawInstance(megacorp, kate);
  await addPlatformIntegration(megacorp, 'github', 'active');
  await addPlatformIntegration(megacorp, 'gitlab', 'active');
  await addPlatformIntegration(megacorp, 'slack', 'active');

  const globaltech = await createOrg('GlobalTech (Enterprise active)', 'enterprise', {
    seatCount: 50,
    requireSeats: false,
    withStripeCustomer: true,
    ssoDomain: 'globaltech.example.com',
    settings: {
      provider_allow_list: ['anthropic'],
    },
  });
  await addMember(globaltech, alice, 'owner');
  await addMember(globaltech, david);
  await addSubscription(globaltech, 'active', {
    amountUsd: 8_000,
    seatCount: 50,
    createdDaysAgo: 120,
  });
  await addPlatformIntegration(globaltech, 'github', 'active');
  // Suspended Slack should NOT show in the Integrations pills
  await addPlatformIntegration(globaltech, 'slack', 'suspended');

  // --- Paying Enterprise: ended (churned) ---
  const oldenterprise = await createOrg('OldEnterprise (Enterprise ended)', 'enterprise', {
    seatCount: 0,
    requireSeats: false,
    withStripeCustomer: true,
  });
  await addMember(oldenterprise, bob, 'owner');
  await addSubscription(oldenterprise, 'active', {
    amountUsd: 5_000,
    seatCount: 40,
    createdDaysAgo: 400,
  });
  await addSubscription(oldenterprise, 'ended', {
    amountUsd: 5_000,
    seatCount: 40,
    createdDaysAgo: 60,
  });

  // --- Trial orgs (no seats purchase) ---
  console.log('Creating trial orgs...');

  const trialA = await createOrg('TrialTeam Alpha', 'teams', {
    requireSeats: true,
    freeTrialEndAt: daysFromNow(14),
  });
  await addMember(trialA, eve, 'owner');
  await addMember(trialA, frank);
  await addMember(trialA, grace);
  await addPlatformIntegration(trialA, 'github', 'pending');

  const trialB = await createOrg('TrialTeam Beta (expiring soon)', 'teams', {
    requireSeats: true,
    freeTrialEndAt: daysFromNow(2),
  });
  await addMember(trialB, henry, 'owner');

  const trialE = await createOrg('TrialEnterprise Gamma', 'enterprise', {
    requireSeats: false,
    freeTrialEndAt: daysFromNow(21),
    ssoDomain: 'trialenterprise.example.com',
  });
  await addMember(trialE, iris, 'owner');
  await addMember(trialE, jack);
  await addPlatformIntegration(trialE, 'github', 'active');

  // --- Deleted org (was paying) ---
  console.log('Creating deleted org...');

  const deleted = await createOrg('DeletedCo (deleted)', 'teams', {
    seatCount: 5,
    deleted: true,
  });
  await addSubscription(deleted, 'active', { amountUsd: 495, seatCount: 5, createdDaysAgo: 300 });
  await addSubscription(deleted, 'canceled', { amountUsd: 495, seatCount: 5, createdDaysAgo: 10 });

  console.log(`
Seed complete. Useful filter combos to verify on /admin/organizations:
  Default view (paying, no deleted)  → 8 orgs
  Stripe Status = active             → Acme, BuildCo, CodeLab, MegaCorp, GlobalTech
  Stripe Status = past_due           → DebtCo
  Stripe Status = canceled           → ExStartup
  Stripe Status = ended              → OldEnterprise
  Plan = enterprise                  → MegaCorp, GlobalTech, OldEnterprise
  Include deleted ✓                  → also shows DeletedCo (Stripe = canceled)
  /admin/organizations/trials        → TrialTeam Alpha/Beta, TrialEnterprise Gamma
  Kilo Pass = Yes                    → Acme (alice, carol), GlobalTech (alice)
  KiloClaw = Yes                     → Acme, CodeLab, MegaCorp

Usage tab signals to verify:
  Stripe link in Links               → Acme, BuildCo, CodeLab, DebtCo, MegaCorp, GlobalTech, OldEnterprise
  Auto Top-Up = On                   → Acme, MegaCorp
  SSO pill                           → MegaCorp, GlobalTech, TrialEnterprise Gamma
  P/M Controls pill                  → MegaCorp, GlobalTech
  Data Privacy pill                  → DebtCo, MegaCorp
  GitHub integration                 → Acme, CodeLab (pending), MegaCorp, GlobalTech, TrialTeam Alpha (pending), TrialEnterprise Gamma
  GitLab integration                 → BuildCo, MegaCorp
  Slack integration                  → Acme, MegaCorp (GlobalTech's Slack is suspended → hidden)
`);

  return {
    orgsCreated: 11,
    usersCreated: 12,
    kiloPassUsers: 'alice, carol, grace',
    kiloClawOrgs: 'Acme Corp, CodeLab, MegaCorp',
    autoTopUpOrgs: 'Acme Corp, MegaCorp',
    ssoOrgs: 'MegaCorp, GlobalTech, TrialEnterprise Gamma',
  };
}
