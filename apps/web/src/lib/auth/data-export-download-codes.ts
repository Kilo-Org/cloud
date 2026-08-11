import 'server-only';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { magic_link_tokens } from '@kilocode/db/schema';
import { randomInt, randomUUID, createHmac } from 'crypto';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { normalizeEmail } from '@/lib/utils';

/**
 * Step-up codes that authorize a single data-export download URL.
 *
 * These live in `magic_link_tokens` alongside sign-in codes but under their own
 * `purpose`, and every query here is purpose-scoped. That separation is load
 * bearing: `/api/auth/native/token` accepts any live `sign_in_code` for an email
 * as a full sign-in credential, so a download code sharing that purpose would be
 * redeemable for a session.
 */
const DOWNLOAD_CODE_PURPOSE = 'data_export_download';
export const DOWNLOAD_CODE_EXPIRY_MINUTES = 10;
const CODE_MAX_ATTEMPTS = 5;
// Reservations expire on their own — no cleanup job is needed.
const CODE_RESERVATION_MINUTES = 2;
// Minimum gap between emails so a held session cannot be used to mail-bomb the owner.
const RESEND_COOLDOWN_SECONDS = 60;

/**
 * Binds the code to both the account and the specific export, so a code minted
 * for one export cannot authorize another. Keyed by the server secret so a
 * database leak does not permit offline enumeration of the six-digit space.
 */
function hashDownloadCode(email: string, exportId: string, code: string): string {
  return createHmac('sha256', NEXTAUTH_SECRET)
    .update(`${DOWNLOAD_CODE_PURPOSE}:${email}:${exportId}:${code}`)
    .digest('hex');
}

function liveCodeForChallenge(challengeId: string) {
  return and(
    eq(magic_link_tokens.challenge_id, challengeId),
    eq(magic_link_tokens.purpose, DOWNLOAD_CODE_PURPOSE),
    isNull(magic_link_tokens.consumed_at),
    sql`${magic_link_tokens.expires_at} > NOW()`
  );
}

export type CreateDownloadCodeResult =
  | { status: 'created'; code: string; challengeId: string }
  | { status: 'cooldown' };

/**
 * Mint a 6-digit code authorizing one download of `exportId`.
 *
 * Only one live download code exists per account at a time: prior rows for the
 * email are removed, including consumed ones, so a recycled code can never
 * collide with a retired row on the `token_hash` primary key.
 */
export async function createDataExportDownloadCode(
  email: string,
  exportId: string
): Promise<CreateDownloadCodeResult> {
  const normalizedEmail = normalizeEmail(email);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const challengeId = randomUUID();

  return db.transaction(async tx => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${DOWNLOAD_CODE_PURPOSE}:${normalizedEmail}`}, 0))`
    );

    const [recent] = await tx
      .select({ created_at: magic_link_tokens.created_at })
      .from(magic_link_tokens)
      .where(
        and(
          eq(magic_link_tokens.email, normalizedEmail),
          eq(magic_link_tokens.purpose, DOWNLOAD_CODE_PURPOSE),
          isNull(magic_link_tokens.consumed_at),
          sql`${magic_link_tokens.expires_at} > NOW()`,
          sql`${magic_link_tokens.created_at} > NOW() - interval '${sql.raw(String(RESEND_COOLDOWN_SECONDS))} seconds'`
        )
      )
      .limit(1);
    if (recent) return { status: 'cooldown' };

    await tx
      .delete(magic_link_tokens)
      .where(
        and(
          eq(magic_link_tokens.email, normalizedEmail),
          eq(magic_link_tokens.purpose, DOWNLOAD_CODE_PURPOSE)
        )
      );
    await tx.insert(magic_link_tokens).values({
      token_hash: hashDownloadCode(normalizedEmail, exportId, code),
      email: normalizedEmail,
      expires_at: new Date(Date.now() + DOWNLOAD_CODE_EXPIRY_MINUTES * 60 * 1000).toISOString(),
      purpose: DOWNLOAD_CODE_PURPOSE,
      challenge_id: challengeId,
    });

    return { status: 'created', code, challengeId };
  });
}

export type ReserveDownloadCodeResult = 'ok' | 'invalid' | 'too_many_attempts' | 'in_progress';

/**
 * Reserve a download code before minting the download URL. Does not consume it.
 * A live reservation blocks a concurrent caller, which receives 'in_progress'.
 *
 * A wrong code spends one attempt from the challenge's own budget, so guesses
 * against one challenge cannot drain another's.
 */
export async function reserveDataExportDownloadCode(
  email: string,
  exportId: string,
  code: string,
  challengeId: string
): Promise<ReserveDownloadCodeResult> {
  const normalizedEmail = normalizeEmail(email);

  const [row] = await db
    .select()
    .from(magic_link_tokens)
    .where(liveCodeForChallenge(challengeId))
    .limit(1);
  if (!row) return 'invalid';
  if (row.attempts >= CODE_MAX_ATTEMPTS) return 'too_many_attempts';

  const token_hash = hashDownloadCode(normalizedEmail, exportId, code);
  if (row.token_hash !== token_hash) {
    await db
      .update(magic_link_tokens)
      .set({ attempts: sql`${magic_link_tokens.attempts} + 1` })
      .where(
        and(
          liveCodeForChallenge(challengeId),
          sql`${magic_link_tokens.attempts} < ${CODE_MAX_ATTEMPTS}`
        )
      );
    return 'invalid';
  }

  const reserved = await db
    .update(magic_link_tokens)
    .set({
      reserved_until: sql`NOW() + interval '${sql.raw(String(CODE_RESERVATION_MINUTES))} minutes'`,
    })
    .where(
      and(
        liveCodeForChallenge(challengeId),
        sql`${magic_link_tokens.attempts} < ${CODE_MAX_ATTEMPTS}`,
        sql`(${magic_link_tokens.reserved_until} IS NULL OR ${magic_link_tokens.reserved_until} < NOW())`
      )
    )
    .returning();
  if (reserved[0]) return 'ok';

  // The row was live a moment ago, so losing the update means another caller
  // holds the reservation, or it was consumed or expired in between.
  const [current] = await db
    .select({
      attempts: magic_link_tokens.attempts,
      reserved_until: magic_link_tokens.reserved_until,
      consumed_at: magic_link_tokens.consumed_at,
    })
    .from(magic_link_tokens)
    .where(
      and(
        eq(magic_link_tokens.challenge_id, challengeId),
        eq(magic_link_tokens.purpose, DOWNLOAD_CODE_PURPOSE)
      )
    )
    .limit(1);
  if (!current || current.consumed_at) return 'invalid';
  if (current.attempts >= CODE_MAX_ATTEMPTS) return 'too_many_attempts';
  if (current.reserved_until && new Date(current.reserved_until) > new Date()) {
    return 'in_progress';
  }
  return 'invalid';
}

/**
 * Consume a download code once its download URL has been minted, regardless of
 * whether the reservation is still live. The URL is a bearer capability the
 * moment it exists, so the code must not survive to mint a second one.
 */
export async function consumeDataExportDownloadCode(challengeId: string): Promise<void> {
  await db
    .update(magic_link_tokens)
    .set({ consumed_at: sql`NOW()`, reserved_until: null })
    .where(
      and(
        eq(magic_link_tokens.challenge_id, challengeId),
        eq(magic_link_tokens.purpose, DOWNLOAD_CODE_PURPOSE),
        isNull(magic_link_tokens.consumed_at)
      )
    );
}

/**
 * Release a reservation without consuming the code or spending an attempt.
 * A failure to mint the URL is not a wrong guess.
 */
export async function releaseDataExportDownloadCode(challengeId: string): Promise<void> {
  await db
    .update(magic_link_tokens)
    .set({ reserved_until: null })
    .where(
      and(
        eq(magic_link_tokens.challenge_id, challengeId),
        eq(magic_link_tokens.purpose, DOWNLOAD_CODE_PURPOSE),
        isNull(magic_link_tokens.consumed_at)
      )
    );
}

/** Drop a freshly minted code when its email could not be delivered. */
export async function deleteDataExportDownloadCode(challengeId: string): Promise<void> {
  await db
    .delete(magic_link_tokens)
    .where(
      and(
        eq(magic_link_tokens.challenge_id, challengeId),
        eq(magic_link_tokens.purpose, DOWNLOAD_CODE_PURPOSE)
      )
    );
}

export const __test__ = {
  DOWNLOAD_CODE_PURPOSE,
  CODE_MAX_ATTEMPTS,
  RESEND_COOLDOWN_SECONDS,
  hashDownloadCode,
};
