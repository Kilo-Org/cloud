import { db } from '@/lib/drizzle';
import { sql, eq, and, isNull } from 'drizzle-orm';
import { magic_link_tokens } from '@kilocode/db/schema';
import * as z from 'zod';
import 'server-only';
import { NEXTAUTH_SECRET, NEXTAUTH_URL } from '@/lib/config.server';
import { randomBytes, randomInt, randomUUID, createHash, createHmac } from 'crypto';
import { normalizeEmail } from '@/lib/utils';
import { captureMessage } from '@sentry/nextjs';

const SIGN_IN_CODE_EXPIRY_MINUTES = 10;
const SIGN_IN_CODE_MAX_ATTEMPTS = 5;
// Reservations expire on their own after two minutes — no cleanup job is needed.
const SIGN_IN_CODE_RESERVATION_MINUTES = 2;

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
 * A random opaque challenge_id is generated alongside the code. The client
 * must present it when verifying, so that attempts against challenge A do
 * not spend challenge B's budget.
 *
 * @param email - The email address to send the code to (case-insensitive)
 * @returns The plaintext 6-digit code and an opaque challenge identifier
 */
export async function createSignInCode(
  email: string
): Promise<{ code: string; challengeId: string }> {
  const normalizedEmail = normalizeEmail(email);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const token_hash = hashSignInCode(normalizedEmail, code);
  const challengeId = randomUUID();
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
    await tx.insert(magic_link_tokens).values({
      token_hash,
      email: normalizedEmail,
      expires_at,
      purpose: 'sign_in_code',
      challenge_id: challengeId,
    });
  });

  return { code, challengeId };
}

export type ReserveSignInCodeResult = 'ok' | 'invalid' | 'too_many_attempts' | 'in_progress';
export type VerifySignInCodeResult = 'ok' | 'invalid' | 'too_many_attempts';

/**
 * Reserve a sign-in code for settlement. Does not consume the code.
 * A live reservation blocks concurrent callers, who receive 'in_progress'.
 * A failed settlement must call releaseSignInCode so the code stays usable.
 *
 * When challengeId is supplied, all lookups, the pre-check, and the increment
 * are keyed by challenge_id instead of email. This isolates attempt budgets:
 * guesses against challenge A do not spend challenge B's budget.
 *
 * When challengeId is absent, the legacy email-keyed path is used for
 * shipped clients that do not yet send a challenge. The email-keyed path
 * matches the live sign-in code row for the email whether or not it carries
 * a challenge_id, so old clients can reserve codes minted by new clients.
 *
 * Returns 'ok' when the code is reserved, 'invalid' for a wrong/expired/consumed
 * code, 'too_many_attempts' when the attempt budget is exhausted, and
 * 'in_progress' when another caller already holds the reservation.
 */
export async function reserveSignInCode(
  email: string,
  code: string,
  challengeId?: string
): Promise<ReserveSignInCodeResult> {
  const normalizedEmail = normalizeEmail(email);

  const lookupWhere = challengeId
    ? and(
        eq(magic_link_tokens.challenge_id, challengeId),
        eq(magic_link_tokens.purpose, 'sign_in_code'),
        isNull(magic_link_tokens.consumed_at),
        sql`${magic_link_tokens.expires_at} > NOW()`
      )
    : and(
        eq(magic_link_tokens.email, normalizedEmail),
        eq(magic_link_tokens.purpose, 'sign_in_code'),
        isNull(magic_link_tokens.consumed_at),
        sql`${magic_link_tokens.expires_at} > NOW()`
      );

  const [row] = await db.select().from(magic_link_tokens).where(lookupWhere).limit(1);

  if (!row) {
    return 'invalid';
  }

  if (row.attempts >= SIGN_IN_CODE_MAX_ATTEMPTS) {
    return 'too_many_attempts';
  }

  const token_hash = hashSignInCode(normalizedEmail, code);
  if (row.token_hash === token_hash) {
    const reserved = await db
      .update(magic_link_tokens)
      .set({
        reserved_until: sql`NOW() + interval '${sql.raw(String(SIGN_IN_CODE_RESERVATION_MINUTES))} minutes'`,
      })
      .where(
        and(
          eq(magic_link_tokens.token_hash, token_hash),
          eq(magic_link_tokens.email, normalizedEmail),
          eq(magic_link_tokens.purpose, 'sign_in_code'),
          isNull(magic_link_tokens.consumed_at),
          sql`${magic_link_tokens.expires_at} > NOW()`,
          sql`${magic_link_tokens.attempts} < ${SIGN_IN_CODE_MAX_ATTEMPTS}`,
          sql`(${magic_link_tokens.reserved_until} IS NULL OR ${magic_link_tokens.reserved_until} < NOW())`
        )
      )
      .returning();

    if (reserved[0]) {
      return 'ok';
    }

    const [current] = await db
      .select({
        attempts: magic_link_tokens.attempts,
        reserved_until: magic_link_tokens.reserved_until,
      })
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

    if (!current) {
      return 'invalid';
    }
    if (current.attempts >= SIGN_IN_CODE_MAX_ATTEMPTS) {
      return 'too_many_attempts';
    }
    if (current.reserved_until && new Date(current.reserved_until) > new Date()) {
      return 'in_progress';
    }
    return 'invalid';
  }

  // Increment attempts: key by challenge_id when available, otherwise by email.
  // The legacy email-keyed path matches the live row regardless of challenge_id,
  // so a no-challenge caller cannot bypass the budget of a challenge-bound row.
  const incrementWhere = challengeId
    ? and(
        eq(magic_link_tokens.challenge_id, challengeId),
        eq(magic_link_tokens.purpose, 'sign_in_code'),
        isNull(magic_link_tokens.consumed_at),
        sql`${magic_link_tokens.attempts} < ${SIGN_IN_CODE_MAX_ATTEMPTS}`
      )
    : and(
        eq(magic_link_tokens.email, normalizedEmail),
        eq(magic_link_tokens.purpose, 'sign_in_code'),
        isNull(magic_link_tokens.consumed_at),
        sql`${magic_link_tokens.attempts} < ${SIGN_IN_CODE_MAX_ATTEMPTS}`
      );

  await db
    .update(magic_link_tokens)
    .set({ attempts: sql`${magic_link_tokens.attempts} + 1` })
    .where(incrementWhere);

  // ponytail: remove legacy counter and no-challenge path when
  // native_signin_code_legacy_no_challenge_count drains to 0 for
  // 7 consecutive days — all shipped clients must send a challengeId.
  if (!challengeId) {
    captureMessage('native_signin_code_legacy_no_challenge_count: 1');
  }

  return 'invalid';
}

/**
 * Commit a reserved sign-in code by setting consumed_at.
 * Must be called only after a successful settlement.
 * The reservation must still be live (reserved_until > NOW()).
 *
 * When challengeId is supplied, the commit is scoped to the challenge.
 *
 * Returns true when the code was committed, false when the reservation
 * lapsed or the row was already consumed.
 */
export async function commitSignInCode(
  email: string,
  code: string,
  challengeId?: string
): Promise<boolean> {
  const normalizedEmail = normalizeEmail(email);
  const token_hash = hashSignInCode(normalizedEmail, code);

  const whereClauses = [
    eq(magic_link_tokens.token_hash, token_hash),
    eq(magic_link_tokens.email, normalizedEmail),
    eq(magic_link_tokens.purpose, 'sign_in_code'),
    isNull(magic_link_tokens.consumed_at),
    sql`${magic_link_tokens.reserved_until} > NOW()`,
  ];
  if (challengeId) {
    whereClauses.push(eq(magic_link_tokens.challenge_id, challengeId));
  }

  const committed = await db
    .update(magic_link_tokens)
    .set({ consumed_at: sql`NOW()`, reserved_until: null })
    .where(and(...whereClauses))
    .returning();

  return committed.length > 0;
}

/**
 * Release a reserved sign-in code without consuming it or incrementing attempts.
 * A settlement failure is not a wrong guess — it must not cost the user an attempt.
 *
 * When challengeId is supplied, the release is scoped to the challenge.
 */
export async function releaseSignInCode(
  email: string,
  code: string,
  challengeId?: string
): Promise<void> {
  const normalizedEmail = normalizeEmail(email);
  const token_hash = hashSignInCode(normalizedEmail, code);

  const whereClauses = [
    eq(magic_link_tokens.token_hash, token_hash),
    eq(magic_link_tokens.email, normalizedEmail),
    eq(magic_link_tokens.purpose, 'sign_in_code'),
    isNull(magic_link_tokens.consumed_at),
  ];
  if (challengeId) {
    whereClauses.push(eq(magic_link_tokens.challenge_id, challengeId));
  }

  await db
    .update(magic_link_tokens)
    .set({ reserved_until: null })
    .where(and(...whereClauses));
}

/**
 * Consume a sign-in code unconditionally, regardless of reservation status.
 * Used when the reservation lapsed between settlement and commit — the user
 * is legitimately settled and this prevents a second settlement with the same code.
 *
 * When challengeId is supplied, the consume is scoped to the challenge.
 */
export async function consumeSignInCode(
  email: string,
  code: string,
  challengeId?: string
): Promise<boolean> {
  const normalizedEmail = normalizeEmail(email);
  const token_hash = hashSignInCode(normalizedEmail, code);

  const whereClauses = [
    eq(magic_link_tokens.token_hash, token_hash),
    eq(magic_link_tokens.email, normalizedEmail),
    eq(magic_link_tokens.purpose, 'sign_in_code'),
    isNull(magic_link_tokens.consumed_at),
  ];
  if (challengeId) {
    whereClauses.push(eq(magic_link_tokens.challenge_id, challengeId));
  }

  const consumed = await db
    .update(magic_link_tokens)
    .set({ consumed_at: sql`NOW()`, reserved_until: null })
    .where(and(...whereClauses))
    .returning();

  return consumed.length > 0;
}

/**
 * Verify and consume an email sign-in code atomically, scoped by email.
 *
 * This is a thin compatibility wrapper that reserves then immediately commits.
 * Callers that perform a settlement (createOrUpdateUser) between verification
 * and consumption must use reserveSignInCode / commitSignInCode / releaseSignInCode
 * directly instead.
 */
export async function verifyAndConsumeSignInCode(
  email: string,
  code: string,
  challengeId?: string
): Promise<VerifySignInCodeResult> {
  const result = await reserveSignInCode(email, code, challengeId);
  if (result !== 'ok') {
    // Map 'in_progress' to 'invalid' — the wrapper has no settlement phase
    // so a reservation conflict is a bug, not a retryable state.
    return result === 'in_progress' ? 'invalid' : result;
  }
  const committed = await commitSignInCode(email, code, challengeId);
  if (!committed) {
    // Reservation expired between reserve and commit — release so the code
    // stays usable and the user can retry.
    await releaseSignInCode(email, code, challengeId);
    return 'invalid';
  }
  return 'ok';
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
