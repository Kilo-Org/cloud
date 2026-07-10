import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

import {
  byok_api_keys,
  coding_plan_availability_intents,
  coding_plan_key_inventory,
  coding_plan_subscriptions,
  coding_plan_terms,
  credit_transactions,
  kilocode_users,
} from '@kilocode/db/schema';
import type { EncryptedData } from '@kilocode/db/schema-types';
import { inArray, like } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { createSeedStripeCustomer, deleteSeedStripeCustomer } from '../lib/stripe';
import type { SeedResult } from '../index';

const PROVIDER_ID = 'minimax';
const PROVIDER_NAME = 'MiniMax';
const KEY_PREFIX = 'dev-seed:coding-plans:demo-data';
const EMAIL_DOMAIN = 'example.com';
const MICRODOLLARS_PER_DOLLAR = 1_000_000;

type PlanId = 'minimax-token-plan-plus' | 'minimax-token-plan-max' | 'minimax-token-plan-ultra';
type SubscriptionStatus = 'active' | 'past_due' | 'canceled';
type CredentialStatus =
  | 'available'
  | 'assigned'
  | 'revocation_pending'
  | 'revocation_failed'
  | 'revoked';
type SubscriptionUserSlug =
  | 'active-plus'
  | 'canceling-max'
  | 'past-due-ultra'
  | 'canceled-pending-plus'
  | 'canceled-failed-max';
type UserSlug = SubscriptionUserSlug | 'waitlist-ultra';

type PlanFixture = {
  planId: PlanId;
  planName: string;
  costMicrodollars: number;
  billingPeriodDays: number;
};

type UserFixture = {
  slug: UserSlug;
  name: string;
};

type SubscriptionFixture = {
  slug: SubscriptionUserSlug;
  planId: PlanId;
  status: SubscriptionStatus;
  inventoryStatus: CredentialStatus;
  cancelAtPeriodEnd: boolean;
  startedDaysAgo: number;
  periodEndsInDays: number;
  graceEndsInHours: number | null;
  canceledDaysAgo: number | null;
  cancellationReason: string | null;
  revocationRequestedDaysAgo: number | null;
  revocationAttemptCount: number;
  lastRevocationError: string | null;
};

type InventoryFixture = {
  slug: string;
  planId: PlanId;
  status: CredentialStatus;
  assignedToUserSlug: UserSlug | null;
  revocationRequestedDaysAgo: number | null;
  revokedDaysAgo: number | null;
  revocationAttemptCount: number;
  lastRevocationError: string | null;
};

type SeedUser = {
  slug: UserSlug;
  id: string;
  name: string;
  email: string;
  normalizedEmail: string;
  stripeCustomerId: string;
};

type InventoryRow = {
  slug: string;
  id: string;
};

const PLANS: Record<PlanId, PlanFixture> = {
  'minimax-token-plan-plus': {
    planId: 'minimax-token-plan-plus',
    planName: 'Token Plan Plus',
    costMicrodollars: 20 * MICRODOLLARS_PER_DOLLAR,
    billingPeriodDays: 30,
  },
  'minimax-token-plan-max': {
    planId: 'minimax-token-plan-max',
    planName: 'Token Plan Max',
    costMicrodollars: 50 * MICRODOLLARS_PER_DOLLAR,
    billingPeriodDays: 30,
  },
  'minimax-token-plan-ultra': {
    planId: 'minimax-token-plan-ultra',
    planName: 'Token Plan Ultra',
    costMicrodollars: 120 * MICRODOLLARS_PER_DOLLAR,
    billingPeriodDays: 30,
  },
};

const USER_FIXTURES: UserFixture[] = [
  { slug: 'active-plus', name: 'Coding Plan Active Plus' },
  { slug: 'canceling-max', name: 'Coding Plan Canceling Max' },
  { slug: 'past-due-ultra', name: 'Coding Plan Past Due Ultra' },
  { slug: 'canceled-pending-plus', name: 'Coding Plan Canceled Pending Plus' },
  { slug: 'canceled-failed-max', name: 'Coding Plan Canceled Failed Max' },
  { slug: 'waitlist-ultra', name: 'Coding Plan Waitlist Ultra' },
];

const SUBSCRIPTION_FIXTURES: SubscriptionFixture[] = [
  {
    slug: 'active-plus',
    planId: 'minimax-token-plan-plus',
    status: 'active',
    inventoryStatus: 'assigned',
    cancelAtPeriodEnd: false,
    startedDaysAgo: 4,
    periodEndsInDays: 26,
    graceEndsInHours: null,
    canceledDaysAgo: null,
    cancellationReason: null,
    revocationRequestedDaysAgo: null,
    revocationAttemptCount: 0,
    lastRevocationError: null,
  },
  {
    slug: 'canceling-max',
    planId: 'minimax-token-plan-max',
    status: 'active',
    inventoryStatus: 'assigned',
    cancelAtPeriodEnd: true,
    startedDaysAgo: 12,
    periodEndsInDays: 18,
    graceEndsInHours: null,
    canceledDaysAgo: null,
    cancellationReason: null,
    revocationRequestedDaysAgo: null,
    revocationAttemptCount: 0,
    lastRevocationError: null,
  },
  {
    slug: 'past-due-ultra',
    planId: 'minimax-token-plan-ultra',
    status: 'past_due',
    inventoryStatus: 'assigned',
    cancelAtPeriodEnd: false,
    startedDaysAgo: 31,
    periodEndsInDays: -1,
    graceEndsInHours: 12,
    canceledDaysAgo: null,
    cancellationReason: null,
    revocationRequestedDaysAgo: null,
    revocationAttemptCount: 0,
    lastRevocationError: null,
  },
  {
    slug: 'canceled-pending-plus',
    planId: 'minimax-token-plan-plus',
    status: 'canceled',
    inventoryStatus: 'revocation_pending',
    cancelAtPeriodEnd: false,
    startedDaysAgo: 46,
    periodEndsInDays: -16,
    graceEndsInHours: null,
    canceledDaysAgo: 16,
    cancellationReason: 'user_canceled',
    revocationRequestedDaysAgo: 15,
    revocationAttemptCount: 0,
    lastRevocationError: null,
  },
  {
    slug: 'canceled-failed-max',
    planId: 'minimax-token-plan-max',
    status: 'canceled',
    inventoryStatus: 'revocation_failed',
    cancelAtPeriodEnd: false,
    startedDaysAgo: 54,
    periodEndsInDays: -24,
    graceEndsInHours: null,
    canceledDaysAgo: 24,
    cancellationReason: 'insufficient_credits',
    revocationRequestedDaysAgo: 23,
    revocationAttemptCount: 2,
    lastRevocationError: 'MiniMax admin portal returned a transient 502.',
  },
];

const EXTRA_INVENTORY_FIXTURES: InventoryFixture[] = [
  {
    slug: 'available-plus-1',
    planId: 'minimax-token-plan-plus',
    status: 'available',
    assignedToUserSlug: null,
    revocationRequestedDaysAgo: null,
    revokedDaysAgo: null,
    revocationAttemptCount: 0,
    lastRevocationError: null,
  },
  {
    slug: 'available-plus-2',
    planId: 'minimax-token-plan-plus',
    status: 'available',
    assignedToUserSlug: null,
    revocationRequestedDaysAgo: null,
    revokedDaysAgo: null,
    revocationAttemptCount: 0,
    lastRevocationError: null,
  },
  {
    slug: 'available-max-1',
    planId: 'minimax-token-plan-max',
    status: 'available',
    assignedToUserSlug: null,
    revocationRequestedDaysAgo: null,
    revokedDaysAgo: null,
    revocationAttemptCount: 0,
    lastRevocationError: null,
  },
  {
    slug: 'available-ultra-1',
    planId: 'minimax-token-plan-ultra',
    status: 'available',
    assignedToUserSlug: null,
    revocationRequestedDaysAgo: null,
    revokedDaysAgo: null,
    revocationAttemptCount: 0,
    lastRevocationError: null,
  },
  {
    slug: 'revoked-plus-1',
    planId: 'minimax-token-plan-plus',
    status: 'revoked',
    assignedToUserSlug: null,
    revocationRequestedDaysAgo: 18,
    revokedDaysAgo: 17,
    revocationAttemptCount: 1,
    lastRevocationError: null,
  },
];

export const usage = '[scenario]';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed coding-plans:demo-data ${usage}`);
  console.log('');
  console.log('Seeds local Coding Plan users, subscriptions, inventory, and revocation data.');
  console.log('Designed for Admin UI > Coding plans testing. Placeholder credentials are invalid.');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed coding-plans:demo-data');
  console.log('  pnpm dev:seed coding-plans:demo-data admin-tabs');
}

function requireScenario(value: string | undefined): string {
  const scenario = value?.trim() || 'admin-overview';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(scenario)) {
    throw new Error('scenario must contain 1-64 letters, digits, underscores, or hyphens');
  }
  return scenario.toLowerCase();
}

function requireEncryptionKey(): Buffer {
  const keyBase64 = process.env.BYOK_ENCRYPTION_KEY;
  if (!keyBase64) {
    throw new Error('BYOK_ENCRYPTION_KEY is not configured');
  }

  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) {
    throw new Error('BYOK_ENCRYPTION_KEY must decode to 32 bytes');
  }
  return key;
}

function addDays(baseDate: Date, days: number): string {
  const result = new Date(baseDate);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString();
}

function addHours(baseDate: Date, hours: number): string {
  const result = new Date(baseDate);
  result.setUTCHours(result.getUTCHours() + hours);
  return result.toISOString();
}

function idempotencyFingerprint(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex');
}

function credentialFingerprint(plaintext: string, key: Buffer): string {
  return createHmac('sha256', key).update(plaintext).digest('hex');
}

function encryptCredential(plaintext: string, key: Buffer): EncryptedData {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return {
    iv: iv.toString('base64'),
    data: encrypted.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function seedUserId(scenario: string, slug: UserSlug): string {
  return `dev-seed-coding-plans-${scenario}-${slug}`;
}

function seedEmail(scenario: string, slug: UserSlug): string {
  return `dev-seed-coding-plans-${scenario}-${slug}@${EMAIL_DOMAIN}`;
}

function inventorySlugForSubscription(slug: SubscriptionUserSlug): string {
  return `subscription-${slug}`;
}

function plaintextCredential(scenario: string, slug: string): string {
  return `${KEY_PREFIX}:${scenario}:credential:${slug}`;
}

function upstreamPlanId(scenario: string, slug: string): string {
  return `${KEY_PREFIX}:${scenario}:upstream-plan:${slug}`;
}

function creditGrantAmount(subscription: SubscriptionFixture | null): number {
  if (!subscription) return 0;
  const costMicrodollars = PLANS[subscription.planId].costMicrodollars;
  return subscription.status === 'past_due' ? costMicrodollars : costMicrodollars + 80_000_000;
}

function makeInventoryFixtures(): InventoryFixture[] {
  const subscriptionInventory = SUBSCRIPTION_FIXTURES.map(subscription => ({
    slug: inventorySlugForSubscription(subscription.slug),
    planId: subscription.planId,
    status: subscription.inventoryStatus,
    assignedToUserSlug: subscription.slug,
    revocationRequestedDaysAgo: subscription.revocationRequestedDaysAgo,
    revokedDaysAgo: null,
    revocationAttemptCount: subscription.revocationAttemptCount,
    lastRevocationError: subscription.lastRevocationError,
  }));

  return [...subscriptionInventory, ...EXTRA_INVENTORY_FIXTURES];
}

function getSeedUsers(scenario: string, stripeCustomerIds: Record<UserSlug, string>): SeedUser[] {
  return USER_FIXTURES.map(user => {
    const email = seedEmail(scenario, user.slug);
    return {
      slug: user.slug,
      id: seedUserId(scenario, user.slug),
      name: user.name,
      email,
      normalizedEmail: normalizeSeedEmail(email),
      stripeCustomerId: stripeCustomerIds[user.slug],
    };
  });
}

function getUser(users: SeedUser[], slug: UserSlug): SeedUser {
  const user = users.find(candidate => candidate.slug === slug);
  if (!user) {
    throw new Error(`Missing seed user fixture for ${slug}`);
  }
  return user;
}

function getInventoryRow(rows: InventoryRow[], slug: string): InventoryRow {
  const row = rows.find(candidate => candidate.slug === slug);
  if (!row) {
    throw new Error(`Missing inventory fixture for ${slug}`);
  }
  return row;
}

async function cleanupScenario(scenario: string): Promise<string[]> {
  const db = getSeedDb();
  const normalizedEmails = USER_FIXTURES.map(user =>
    normalizeSeedEmail(seedEmail(scenario, user.slug))
  );
  const existingUsers = await db
    .select({ id: kilocode_users.id, stripeCustomerId: kilocode_users.stripe_customer_id })
    .from(kilocode_users)
    .where(inArray(kilocode_users.normalized_email, normalizedEmails));
  const existingUserIds = existingUsers.map(user => user.id);

  await db.transaction(async tx => {
    if (existingUserIds.length > 0) {
      await tx
        .delete(coding_plan_availability_intents)
        .where(inArray(coding_plan_availability_intents.user_id, existingUserIds));
      await tx.delete(coding_plan_terms).where(inArray(coding_plan_terms.user_id, existingUserIds));
      await tx
        .delete(coding_plan_subscriptions)
        .where(inArray(coding_plan_subscriptions.user_id, existingUserIds));
      await tx.delete(byok_api_keys).where(inArray(byok_api_keys.kilo_user_id, existingUserIds));
      await tx
        .delete(credit_transactions)
        .where(inArray(credit_transactions.kilo_user_id, existingUserIds));
      await tx.delete(kilocode_users).where(inArray(kilocode_users.id, existingUserIds));
    }

    await tx
      .delete(coding_plan_key_inventory)
      .where(like(coding_plan_key_inventory.upstream_plan_id, `${KEY_PREFIX}:${scenario}:%`));
  });

  return existingUsers.map(user => user.stripeCustomerId);
}

async function createStripeCustomers(scenario: string): Promise<Record<UserSlug, string>> {
  const stripeCustomerIds: Partial<Record<UserSlug, string>> = {};
  try {
    for (const user of USER_FIXTURES) {
      const stripeCustomer = await createSeedStripeCustomer({
        email: seedEmail(scenario, user.slug),
        name: user.name,
        kiloUserId: seedUserId(scenario, user.slug),
      });
      stripeCustomerIds[user.slug] = stripeCustomer.id;
    }
  } catch (error) {
    await Promise.all(
      Object.values(stripeCustomerIds).map(customerId => deleteSeedStripeCustomer(customerId))
    );
    throw error;
  }

  const completeStripeCustomerIds: Record<UserSlug, string> = {
    'active-plus': stripeCustomerIds['active-plus'] ?? '',
    'canceling-max': stripeCustomerIds['canceling-max'] ?? '',
    'past-due-ultra': stripeCustomerIds['past-due-ultra'] ?? '',
    'canceled-pending-plus': stripeCustomerIds['canceled-pending-plus'] ?? '',
    'canceled-failed-max': stripeCustomerIds['canceled-failed-max'] ?? '',
    'waitlist-ultra': stripeCustomerIds['waitlist-ultra'] ?? '',
  };

  for (const [slug, customerId] of Object.entries(completeStripeCustomerIds)) {
    if (!customerId) {
      throw new Error(`Failed to create Stripe customer for ${slug}`);
    }
  }

  return completeStripeCustomerIds;
}

async function seedScenario(scenario: string, key: Buffer, users: SeedUser[]): Promise<SeedResult> {
  const now = new Date();
  const db = getSeedDb();
  const inventoryFixtures = makeInventoryFixtures();

  return db.transaction(async tx => {
    await tx.insert(kilocode_users).values(
      users.map(user => {
        const subscription = SUBSCRIPTION_FIXTURES.find(fixture => fixture.slug === user.slug);
        const grantAmount = creditGrantAmount(subscription ?? null);
        return {
          id: user.id,
          google_user_email: user.email,
          google_user_name: user.name,
          google_user_image_url: `https://example.com/${encodeURIComponent(user.id)}.png`,
          stripe_customer_id: user.stripeCustomerId,
          normalized_email: user.normalizedEmail,
          email_domain: EMAIL_DOMAIN,
          has_validation_stytch: true,
          customer_source: 'dev-seed',
          total_microdollars_acquired: grantAmount,
          microdollars_used: subscription ? PLANS[subscription.planId].costMicrodollars : 0,
          auto_top_up_enabled: subscription?.status === 'past_due',
        } satisfies typeof kilocode_users.$inferInsert;
      })
    );

    await tx.insert(coding_plan_key_inventory).values(
      inventoryFixtures.map(fixture => {
        const plaintext = plaintextCredential(scenario, fixture.slug);
        const isSecretRetained = fixture.status === 'available' || fixture.status === 'assigned';
        const assignedUser = fixture.assignedToUserSlug
          ? getUser(users, fixture.assignedToUserSlug)
          : null;
        return {
          plan_id: fixture.planId,
          provider_id: PROVIDER_ID,
          upstream_plan_id: upstreamPlanId(scenario, fixture.slug),
          encrypted_api_key: isSecretRetained ? encryptCredential(plaintext, key) : null,
          credential_fingerprint: credentialFingerprint(plaintext, key),
          status: fixture.status,
          assigned_to_user_id: assignedUser?.id ?? null,
          assigned_at: assignedUser ? addDays(now, -20) : null,
          revocation_requested_at: fixture.revocationRequestedDaysAgo
            ? addDays(now, -fixture.revocationRequestedDaysAgo)
            : null,
          revoked_at: fixture.revokedDaysAgo ? addDays(now, -fixture.revokedDaysAgo) : null,
          revocation_attempt_count: fixture.revocationAttemptCount,
          last_revocation_error: fixture.lastRevocationError,
        } satisfies typeof coding_plan_key_inventory.$inferInsert;
      })
    );

    const insertedInventory = await tx
      .select({
        id: coding_plan_key_inventory.id,
        upstreamPlanId: coding_plan_key_inventory.upstream_plan_id,
      })
      .from(coding_plan_key_inventory)
      .where(like(coding_plan_key_inventory.upstream_plan_id, `${KEY_PREFIX}:${scenario}:%`));
    const inventoryRows = insertedInventory.map(row => ({
      id: row.id,
      slug: row.upstreamPlanId.replace(`${KEY_PREFIX}:${scenario}:upstream-plan:`, ''),
    }));

    const byokRows = await tx
      .insert(byok_api_keys)
      .values(
        SUBSCRIPTION_FIXTURES.filter(subscription => subscription.status !== 'canceled').map(
          subscription => {
            const user = getUser(users, subscription.slug);
            return {
              kilo_user_id: user.id,
              organization_id: null,
              provider_id: PROVIDER_ID,
              encrypted_api_key: encryptCredential(
                plaintextCredential(scenario, inventorySlugForSubscription(subscription.slug)),
                key
              ),
              management_source: 'coding_plan',
              created_by: user.id,
              is_enabled: true,
            } satisfies typeof byok_api_keys.$inferInsert;
          }
        )
      )
      .returning({ id: byok_api_keys.id, userId: byok_api_keys.kilo_user_id });

    for (const subscription of SUBSCRIPTION_FIXTURES) {
      const user = getUser(users, subscription.slug);
      const plan = PLANS[subscription.planId];
      const subscriptionId = randomUUID();
      const purchaseTransactionId = randomUUID();
      const requestKey = idempotencyFingerprint(
        `${KEY_PREFIX}:${scenario}:subscribe:${subscription.slug}`
      );
      const periodStart = addDays(now, -subscription.startedDaysAgo);
      const periodEnd = addDays(now, subscription.periodEndsInDays);
      const installedByokKey = byokRows.find(row => row.userId === user.id);
      const inventoryRow = getInventoryRow(
        inventoryRows,
        inventorySlugForSubscription(subscription.slug)
      );
      const canceledAt = subscription.canceledDaysAgo
        ? addDays(now, -subscription.canceledDaysAgo)
        : null;
      const paymentGraceExpiresAt = subscription.graceEndsInHours
        ? addHours(now, subscription.graceEndsInHours)
        : null;

      await tx.insert(credit_transactions).values([
        {
          kilo_user_id: user.id,
          amount_microdollars: creditGrantAmount(subscription),
          is_free: true,
          description: 'Dev seed credits for Coding Plan fixtures',
          credit_category: `${KEY_PREFIX}:${scenario}:grant:${subscription.slug}`,
          created_at: addDays(now, -subscription.startedDaysAgo - 1),
          original_baseline_microdollars_used: 0,
          check_category_uniqueness: true,
        } satisfies typeof credit_transactions.$inferInsert,
        {
          id: purchaseTransactionId,
          kilo_user_id: user.id,
          amount_microdollars: -plan.costMicrodollars,
          is_free: false,
          description: `Coding plan: ${PROVIDER_NAME} ${plan.planName}`,
          credit_category: `coding-plan:${plan.planId}:${requestKey}`,
          created_at: periodStart,
          original_baseline_microdollars_used: 0,
          check_category_uniqueness: true,
        } satisfies typeof credit_transactions.$inferInsert,
      ]);

      await tx.insert(coding_plan_subscriptions).values({
        id: subscriptionId,
        user_id: user.id,
        plan_id: plan.planId,
        provider_id: PROVIDER_ID,
        key_inventory_id: inventoryRow.id,
        installed_byok_key_id:
          subscription.status === 'canceled' ? null : (installedByokKey?.id ?? null),
        status: subscription.status,
        cost_microdollars: plan.costMicrodollars,
        billing_period_days: plan.billingPeriodDays,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        credit_renewal_at: periodEnd,
        cancel_at_period_end: subscription.cancelAtPeriodEnd,
        past_due_started_at: subscription.status === 'past_due' ? periodEnd : null,
        payment_grace_expires_at: paymentGraceExpiresAt,
        auto_top_up_attempted_for_due: subscription.status === 'past_due' ? periodEnd : null,
        canceled_at: canceledAt,
        cancellation_reason: subscription.cancellationReason,
        created_at: periodStart,
      } satisfies typeof coding_plan_subscriptions.$inferInsert);

      await tx.insert(coding_plan_terms).values({
        subscription_id: subscriptionId,
        user_id: user.id,
        plan_id: plan.planId,
        kind: 'activation',
        idempotency_key: requestKey,
        period_start: periodStart,
        period_end: periodEnd,
        cost_microdollars: plan.costMicrodollars,
        credit_transaction_id: purchaseTransactionId,
        created_at: periodStart,
      } satisfies typeof coding_plan_terms.$inferInsert);
    }

    const waitlistUser = getUser(users, 'waitlist-ultra');
    const [availabilityIntent] = await tx
      .insert(coding_plan_availability_intents)
      .values({
        user_id: waitlistUser.id,
        plan_id: 'minimax-token-plan-ultra',
      } satisfies typeof coding_plan_availability_intents.$inferInsert)
      .returning({ id: coding_plan_availability_intents.id });

    return {
      scenario,
      usersCreated: users.length,
      subscriptionsCreated: SUBSCRIPTION_FIXTURES.length,
      activeSubscriptions: 1,
      cancellationPendingSubscriptions: 1,
      pastDueSubscriptions: 1,
      canceledSubscriptions: 2,
      inventoryRowsCreated: inventoryFixtures.length,
      availableCredentials: 4,
      assignedCredentials: 3,
      revocationPendingCredentials: 1,
      revocationFailedCredentials: 1,
      revokedCredentials: 1,
      availabilityIntentId: availabilityIntent?.id ?? null,
      activeUserId: getUser(users, 'active-plus').id,
      cancelingUserId: getUser(users, 'canceling-max').id,
      pastDueUserId: getUser(users, 'past-due-ultra').id,
      canceledPendingUserId: getUser(users, 'canceled-pending-plus').id,
      canceledFailedUserId: getUser(users, 'canceled-failed-max').id,
      waitlistUserId: waitlistUser.id,
      activeUserEmail: getUser(users, 'active-plus').email,
      cancelingUserEmail: getUser(users, 'canceling-max').email,
      pastDueUserEmail: getUser(users, 'past-due-ultra').email,
      providerTrafficValid: false,
    } satisfies SeedResult;
  });
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const [rawScenario, ...rest] = args;
  if (rest.length > 0) {
    printUsage();
    throw new Error(`Unexpected extra arguments: ${rest.join(' ')}`);
  }

  const scenario = requireScenario(rawScenario);
  const key = requireEncryptionKey();
  const oldStripeCustomerIds = await cleanupScenario(scenario);
  await Promise.all(oldStripeCustomerIds.map(customerId => deleteSeedStripeCustomer(customerId)));
  const stripeCustomerIds = await createStripeCustomers(scenario);
  const newStripeCustomerIds = Object.values(stripeCustomerIds);
  const users = getSeedUsers(scenario, stripeCustomerIds);

  try {
    const result = await seedScenario(scenario, key, users);

    console.log(
      'Seeded Coding Plan admin fixtures: active, cancellation pending, past due, canceled, and revocation states.'
    );
    console.log('Placeholder MiniMax credentials are encrypted but invalid for provider traffic.');

    return result;
  } catch (error) {
    await Promise.all(newStripeCustomerIds.map(customerId => deleteSeedStripeCustomer(customerId)));
    throw error;
  }
}
