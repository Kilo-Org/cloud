import { kilocode_users } from '@kilocode/db/schema';
import { eq, or } from 'drizzle-orm';

import { getSeedDb } from './db';
import { normalizeSeedEmail } from './email';

export function isValidEmail(email: string): boolean {
  // Intentionally permissive; we only guard against obvious nonsense in dev.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * The account that already holds `email`, or null when no row exists for it.
 *
 * A fixture that owns a fixed user id calls this first: a fake account that
 * signed in on a device keeps the id the sign-in gave it, so the fixture adopts
 * that row instead of colliding with its unique email.
 */
export async function findSeedUserId(email: string): Promise<string | null> {
  const normalizedEmail = normalizeSeedEmail(email);
  const db = getSeedDb();
  const matches = await db
    .select({
      userId: kilocode_users.id,
      email: kilocode_users.google_user_email,
    })
    .from(kilocode_users)
    .where(
      or(
        eq(kilocode_users.google_user_email, email),
        eq(kilocode_users.normalized_email, normalizedEmail)
      )
    );

  const exactMatches = matches.filter(match => match.email === email);
  const resolvedMatches = exactMatches.length > 0 ? exactMatches : matches;
  if (resolvedMatches.length > 1) {
    const matchList = resolvedMatches.map(match => `${match.email} (${match.userId})`).join(', ');
    throw new Error(`Multiple users matched ${email}: ${matchList}`);
  }

  return resolvedMatches.at(0)?.userId ?? null;
}

export async function resolveSeedUserId(email: string): Promise<string> {
  const userId = await findSeedUserId(email);
  if (!userId) {
    throw new Error(`No user found for email ${email}`);
  }
  return userId;
}
