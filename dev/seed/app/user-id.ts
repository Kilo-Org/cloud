import { kilocode_users } from '@kilocode/db/schema';
import { eq, or } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import type { SeedResult } from '../index';

export const usage = '<email>';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:user-id ${usage}`);
  console.log('');
  console.log('Prints the Kilo Code user id for a local development user by email.');
  console.log('Matches either google_user_email exactly or normalized_email.');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed app:user-id ada@example.com');
  console.log('  pnpm -s dev:seed app:user-id ada@example.com --json | jq -r .userId');
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

  const [email, ...rest] = args;
  if (!email) {
    printUsage();
    throw new Error('email is required');
  }
  if (rest.length > 0) {
    printUsage();
    throw new Error(`Unexpected extra arguments: ${rest.join(' ')}`);
  }

  const trimmedEmail = email.trim();
  if (!isValidEmail(trimmedEmail)) {
    throw new Error(`email is not a valid address: ${trimmedEmail}`);
  }

  const normalizedEmail = normalizeSeedEmail(trimmedEmail);
  const db = getSeedDb();
  const matches = await db
    .select({
      userId: kilocode_users.id,
      email: kilocode_users.google_user_email,
      normalizedEmail: kilocode_users.normalized_email,
    })
    .from(kilocode_users)
    .where(
      or(
        eq(kilocode_users.google_user_email, trimmedEmail),
        eq(kilocode_users.normalized_email, normalizedEmail)
      )
    );

  if (matches.length === 0) {
    throw new Error(`No user found for email ${trimmedEmail}`);
  }

  const exactMatches = matches.filter(match => match.email === trimmedEmail);
  const resolvedMatches = exactMatches.length > 0 ? exactMatches : matches;
  if (resolvedMatches.length > 1) {
    const matchList = resolvedMatches.map(match => `${match.email} (${match.userId})`).join(', ');
    throw new Error(`Multiple users matched ${trimmedEmail}: ${matchList}`);
  }

  const [user] = resolvedMatches;
  return {
    userId: user.userId,
    email: user.email,
    normalizedEmail: user.normalizedEmail ?? null,
  };
}
