import { db } from '@/lib/drizzle';
import { sql, eq, and, isNull } from 'drizzle-orm';
import { magic_link_tokens } from '@kilocode/db/schema';
import * as z from 'zod';
import 'server-only';
import { NEXTAUTH_SECRET, NEXTAUTH_URL } from '@/lib/config.server';
import { randomBytes, randomInt, createHash, createHmac } from 'crypto';
import { normalizeEmail } from '@/lib/utils';

const SIGN_IN_CODE_EXPIRY_MINUTES = 10;
const SIGN_IN_CODE_MAX_ATTEMPTS = 5;

function hashSignInCode(email: string, code: string): string {
  return createHmac('sha256', NEXTAUTH_SECRET).update(`${email}:${code}`).digest('hex');
}

export type MagicLinkToken = z.infer<typeof MagicLinkToken>;
export const MagicLinkToken = z.object({
  token_hash: z.string(),
  email: z.string().email(),
  expires_at: z.string(),
  consumed_at: z.string().nullable(),
  created_at: z.string(),
  purpose: z.enum(['magic_link', 'sign_in_code']),
});

export type MagicLinkTokenWithPlaintext = z.infer<typeof MagicLinkTokenWithPlaintext>;
export const MagicLinkTokenWithPlaintext = MagicLinkToken.extend({
  plaintext_token: z.string(),
});

/**
 * Generate a new magic link token using Node's crypto module.
 * The token is generated in JS and the hash is stored in the database.
 *
 * @param email - The email address to associate with the token
 * @param expiresInMinutes - Number of minutes until the token expires (default: 30)
 * @returns The created token record with the plaintext token (for sending in email)
 */
export async function createMagicLinkToken(
  email: string,
  expiresInMinutes: number = 30
): Promise<MagicLinkTokenWithPlaintext> {
  const plaintext_token = randomBytes(32).toString('hex');
  const token_hash = createHash('sha256').update(plaintext_token).digest('hex');
  const expires_at = new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString();

  const [inserted] = await db
    .insert(magic_link_tokens)
    .values({ token_hash, email, expires_at, purpose: 'magic_link' })
    .returning();

  if (!inserted) {
    throw new Error('Failed to create magic link token');
  }

  return MagicLinkTokenWithPlaintext.parse({ ...inserted, plaintext_token });
}

/**
 * Verify and consume a magic link token atomically.
 * This function will only succeed if the token:
 * - Exists in the database
 * - Has not been consumed yet
 * - Has not expired
 *
 * If successful, the token is marked as consumed and cannot be used again.
 *
 * @param plaintextToken - The plaintext token from the magic link URL
 * @returns The token record if valid and consumed, null otherwise
 */
export async function verifyAndConsumeMagicLinkToken(
  plaintextToken: string
): Promise<MagicLinkToken | null> {
  const token_hash = createHash('sha256').update(plaintextToken).digest('hex');

  const result = await db
    .update(magic_link_tokens)
    .set({ consumed_at: sql`NOW()` })
    .where(
      and(
        eq(magic_link_tokens.token_hash, token_hash),
        eq(magic_link_tokens.purpose, 'magic_link'),
        isNull(magic_link_tokens.consumed_at),
        sql`${magic_link_tokens.expires_at} > NOW()`
      )
    )
    .returning();

  if (!result[0]) {
    return null;
  }

  return MagicLinkToken.parse(result[0]);
}

/**
 * Create a 6-digit email sign-in code. Since a 6-digit code has low entropy,
 * only one live (unconsumed) code is allowed per email at a time: any prior
 * unconsumed rows for the email are deleted before inserting the new one.
 *
 * The stored hash is an HMAC keyed by the server secret, so a database leak
 * does not permit offline enumeration of the six-digit code space.
 *
 * @param email - The email address to send the code to (case-insensitive)
 * @returns The plaintext 6-digit code (for sending in email)
 */
export async function createSignInCode(email: string): Promise<string> {
  const normalizedEmail = normalizeEmail(email);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const token_hash = hashSignInCode(normalizedEmail, code);
  const expires_at = new Date(Date.now() + SIGN_IN_CODE_EXPIRY_MINUTES * 60 * 1000).toISOString();

  await db.transaction(async tx => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sign-in-code:${normalizedEmail}`}, 0))`
    );
    await tx
      .delete(magic_link_tokens)
      .where(
        and(
          eq(magic_link_tokens.email, normalizedEmail),
          eq(magic_link_tokens.purpose, 'sign_in_code'),
          isNull(magic_link_tokens.consumed_at)
        )
      );
    await tx
      .insert(magic_link_tokens)
      .values({ token_hash, email: normalizedEmail, expires_at, purpose: 'sign_in_code' });
  });

  return code;
}

export type VerifySignInCodeResult = 'ok' | 'invalid' | 'too_many_attempts';

/**
 * Verify and consume an email sign-in code atomically, scoped by email.
 *
 * Attempt limiting is checked BEFORE the hash comparison: once the live
 * code for an email has recorded 5+ failed attempts, this returns
 * 'too_many_attempts' even for the correct code. A mismatch increments
 * attempts on the email's unconsumed row(s) and returns 'invalid'; so does
 * an expired, already-consumed, or nonexistent code.
 */
export async function verifyAndConsumeSignInCode(
  email: string,
  code: string
): Promise<VerifySignInCodeResult> {
  const normalizedEmail = normalizeEmail(email);

  const [row] = await db
    .select()
    .from(magic_link_tokens)
    .where(
      and(
        eq(magic_link_tokens.email, normalizedEmail),
        eq(magic_link_tokens.purpose, 'sign_in_code'),
        isNull(magic_link_tokens.consumed_at),
        sql`${magic_link_tokens.expires_at} > NOW()`
      )
    )
    .limit(1);

  if (!row) {
    return 'invalid';
  }

  if (row.attempts >= SIGN_IN_CODE_MAX_ATTEMPTS) {
    return 'too_many_attempts';
  }

  const token_hash = hashSignInCode(normalizedEmail, code);
  if (row.token_hash === token_hash) {
    // attempts < MAX is re-checked here atomically: the early read above is
    // only a fast path, and two concurrent wrong guesses can race it past
    // the budget. This predicate guarantees an over-budget code can never
    // consume regardless of racing increments.
    const consumed = await db
      .update(magic_link_tokens)
      .set({ consumed_at: sql`NOW()` })
      .where(
        and(
          eq(magic_link_tokens.token_hash, token_hash),
          eq(magic_link_tokens.email, normalizedEmail),
          eq(magic_link_tokens.purpose, 'sign_in_code'),
          isNull(magic_link_tokens.consumed_at),
          sql`${magic_link_tokens.expires_at} > NOW()`,
          sql`${magic_link_tokens.attempts} < ${SIGN_IN_CODE_MAX_ATTEMPTS}`
        )
      )
      .returning();

    if (consumed[0]) {
      return 'ok';
    }

    const [current] = await db
      .select({ attempts: magic_link_tokens.attempts })
      .from(magic_link_tokens)
      .where(
        and(
          eq(magic_link_tokens.token_hash, token_hash),
          eq(magic_link_tokens.email, normalizedEmail),
          eq(magic_link_tokens.purpose, 'sign_in_code'),
          isNull(magic_link_tokens.consumed_at)
        )
      )
      .limit(1);
    return current && current.attempts >= SIGN_IN_CODE_MAX_ATTEMPTS
      ? 'too_many_attempts'
      : 'invalid';
  }

  await db
    .update(magic_link_tokens)
    .set({ attempts: sql`${magic_link_tokens.attempts} + 1` })
    .where(
      and(
        eq(magic_link_tokens.email, normalizedEmail),
        eq(magic_link_tokens.purpose, 'sign_in_code'),
        isNull(magic_link_tokens.consumed_at),
        sql`${magic_link_tokens.attempts} < ${SIGN_IN_CODE_MAX_ATTEMPTS}`
      )
    );

  return 'invalid';
}

export async function deleteSignInCode(email: string, code: string): Promise<void> {
  const normalizedEmail = normalizeEmail(email);
  await db
    .delete(magic_link_tokens)
    .where(
      and(
        eq(magic_link_tokens.token_hash, hashSignInCode(normalizedEmail, code)),
        eq(magic_link_tokens.email, normalizedEmail),
        eq(magic_link_tokens.purpose, 'sign_in_code'),
        isNull(magic_link_tokens.consumed_at)
      )
    );
}

export function getMagicLinkUrl(
  { plaintext_token }: MagicLinkTokenWithPlaintext,
  callbackUrl?: string
): string {
  const url = new URL(`${NEXTAUTH_URL}/auth/verify-magic-link`);
  url.searchParams.set('token', plaintext_token);
  if (callbackUrl) {
    url.searchParams.set('callbackUrl', callbackUrl);
  }
  return url.toString();
}
