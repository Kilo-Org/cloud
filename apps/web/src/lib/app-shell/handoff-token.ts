import 'server-only';
import crypto from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { app_shell_handoff_tokens, kilocode_users } from '@kilocode/db/schema';
import { isAppShellPath } from './shell-paths';

/**
 * Two minutes is long enough for the app to hand the URL to the in-app browser
 * immediately after minting it, and short enough that a leaked URL is worthless
 * by the time anyone could use it.
 */
export const APP_SHELL_HANDOFF_TTL_SECONDS = 120;

/**
 * Mints the one-time token the native app puts in the hand-off URL. The target
 * path is stored with the token, so the consuming request cannot choose where
 * the shell opens.
 *
 * `webSessionPepper` is the pepper of the account row the caller authenticated
 * with. The token is good only while the account still has that pepper, so a
 * session revocation between mint and consume leaves it unusable.
 */
export async function createAppShellHandoff(params: {
  userId: string;
  targetPath: string;
  webSessionPepper: string | null;
}): Promise<string> {
  if (!isAppShellPath(params.targetPath)) {
    throw new Error(`Refusing to mint an app-shell hand-off for ${params.targetPath}`);
  }

  const token = crypto.randomBytes(32).toString('base64url');
  await db.insert(app_shell_handoff_tokens).values({
    token_hash: crypto.createHash('sha256').update(token).digest('hex'),
    kilo_user_id: params.userId,
    target_path: params.targetPath,
    web_session_pepper: params.webSessionPepper,
    expires_at: new Date(Date.now() + APP_SHELL_HANDOFF_TTL_SECONDS * 1000).toISOString(),
  });

  return token;
}

export type ConsumedAppShellHandoff = {
  userId: string;
  targetPath: string;
  /** The account's `web_session_pepper`, unchanged since the mint. */
  webSessionPepper: string | null;
};

/**
 * Deletes the hand-off rows no request can use again: ones a browser already
 * consumed, and ones whose two-minute window has passed. The mint-then-consume
 * flow adds a row per hand-off, so the sweep runs with the other credential
 * cleanup jobs; a consumed row is dead the moment it is spent, and keeping it
 * would only serve an audit the token digest cannot support.
 */
export async function cleanupExpiredAppShellHandoffTokens(): Promise<number> {
  const result = await db
    .delete(app_shell_handoff_tokens)
    .where(
      sql`${app_shell_handoff_tokens.expires_at} <= NOW() OR ${app_shell_handoff_tokens.consumed_at} IS NOT NULL`
    );

  return result.rowCount ?? 0;
}

/**
 * Consumes the token in one conditional update, so a replay — including two
 * requests racing on the same token — gets a result exactly once.
 *
 * The same statement requires the account's current web-session pepper to be
 * the one the token was minted under, so the shell session the caller mints is
 * bound to a pepper no revocation has replaced. A revocation that commits
 * before this statement makes it match nothing; one that commits after it
 * rotates the pepper the minted session is bound to, which ends that session.
 */
export async function consumeAppShellHandoff(
  token: string
): Promise<ConsumedAppShellHandoff | null> {
  if (!token) return null;

  const accountPepper = db
    .select({ pepper: kilocode_users.web_session_pepper })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, app_shell_handoff_tokens.kilo_user_id));

  const [row] = await db
    .update(app_shell_handoff_tokens)
    .set({ consumed_at: sql`NOW()` })
    .where(
      and(
        eq(
          app_shell_handoff_tokens.token_hash,
          crypto.createHash('sha256').update(token).digest('hex')
        ),
        isNull(app_shell_handoff_tokens.consumed_at),
        sql`${app_shell_handoff_tokens.expires_at} > NOW()`,
        sql`${app_shell_handoff_tokens.web_session_pepper} IS NOT DISTINCT FROM (${accountPepper})`
      )
    )
    .returning({
      userId: app_shell_handoff_tokens.kilo_user_id,
      targetPath: app_shell_handoff_tokens.target_path,
      webSessionPepper: app_shell_handoff_tokens.web_session_pepper,
    });

  if (!row) return null;
  // A row that is not a shell path cannot be opened as one; the credential is
  // already spent, so the caller reports it as unusable rather than redirecting.
  if (!isAppShellPath(row.targetPath)) return null;

  return {
    userId: row.userId,
    targetPath: row.targetPath,
    webSessionPepper: row.webSessionPepper,
  };
}
