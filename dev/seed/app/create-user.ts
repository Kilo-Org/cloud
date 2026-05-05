import { randomUUID } from 'node:crypto';

import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { createSeedStripeCustomer, deleteSeedStripeCustomer } from '../lib/stripe';
import type { SeedResult } from '../index';

export const usage = '<name> <email>';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:create-user ${usage}`);
  console.log('');
  console.log('Creates a Kilo Code user for local development. Skips Stripe/OAuth flows;');
  console.log('the inserted row is wired up with placeholder identifiers so it works in the');
  console.log('app, but the user has no auth provider linked. Sign in via the normal flow if');
  console.log('you need a real session.');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed app:create-user "Ada Lovelace" ada@example.com');
}

function isValidEmail(email: string): boolean {
  // Intentionally permissive; we only guard against obvious nonsense in dev.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const [name, email, ...rest] = args;
  if (!name || !email) {
    printUsage();
    throw new Error('name and email are required');
  }
  if (rest.length > 0) {
    printUsage();
    throw new Error(`Unexpected extra arguments: ${rest.join(' ')}`);
  }
  if (!isValidEmail(email)) {
    throw new Error(`email is not a valid address: ${email}`);
  }

  const db = getSeedDb();
  const trimmedName = name.trim();
  const trimmedEmail = email.trim();
  const normalizedEmail = normalizeSeedEmail(trimmedEmail);

  const existing = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.normalized_email, normalizedEmail))
    .limit(1);

  if (existing.length > 0) {
    throw new Error(
      `A user with email ${trimmedEmail} already exists (id=${existing[0].id}). ` +
        `Delete it first or pick a different email.`
    );
  }

  const userId = randomUUID();

  // Create a real Stripe test-mode customer first so that pages like /profile
  // (which call into Stripe with stripe_customer_id) don't 400 with
  // `No such customer`. Mirrors apps/web/src/lib/user.ts createUserOnSignIn.
  const stripeCustomer = await createSeedStripeCustomer({
    email: trimmedEmail,
    name: trimmedName,
    kiloUserId: userId,
  });

  // Pre-set the onboarding gates so seeded users can hit dashboards without
  // bouncing through `/account-verification` (gated on
  // `has_validation_stytch !== null`) or `/customer-source-survey` (gated on
  // `customer_source !== null`). See apps/web/src/lib/stytch.ts and
  // apps/web/src/lib/survey-redirect.ts.
  try {
    await db.insert(kilocode_users).values({
      id: userId,
      google_user_email: trimmedEmail,
      google_user_name: trimmedName,
      google_user_image_url: `https://example.com/${encodeURIComponent(userId)}.png`,
      stripe_customer_id: stripeCustomer.id,
      normalized_email: normalizedEmail,
      has_validation_stytch: true,
      customer_source: 'dev-seed',
    });
  } catch (error) {
    // The DB insert failed after we already created a Stripe customer; clean
    // it up so we don't leave orphans in the test-mode account.
    await deleteSeedStripeCustomer(stripeCustomer.id);
    throw error;
  }

  return {
    userId,
    name: trimmedName,
    email: trimmedEmail,
    stripeCustomerId: stripeCustomer.id,
    hasValidationStytch: true,
    customerSource: 'dev-seed',
  };
}
