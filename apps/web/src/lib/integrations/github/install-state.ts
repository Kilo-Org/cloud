import 'server-only';
import crypto from 'node:crypto';
import { db } from '@/lib/drizzle';
import { sql, eq, and, isNull } from 'drizzle-orm';
import { github_install_states, type GitHubInstallState } from '@kilocode/db/schema';
import { validateReturnPath } from '@/lib/integrations/validate-return-path';

const STATE_TTL_MINUTES = 10;

export type CreateInstallStateParams = {
  kiloUserId: string;
  ownerType: 'org' | 'user';
  ownerId: string;
  githubAppType: string;
  returnTo?: string | null;
};

/**
 * Creates a one-time GitHub install state token.
 * The token is 32 random bytes, base64url-encoded.
 * The row expires after 10 minutes.
 */
export async function createInstallState(params: CreateInstallStateParams): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + STATE_TTL_MINUTES * 60 * 1000).toISOString();

  const validatedReturnTo = params.returnTo ? validateReturnPath(params.returnTo) : null;

  await db.insert(github_install_states).values({
    token,
    kilo_user_id: params.kiloUserId,
    owner_type: params.ownerType,
    owner_id: params.ownerId,
    github_app_type: params.githubAppType,
    return_to: validatedReturnTo,
    expires_at: expiresAt,
  });

  return token;
}

/**
 * Atomically consumes a GitHub install state token.
 * A single UPDATE ... WHERE consumed_at IS NULL AND expires_at > NOW() RETURNING *.
 * Returns null if the token is already consumed, expired, or unknown.
 */
export async function consumeInstallState(token: string): Promise<GitHubInstallState | null> {
  const result = await db
    .update(github_install_states)
    .set({ consumed_at: sql`NOW()` })
    .where(
      and(
        eq(github_install_states.token, token),
        isNull(github_install_states.consumed_at),
        sql`${github_install_states.expires_at} > NOW()`
      )
    )
    .returning();

  return result[0] ?? null;
}

/**
 * Deletes install state rows whose expires_at has passed.
 * Returns the count of deleted rows.
 */
export async function cleanupExpiredInstallStates(): Promise<number> {
  const result = await db
    .delete(github_install_states)
    .where(sql`${github_install_states.expires_at} <= NOW()`);

  return result.rowCount ?? 0;
}
