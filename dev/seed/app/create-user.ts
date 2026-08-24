import { randomUUID } from 'node:crypto';

import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { createSeedStripeCustomer, deleteSeedStripeCustomer } from '../lib/stripe';
import type { SeedResult } from '../index';

export const usage = '<name> <email> [--admin]';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:create-user ${usage}`);
  console.log('');
  console.log('Creates a Kilo Code user for local development. Skips Stripe/OAuth flows;');
  console.log('the inserted row is wired up with placeholder identifiers so it works in the');
  console.log('app, but the user has no auth provider linked. Sign in via the normal flow if');
  console.log('you need a real session.');
  console.log('');
  console.log('Options:');
  console.log(
    '  --admin                   Set is_admin=true (also grants it if the user already exists)'
  );
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed app:create-user "Ada Lovelace" ada@example.com');
  console.log('  pnpm dev:seed app:create-user "Evgeny" evgeny@kilocode.ai --admin');
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

  const positional: string[] = [];
  let isAdmin = false;
  for (const arg of args) {
    if (arg === '--admin') {
      isAdmin = true;
      continue;
    }
    if (arg.startsWith('--')) {
      printUsage();
      throw new Error(`Unknown argument: ${arg}`);
    }
    positional.push(arg);
  }

  const [name, email, ...rest] = positional;
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
    .select({
      id: kilocode_users.id,
      stripeCustomerId: kilocode_users.stripe_customer_id,
      isAdmin: kilocode_users.is_admin,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.normalized_email, normalizedEmail))
    .limit(1);

  const existingUser = existing[0];
  if (existingUser) {
    if (!isAdmin) {
      throw new Error(
        `A user with email ${trimmedEmail} already exists (id=${existingUser.id}). ` +
          `Delete it first or pick a different email.`
      );
    }

    if (!existingUser.isAdmin) {
      await db
        .update(kilocode_users)
        .set({ is_admin: true })
        .where(eq(kilocode_users.id, existingUser.id));
    }

    return {
      userId: existingUser.id,
      name: trimmedName,
      email: trimmedEmail,
      stripeCustomerId: existingUser.stripeCustomerId,
      hasValidationStytch: true,
      customerSource: 'dev-seed',
      isAdmin: true,
      created: false,
    };
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
      is_admin: isAdmin,
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
    isAdmin,
    created: true,
  };
}
