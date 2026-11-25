import 'server-only';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createHmac, randomInt, randomUUID } from 'crypto';
import { magic_link_tokens } from '@kilocode/db/schema';
import type { AuthProviderId } from '@kilocode/db/schema-types';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { normalizeEmail } from '@kilocode/web-shared/lib/email-address';
import {
  SIGN_IN_METHOD_CHANGE_CODE_LENGTH,
  SIGN_IN_METHOD_CHANGE_CODE_LOCKOUT_MINUTES,
} from '@/lib/auth/sign-in-method-change-codes';
import type { SignInMethodChange } from '@/lib/auth/sign-in-method-change';

/**
 * One-time codes that authorize one sign-in method link or unlink. The code is
 * sent to the account's primary email address, so a correct code proves that
 * the person controls that mailbox, not only a session cookie.
 *
 * The codes live in `magic_link_tokens` under their own `purpose`, and every
 * query here is purpose-scoped: `/api/auth/native/token` accepts a live
 * `sign_in_code` as a sign-in credential, so these codes must never share it.
 *
 * Wrong codes are counted per account, across codes. A code row's `expires_at`
 * is the moment the code stops taking guesses: its expiry, its replacement by a
 * newer code, or the lockout. The row's wrong attempts count until the attempt
 * window has passed after that moment, so a new code does not reset the count.
 * When the count reaches the limit, every counted code ends at once, so the
 * lockout lasts the full window from the failure that reached the limit.
 */
const CODE_PURPOSE = 'sign_in_method_change';
export const SIGN_IN_METHOD_CHANGE_CODE_EXPIRY_MINUTES = 10;
// Wrong codes allowed for one account within the attempt window, across codes.
const MAX_FAILED_ATTEMPTS = 5;
// Minimum gap between two code emails, so a held session can not flood the mailbox.
const RESEND_COOLDOWN_SECONDS = 60;
// Wrong codes count for the lockout time after their code stops taking guesses,
// and the lockout runs for that time from the wrong code that reached the limit.
const ATTEMPT_WINDOW = sql.raw(`interval '${SIGN_IN_METHOD_CHANGE_CODE_LOCKOUT_MINUTES} minutes'`);
const RESEND_COOLDOWN = sql.raw(`interval '${RESEND_COOLDOWN_SECONDS} seconds'`);

/** What one code authorizes. A code for another binding does not match. */
export type SignInMethodChangeCodeBinding = {
  userId: string;
  email: string;
  change: SignInMethodChange;
  provider: AuthProviderId;
  webSessionId: string;
};

/**
 * The code hash binds the user, the change, the provider and the browser
 * session. It is keyed by the server secret, so a database leak does not let
 * a person test codes offline.
 */
function hashCode(binding: SignInMethodChangeCodeBinding, code: string): string {
  return createHmac('sha256', NEXTAUTH_SECRET)
    .update(
      [
        CODE_PURPOSE,
        binding.userId,
        binding.change,
        binding.provider,
        binding.webSessionId,
        code,
      ].join(':')
    )
    .digest('hex');
}

function challengeFilter(challengeId: string) {
  return and(
    eq(magic_link_tokens.challenge_id, challengeId),
    eq(magic_link_tokens.purpose, CODE_PURPOSE)
  );
}

function emailFilter(normalizedEmail: string) {
  return and(
    eq(magic_link_tokens.email, normalizedEmail),
    eq(magic_link_tokens.purpose, CODE_PURPOSE)
  );
}

/** The account's codes whose wrong attempts still count. */
function attemptWindowFilter(normalizedEmail: string) {
  return and(
    emailFilter(normalizedEmail),
    sql`${magic_link_tokens.expires_at} > NOW() - ${ATTEMPT_WINDOW}`
  );
}

/** Serializes code creation and code checks of one account. */
async function lockAccountCodes(tx: DrizzleTransaction, normalizedEmail: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${CODE_PURPOSE}:${normalizedEmail}`}, 0))`
  );
}

async function failedAttempts(tx: DrizzleTransaction, normalizedEmail: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<number>`COALESCE(SUM(${magic_link_tokens.attempts}), 0)::int` })
    .from(magic_link_tokens)
    .where(attemptWindowFilter(normalizedEmail));
  return row?.total ?? 0;
}

export type CreateSignInMethodChangeCodeResult =
  | { status: 'created'; code: string; challengeId: string }
  | { status: 'cooldown' }
  | { status: 'locked' };

/**
 * Makes a new code for the binding. One code is live per account: a new code
 * ends the previous one, whose wrong attempts keep counting. No code is made
 * while the account is locked.
 */
export async function createSignInMethodChangeCode(
  binding: SignInMethodChangeCodeBinding
): Promise<CreateSignInMethodChangeCodeResult> {
  const normalizedEmail = normalizeEmail(binding.email);
  const code = String(randomInt(0, 10 ** SIGN_IN_METHOD_CHANGE_CODE_LENGTH)).padStart(
    SIGN_IN_METHOD_CHANGE_CODE_LENGTH,
    '0'
  );
  const challengeId = randomUUID();

  return db.transaction(async tx => {
    await lockAccountCodes(tx, normalizedEmail);

    if ((await failedAttempts(tx, normalizedEmail)) >= MAX_FAILED_ATTEMPTS) {
      return { status: 'locked' };
    }

    const [recent] = await tx
      .select({ created_at: magic_link_tokens.created_at })
      .from(magic_link_tokens)
      .where(
        and(
          emailFilter(normalizedEmail),
          isNull(magic_link_tokens.consumed_at),
          sql`${magic_link_tokens.expires_at} > NOW()`,
          sql`${magic_link_tokens.created_at} > NOW() - ${RESEND_COOLDOWN}`
        )
      )
      .limit(1);
    if (recent) return { status: 'cooldown' };

    await tx
      .delete(magic_link_tokens)
      .where(
        and(
          emailFilter(normalizedEmail),
          sql`${magic_link_tokens.expires_at} <= NOW() - ${ATTEMPT_WINDOW}`
        )
      );
    await tx
      .update(magic_link_tokens)
      .set({ expires_at: sql`NOW()` })
      .where(and(emailFilter(normalizedEmail), sql`${magic_link_tokens.expires_at} > NOW()`));
    await tx.insert(magic_link_tokens).values({
      token_hash: hashCode(binding, code),
      email: normalizedEmail,
      expires_at: new Date(
        Date.now() + SIGN_IN_METHOD_CHANGE_CODE_EXPIRY_MINUTES * 60 * 1000
      ).toISOString(),
      purpose: CODE_PURPOSE,
      challenge_id: challengeId,
    });

    return { status: 'created', code, challengeId };
  });
}

export type ConsumeSignInMethodChangeCodeResult = 'ok' | 'invalid' | 'locked';

/**
 * Checks the code and uses it. A correct code is used once only. A wrong code,
 * or a code for another user, change, provider or session, spends one of the
 * account's attempts. At the attempt limit the account is locked.
 */
export async function consumeSignInMethodChangeCode(
  binding: SignInMethodChangeCodeBinding,
  code: string,
  challengeId: string
): Promise<ConsumeSignInMethodChangeCodeResult> {
  const tokenHash = hashCode(binding, code);
  const normalizedEmail = normalizeEmail(binding.email);

  return db.transaction(async tx => {
    await lockAccountCodes(tx, normalizedEmail);

    const failures = await failedAttempts(tx, normalizedEmail);
    if (failures >= MAX_FAILED_ATTEMPTS) return 'locked';

    const [row] = await tx
      .select({
        token_hash: magic_link_tokens.token_hash,
        email: magic_link_tokens.email,
        consumed: sql<boolean>`${magic_link_tokens.consumed_at} IS NOT NULL`,
        expired: sql<boolean>`${magic_link_tokens.expires_at} <= NOW()`,
      })
      .from(magic_link_tokens)
      .where(challengeFilter(challengeId))
      .limit(1)
      .for('update');

    // A challenge of another account is not this account's to spend.
    if (!row || row.email !== normalizedEmail || row.consumed || row.expired) return 'invalid';

    if (row.token_hash !== tokenHash) {
      await tx
        .update(magic_link_tokens)
        .set({ attempts: sql`${magic_link_tokens.attempts} + 1` })
        .where(challengeFilter(challengeId));
      if (failures + 1 < MAX_FAILED_ATTEMPTS) return 'invalid';

      await tx
        .update(magic_link_tokens)
        .set({ expires_at: sql`NOW()` })
        .where(attemptWindowFilter(normalizedEmail));
      return 'locked';
    }

    await tx
      .update(magic_link_tokens)
      .set({ consumed_at: sql`NOW()` })
      .where(challengeFilter(challengeId));
    return 'ok';
  });
}

/** Removes a new code when its email could not be sent. */
export async function deleteSignInMethodChangeCode(challengeId: string): Promise<void> {
  await db.delete(magic_link_tokens).where(challengeFilter(challengeId));
}
