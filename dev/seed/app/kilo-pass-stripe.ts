import { randomUUID } from 'node:crypto';

import { KiloPassCadence, KiloPassPaymentProvider, KiloPassTier } from '@kilocode/db/schema-types';
import { kilo_pass_subscriptions, kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { createSeedStripeCustomer, deleteSeedStripeCustomer } from '../lib/stripe';
import type { SeedResult } from '../index';

export const usage = '<email>';

let cachedStripe: Stripe | null = null;

// `lib/stripe.ts` keeps its client private and only exposes customer helpers.
// This seed needs the raw client to create a personal Kilo Pass subscription,
// so it holds its own test-mode client with the same key validation.
function getStripe(): Stripe {
  if (cachedStripe) return cachedStripe;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. Run `vercel env pull` so dev seeds can create Stripe ' +
        'customers and subscriptions (the real signup flow does the same).'
    );
  }
  if (!secretKey.startsWith('sk_test_')) {
    throw new Error(
      `STRIPE_SECRET_KEY does not look like a test-mode key (expected sk_test_…). Refusing ` +
        `to create real Stripe subscriptions from a dev seed script.`
    );
  }

  cachedStripe = new Stripe(secretKey);
  return cachedStripe;
}

// Validates the Stripe env needed to seed the subscription. Must run before any
// destructive action (cancel + delete) so a config error never leaves the user
// without a pass row.
function validateStripeEnv(): string {
  getStripe(); // throws if STRIPE_SECRET_KEY is missing or not a test key
  const priceId = process.env.STRIPE_KILO_PASS_TIER_49_MONTHLY_PRICE_ID;
  if (!priceId) {
    throw new Error(
      'STRIPE_KILO_PASS_TIER_49_MONTHLY_PRICE_ID is required to seed the Kilo Pass subscription'
    );
  }
  return priceId;
}

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:kilo-pass-stripe ${usage}`);
  console.log('');
  console.log('Creates (or re-creates idempotently) a Kilo Code user with a real Stripe');
  console.log('test-mode Kilo Pass subscription. Used by the Android web-management E2E');
  console.log('scenario so the app shows "This Kilo Pass is managed on the web."');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed app:kilo-pass-stripe e2e-w4b-android-stripe@example.com');
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function deleteSeedStripeSubscription(subscriptionId: string): Promise<void> {
  try {
    await getStripe().subscriptions.cancel(subscriptionId);
  } catch (error) {
    console.warn(
      `[dev-seed] Failed to clean up Stripe subscription ${subscriptionId}:`,
      error instanceof Error ? error.message : error
    );
  }
}

async function deletePriorSubscriptions(userId: string): Promise<void> {
  const db = getSeedDb();
  const rows = await db
    .select({
      id: kilo_pass_subscriptions.id,
      stripeSubscriptionId: kilo_pass_subscriptions.stripe_subscription_id,
    })
    .from(kilo_pass_subscriptions)
    .where(eq(kilo_pass_subscriptions.kilo_user_id, userId));
  for (const row of rows) {
    if (row.stripeSubscriptionId) {
      await deleteSeedStripeSubscription(row.stripeSubscriptionId);
    }
  }
  if (rows.length > 0) {
    await db
      .delete(kilo_pass_subscriptions)
      .where(eq(kilo_pass_subscriptions.kilo_user_id, userId));
  }
}

async function createKiloPassSubscription(params: {
  stripeCustomerId: string;
  priceId: string;
  kiloUserId: string;
}): Promise<Stripe.Subscription> {
  const stripe = getStripe();
  const paymentMethod = await stripe.paymentMethods.attach('pm_card_visa', {
    customer: params.stripeCustomerId,
  });
  await stripe.customers.update(params.stripeCustomerId, {
    invoice_settings: { default_payment_method: paymentMethod.id },
  });
  return stripe.subscriptions.create({
    customer: params.stripeCustomerId,
    items: [{ price: params.priceId }],
    default_payment_method: paymentMethod.id,
    metadata: {
      type: 'kilo_pass',
      kiloUserId: params.kiloUserId,
      tier: 'tier_49',
      cadence: 'monthly',
      source: 'dev-seed',
    },
  });
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const [email, ...rest] = args;
  if (!email) {
    printUsage();
    throw new Error('email is required');
  }
  if (rest.length > 0) {
    printUsage();
    throw new Error(`Unexpected extra arguments: ${rest.join(' ')}`);
  }
  if (!isValidEmail(email)) {
    throw new Error(`email is not a valid address: ${email}`);
  }

  // Validate Stripe env before any delete so a config error does not cancel a
  // subscription or delete a row first.
  const priceId = validateStripeEnv();

  const db = getSeedDb();
  const trimmedEmail = email.trim();
  const normalizedEmail = normalizeSeedEmail(trimmedEmail);

  const existing = await db
    .select({
      id: kilocode_users.id,
      stripeCustomerId: kilocode_users.stripe_customer_id,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.normalized_email, normalizedEmail))
    .limit(1);

  let userId: string;
  let stripeCustomerId: string;

  if (existing.length > 0) {
    userId = existing[0].id;
    stripeCustomerId = existing[0].stripeCustomerId;
    await deletePriorSubscriptions(userId);
  } else {
    userId = randomUUID();
    const stripeCustomer = await createSeedStripeCustomer({
      email: trimmedEmail,
      name: 'W4B Stripe',
      kiloUserId: userId,
    });
    stripeCustomerId = stripeCustomer.id;
    try {
      await db.insert(kilocode_users).values({
        id: userId,
        google_user_email: trimmedEmail,
        google_user_name: 'W4B Stripe',
        google_user_image_url: `https://example.com/${encodeURIComponent(userId)}.png`,
        stripe_customer_id: stripeCustomer.id,
        normalized_email: normalizedEmail,
        has_validation_stytch: true,
        customer_source: 'dev-seed',
      });
    } catch (error) {
      await deleteSeedStripeCustomer(stripeCustomer.id);
      throw error;
    }
  }

  // `stripe_customer_id` is notNull, so an existing user always has a customer.
  // This guard is defensive for any legacy row with an empty customer id.
  if (!stripeCustomerId) {
    const stripeCustomer = await createSeedStripeCustomer({
      email: trimmedEmail,
      name: 'W4B Stripe',
      kiloUserId: userId,
    });
    stripeCustomerId = stripeCustomer.id;
    await db
      .update(kilocode_users)
      .set({ stripe_customer_id: stripeCustomer.id })
      .where(eq(kilocode_users.id, userId));
  }

  const subscription = await createKiloPassSubscription({
    stripeCustomerId,
    priceId,
    kiloUserId: userId,
  });

  // Upsert on the unique `stripe_subscription_id`: the local `stripe listen`
  // webhook may have already written this row for the same subscription. A plain
  // insert would fail on the unique key.
  await db
    .insert(kilo_pass_subscriptions)
    .values({
      kilo_user_id: userId,
      payment_provider: KiloPassPaymentProvider.Stripe,
      provider_subscription_id: subscription.id,
      stripe_subscription_id: subscription.id,
      tier: KiloPassTier.Tier49,
      cadence: KiloPassCadence.Monthly,
      status: 'active',
      cancel_at_period_end: false,
      started_at: new Date().toISOString(),
      ended_at: null,
    })
    .onConflictDoUpdate({
      target: kilo_pass_subscriptions.stripe_subscription_id,
      set: {
        kilo_user_id: userId,
        payment_provider: KiloPassPaymentProvider.Stripe,
        provider_subscription_id: subscription.id,
        stripe_subscription_id: subscription.id,
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancel_at_period_end: false,
        started_at: new Date().toISOString(),
        ended_at: null,
      },
    });

  console.log('This fixture represents a web-managed (Stripe) Kilo Pass subscription.');
  console.log('Suggested next step: fake-login as the user and open the Kilo Pass screen.');

  return {
    userId,
    email: trimmedEmail,
  };
}
