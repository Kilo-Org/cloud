import 'server-only';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'crypto';
import { magic_link_tokens } from '@kilocode/db/schema';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { PASSKEY_ENROLLMENT_CODE_LENGTH } from '@/lib/auth/passkey-enrollment-codes';

/**
 * One-time codes that authorize adding one passkey from a browser session. The
 * code is sent to the account's email address, so a correct code proves that
 * the person controls that mailbox, not only a session cookie.
 *
 * The codes live in `magic_link_tokens` under their own `purpose`, and every
 * query here is purpose-scoped: `/api/auth/native/token` accepts a live
 * `sign_in_code` as a sign-in credential, so these codes must never share it.
 * A row's `email` is the account's address as stored on the user, which is
 * unique per account, so the rows of one address are the rows of one user.
 *
 * Wrong codes are counted per account, across codes. A code row's `expires_at`
 * is the moment the code stops taking guesses: its expiry, its replacement by a
 * newer code, or the lockout. The row's wrong attempts count until the lockout
 * window has passed after that moment, so a new code does not reset the count.
 * When the count reaches the limit, every counted code ends at once, so the
 * lockout lasts the full window from the wrong code that reached the limit.
 */
const CODE_PURPOSE = 'passkey_enrollment';
export const PASSKEY_ENROLLMENT_CODE_EXPIRY_MINUTES = 10;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const RESEND_COOLDOWN_SECONDS = 60;
// Codes sent to one account within the send window, so a held session can not
// flood the mailbox. Codes whose email failed are deleted and do not count.
const MAX_SENDS_PER_WINDOW = 5;
const ATTEMPT_WINDOW = sql.raw(`interval '${LOCKOUT_MINUTES} minutes'`);
const RESEND_COOLDOWN = sql.raw(`interval '${RESEND_COOLDOWN_SECONDS} seconds'`);
const SEND_WINDOW = sql.raw(`interval '1 hour'`);

/** The account and browser session a code is minted for. Any other binding does not match. */
export type PasskeyEnrollmentCodeBinding = {
  userId: string;
  email: string;
  webSessionId: string;
};

/** A code the person entered, with the binding of the request that presents it. */
export type PasskeyEnrollmentEmailCode = {
  binding: PasskeyEnrollmentCodeBinding;
  emailCodeId: string;
  code: string;
};

export type CreatePasskeyEnrollmentCodeResult =
  | { status: 'created'; code: string; emailCodeId: string; expiresInSeconds: number }
  | { status: 'cooldown'; retryAfterSeconds: number }
  | { status: 'hourly_limit'; retryAfterSeconds: number }
  | { status: 'locked'; retryAfterSeconds: number };

/**
 * A refused code. `locked.lockedByThisAttempt` is true for the wrong code that
 * reached the attempt limit, and false while an earlier one keeps the account
 * locked; the audit stores only the first.
 */
export type PasskeyEnrollmentCodeRefusal =
  | { status: 'invalid'; attemptsLeft: number }
  | { status: 'expired' }
  | { status: 'locked'; retryAfterSeconds: number; lockedByThisAttempt: boolean };

export type PasskeyEnrollmentCodeCheck = { status: 'ok' } | PasskeyEnrollmentCodeRefusal;

/** A refused email code. The route maps `refusal` to its error contract. */
export class PasskeyEnrollmentCodeRefusedError extends Error {
  readonly refusal: PasskeyEnrollmentCodeRefusal;

  constructor(refusal: PasskeyEnrollmentCodeRefusal) {
    super(`passkey enrollment code ${refusal.status}`);
    this.name = 'PasskeyEnrollmentCodeRefusedError';
    this.refusal = refusal;
  }
}

/**
 * The hash binds the user and the browser session. It is keyed by the server
 * secret, so a database leak does not let a person test codes offline.
 */
function hashCode(binding: PasskeyEnrollmentCodeBinding, code: string): string {
  return createHmac('sha256', NEXTAUTH_SECRET)
    .update(JSON.stringify([CODE_PURPOSE, binding.userId, binding.webSessionId, code]))
    .digest('hex');
}

function codeHashesMatch(storedHash: string, candidateHash: string): boolean {
  const stored = Buffer.from(storedHash, 'hex');
  const candidate = Buffer.from(candidateHash, 'hex');
  return stored.length === candidate.length && timingSafeEqual(stored, candidate);
}

function codeFilter(emailCodeId: string) {
  return and(
    eq(magic_link_tokens.challenge_id, emailCodeId),
    eq(magic_link_tokens.purpose, CODE_PURPOSE)
  );
}

function accountFilter(email: string) {
  return and(eq(magic_link_tokens.email, email), eq(magic_link_tokens.purpose, CODE_PURPOSE));
}

/** The account's codes whose wrong attempts still count. */
function attemptWindowFilter(email: string) {
  return and(
    accountFilter(email),
    sql`${magic_link_tokens.expires_at} > NOW() - ${ATTEMPT_WINDOW}`
  );
}

async function lockAccountCodes(tx: DrizzleTransaction, userId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${CODE_PURPOSE}:${userId}`}, 0))`
  );
}

async function failedAttempts(tx: DrizzleTransaction, email: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<number>`COALESCE(SUM(${magic_link_tokens.attempts}), 0)::int` })
    .from(magic_link_tokens)
    .where(attemptWindowFilter(email));
  return row?.total ?? 0;
}

/** Seconds until the last counted wrong attempt leaves the window. */
async function lockoutRemainingSeconds(tx: DrizzleTransaction, email: string): Promise<number> {
  const [row] = await tx
    .select({
      seconds: sql<
        number | null
      >`CEIL(EXTRACT(EPOCH FROM (MAX(${magic_link_tokens.expires_at}) + ${ATTEMPT_WINDOW} - NOW())))::int`,
    })
    .from(magic_link_tokens)
    .where(and(attemptWindowFilter(email), gt(magic_link_tokens.attempts, 0)));
  return Math.max(1, row?.seconds ?? LOCKOUT_MINUTES * 60);
}

/**
 * Makes a new code for the binding. One code is live per account: a new code
 * ends the previous one, whose wrong attempts keep counting. No code is made
 * while the account is locked, within the resend cooldown, or once the account
 * has been sent the hourly limit of codes.
 *
 * Rows that count toward neither the lockout nor the hourly limit are removed
 * here, per account, so the table holds only the rows these rules read.
 */
export async function createPasskeyEnrollmentCode(
  binding: PasskeyEnrollmentCodeBinding
): Promise<CreatePasskeyEnrollmentCodeResult> {
  const code = String(randomInt(0, 10 ** PASSKEY_ENROLLMENT_CODE_LENGTH)).padStart(
    PASSKEY_ENROLLMENT_CODE_LENGTH,
    '0'
  );
  const emailCodeId = randomUUID();
  const expiresInSeconds = PASSKEY_ENROLLMENT_CODE_EXPIRY_MINUTES * 60;

  return db.transaction(async tx => {
    await lockAccountCodes(tx, binding.userId);

    await tx
      .delete(magic_link_tokens)
      .where(
        and(
          accountFilter(binding.email),
          sql`${magic_link_tokens.expires_at} <= NOW() - ${ATTEMPT_WINDOW}`,
          sql`${magic_link_tokens.created_at} <= NOW() - ${SEND_WINDOW}`
        )
      );

    if ((await failedAttempts(tx, binding.email)) >= MAX_FAILED_ATTEMPTS) {
      return {
        status: 'locked',
        retryAfterSeconds: await lockoutRemainingSeconds(tx, binding.email),
      };
    }

    const [recent] = await tx
      .select({
        retryAfterSeconds: sql<number>`CEIL(EXTRACT(EPOCH FROM (${magic_link_tokens.created_at} + ${RESEND_COOLDOWN} - NOW())))::int`,
      })
      .from(magic_link_tokens)
      .where(
        and(
          accountFilter(binding.email),
          isNull(magic_link_tokens.consumed_at),
          sql`${magic_link_tokens.created_at} > NOW() - ${RESEND_COOLDOWN}`
        )
      )
      .orderBy(sql`${magic_link_tokens.created_at} DESC`)
      .limit(1);
    if (recent) {
      return { status: 'cooldown', retryAfterSeconds: Math.max(1, recent.retryAfterSeconds) };
    }

    const [sends] = await tx
      .select({
        count: sql<number>`COUNT(*)::int`,
        retryAfterSeconds: sql<
          number | null
        >`CEIL(EXTRACT(EPOCH FROM (MIN(${magic_link_tokens.created_at}) + ${SEND_WINDOW} - NOW())))::int`,
      })
      .from(magic_link_tokens)
      .where(
        and(
          accountFilter(binding.email),
          sql`${magic_link_tokens.created_at} > NOW() - ${SEND_WINDOW}`
        )
      );
    if (sends && sends.count >= MAX_SENDS_PER_WINDOW) {
      return {
        status: 'hourly_limit',
        retryAfterSeconds: Math.max(1, sends.retryAfterSeconds ?? 1),
      };
    }

    await tx
      .update(magic_link_tokens)
      .set({ expires_at: sql`NOW()` })
      .where(and(accountFilter(binding.email), sql`${magic_link_tokens.expires_at} > NOW()`));
    await tx.insert(magic_link_tokens).values({
      token_hash: hashCode(binding, code),
      email: binding.email,
      expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      purpose: CODE_PURPOSE,
      challenge_id: emailCodeId,
    });

    return { status: 'created', code, emailCodeId, expiresInSeconds };
  });
}

/**
 * Checks the code under the account lock. A wrong code, or a code minted for
 * another session, spends one of the account's attempts; at the limit every
 * counted code ends and the account is locked. An unknown, used, expired or
 * replaced code spends nothing.
 */
async function checkCode(
  tx: DrizzleTransaction,
  { binding, emailCodeId, code }: PasskeyEnrollmentEmailCode
): Promise<PasskeyEnrollmentCodeCheck> {
  await lockAccountCodes(tx, binding.userId);

  const failures = await failedAttempts(tx, binding.email);
  if (failures >= MAX_FAILED_ATTEMPTS) {
    return {
      status: 'locked',
      retryAfterSeconds: await lockoutRemainingSeconds(tx, binding.email),
      lockedByThisAttempt: false,
    };
  }

  const [row] = await tx
    .select({
      token_hash: magic_link_tokens.token_hash,
      email: magic_link_tokens.email,
      consumed: sql<boolean>`${magic_link_tokens.consumed_at} IS NOT NULL`,
      expired: sql<boolean>`${magic_link_tokens.expires_at} <= NOW()`,
    })
    .from(magic_link_tokens)
    .where(codeFilter(emailCodeId))
    .limit(1)
    .for('update');

  // A code of another account is not this account's to spend.
  if (!row || row.email !== binding.email || row.consumed || row.expired) {
    return { status: 'expired' };
  }

  if (!codeHashesMatch(row.token_hash, hashCode(binding, code))) {
    await tx
      .update(magic_link_tokens)
      .set({ attempts: sql`${magic_link_tokens.attempts} + 1` })
      .where(codeFilter(emailCodeId));
    if (failures + 1 < MAX_FAILED_ATTEMPTS) {
      return { status: 'invalid', attemptsLeft: MAX_FAILED_ATTEMPTS - failures - 1 };
    }
    await tx
      .update(magic_link_tokens)
      .set({ expires_at: sql`NOW()` })
      .where(attemptWindowFilter(binding.email));
    return { status: 'locked', retryAfterSeconds: LOCKOUT_MINUTES * 60, lockedByThisAttempt: true };
  }

  return { status: 'ok' };
}

/**
 * Checks a code without using it, so a cancelled passkey ceremony can mint
 * options again with the same code. Wrong codes count as attempts.
 */
export async function checkPasskeyEnrollmentCode(
  emailCode: PasskeyEnrollmentEmailCode
): Promise<PasskeyEnrollmentCodeCheck> {
  return db.transaction(tx => checkCode(tx, emailCode));
}

/**
 * Uses the code inside the caller's transaction. The code is spent only when
 * that transaction commits, so a rolled-back enrollment leaves it usable.
 */
export async function consumePasskeyEnrollmentCode(
  tx: DrizzleTransaction,
  emailCode: PasskeyEnrollmentEmailCode
): Promise<PasskeyEnrollmentCodeCheck> {
  const checked = await checkCode(tx, emailCode);
  if (checked.status !== 'ok') return checked;
  await tx
    .update(magic_link_tokens)
    .set({ consumed_at: sql`NOW()` })
    .where(codeFilter(emailCode.emailCodeId));
  return checked;
}

/** Removes a new code whose email was definitely not sent. */
export async function deletePasskeyEnrollmentCode(emailCodeId: string): Promise<void> {
  await db.delete(magic_link_tokens).where(codeFilter(emailCodeId));
}

/**
 * Ends a new code whose send failed without a verdict. The row stays, so it
 * still counts toward the resend cooldown and the hourly limit.
 */
export async function expirePasskeyEnrollmentCode(emailCodeId: string): Promise<void> {
  await db
    .update(magic_link_tokens)
    .set({ expires_at: sql`NOW()` })
    .where(codeFilter(emailCodeId));
}
