import 'server-only';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { createHmac, randomInt, randomUUID } from 'crypto';
import { magic_link_tokens } from '@kilocode/db/schema';
import type { AuthProviderId } from '@kilocode/db/schema-types';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { normalizeEmail } from '@kilocode/web-shared/lib/email-address';
import { SIGN_IN_METHOD_CHANGE_CODE_LENGTH } from '@/lib/auth/sign-in-method-change-codes';
import type { SignInMethodChange } from '@/lib/auth/sign-in-method-change';

/**
 * One-time codes that authorize one sign-in method link or unlink. The code is
 * sent to the account's primary email address, so a correct code proves that
 * the person controls that mailbox, not only a session cookie.
 *
 * The codes live in `magic_link_tokens` under their own `purpose`, and every
 * query here is purpose-scoped: `/api/auth/native/token` accepts a live
 * `sign_in_code` as a sign-in credential, so these codes must never share it.
 */
const CODE_PURPOSE = 'sign_in_method_change';
export const SIGN_IN_METHOD_CHANGE_CODE_EXPIRY_MINUTES = 10;
const CODE_MAX_ATTEMPTS = 5;
// Minimum gap between two code emails, so a held session can not flood the mailbox.
const RESEND_COOLDOWN_SECONDS = 60;
// After the attempt limit, no new code is sent for this time.
export const SIGN_IN_METHOD_CHANGE_CODE_LOCKOUT_MINUTES = 15;

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

export type CreateSignInMethodChangeCodeResult =
  | { status: 'created'; code: string; challengeId: string }
  | { status: 'cooldown' }
  | { status: 'locked' };

/**
 * Makes a new code for the binding. One code is live per account: a new code
 * removes the previous one. A code that reached the attempt limit stays until
 * the lockout ends, so a new code can not reset the attempt limit.
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
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${CODE_PURPOSE}:${normalizedEmail}`}, 0))`
    );

    const [locked] = await tx
      .select({ created_at: magic_link_tokens.created_at })
      .from(magic_link_tokens)
      .where(
        and(
          emailFilter(normalizedEmail),
          gte(magic_link_tokens.attempts, CODE_MAX_ATTEMPTS),
          sql`${magic_link_tokens.created_at} > NOW() - interval '${sql.raw(String(SIGN_IN_METHOD_CHANGE_CODE_LOCKOUT_MINUTES))} minutes'`
        )
      )
      .limit(1);
    if (locked) return { status: 'locked' };

    const [recent] = await tx
      .select({ created_at: magic_link_tokens.created_at })
      .from(magic_link_tokens)
      .where(
        and(
          emailFilter(normalizedEmail),
          isNull(magic_link_tokens.consumed_at),
          sql`${magic_link_tokens.expires_at} > NOW()`,
          sql`${magic_link_tokens.created_at} > NOW() - interval '${sql.raw(String(RESEND_COOLDOWN_SECONDS))} seconds'`
        )
      )
      .limit(1);
    if (recent) return { status: 'cooldown' };

    await tx.delete(magic_link_tokens).where(emailFilter(normalizedEmail));
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
 * or a code for another user, change, provider or session, spends one
 * attempt. At the attempt limit the code is locked.
 */
export async function consumeSignInMethodChangeCode(
  binding: SignInMethodChangeCodeBinding,
  code: string,
  challengeId: string
): Promise<ConsumeSignInMethodChangeCodeResult> {
  const tokenHash = hashCode(binding, code);
  const normalizedEmail = normalizeEmail(binding.email);

  return db.transaction(async tx => {
    const [row] = await tx
      .select({
        token_hash: magic_link_tokens.token_hash,
        email: magic_link_tokens.email,
        attempts: magic_link_tokens.attempts,
        consumed: sql<boolean>`${magic_link_tokens.consumed_at} IS NOT NULL`,
        expired: sql<boolean>`${magic_link_tokens.expires_at} <= NOW()`,
      })
      .from(magic_link_tokens)
      .where(challengeFilter(challengeId))
      .limit(1)
      .for('update');

    // A challenge of another account is not this account's to spend.
    if (!row || row.email !== normalizedEmail || row.consumed || row.expired) return 'invalid';
    if (row.attempts >= CODE_MAX_ATTEMPTS) return 'locked';

    if (row.token_hash !== tokenHash) {
      await tx
        .update(magic_link_tokens)
        .set({ attempts: sql`${magic_link_tokens.attempts} + 1` })
        .where(challengeFilter(challengeId));
      return row.attempts + 1 >= CODE_MAX_ATTEMPTS ? 'locked' : 'invalid';
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

export const __test__ = { CODE_PURPOSE, CODE_MAX_ATTEMPTS, RESEND_COOLDOWN_SECONDS, hashCode };
