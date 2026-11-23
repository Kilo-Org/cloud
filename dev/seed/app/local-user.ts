import { randomUUID } from 'node:crypto';

import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { isValidEmail } from '../lib/users';

export const usage = '<name> <email>';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:local-user ${usage}`);
  console.log('');
  console.log('Creates one signed-in-ready dev user without a Stripe round trip.');
  console.log('Use it on a machine with no Stripe test secret: the row carries a local');
  console.log('placeholder customer id, which only the billing pages read. Every other');
  console.log('surface, including the session and failure-history views, works unchanged.');
  console.log('');
  console.log('Example:');
  console.log('  pnpm dev:seed app:local-user "Ada Lovelace" ada@example.com');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const [name, email] = args;
  if (!name?.trim() || !email?.trim()) {
    printUsage();
    throw new Error('name and email are required');
  }
  if (!isValidEmail(email)) {
    throw new Error(`email is not a valid address: ${email}`);
  }

  assertLocalSeedDatabase('app:local-user');
  const db = getSeedDb();
  const trimmedEmail = email.trim();
  const normalizedEmail = normalizeSeedEmail(trimmedEmail);

  const [existing] = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.normalized_email, normalizedEmail))
    .limit(1);
  if (existing) {
    console.log('');
    console.log('This user already exists; nothing was written.');
    return { userId: existing.id, email: trimmedEmail, created: false };
  }

  // The onboarding gates are pre-set for the same reason the Stripe-backed
  // topic sets them: a seeded user must reach product screens directly.
  const userId = randomUUID();
  await db.insert(kilocode_users).values({
    id: userId,
    google_user_email: trimmedEmail,
    google_user_name: name.trim(),
    google_user_image_url: `https://example.com/${encodeURIComponent(userId)}.png`,
    stripe_customer_id: `cus_local_${userId.slice(0, 12)}`,
    normalized_email: normalizedEmail,
    has_validation_stytch: true,
    customer_source: 'dev-seed',
  });

  console.log('');
  console.log('This fixture represents a signed-in account with no billing history.');
  console.log('Suggested next step: sign in as ' + trimmedEmail + ' in the dev app.');

  return { userId, email: trimmedEmail, created: true };
}
