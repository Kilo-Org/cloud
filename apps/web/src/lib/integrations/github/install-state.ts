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

type InstallStateUserMismatch = {
  status: 'user_mismatch';
  returnTo: string | null;
  organizationId: string | null;
};

type UnusableInstallState = { status: 'unusable' };

export type InstallStatePreflightResult =
  | { status: 'valid' }
  | InstallStateUserMismatch
  | UnusableInstallState;

export type InstallStateRejectionReason = 'consumed' | 'expired' | 'not_found' | 'unavailable';

export type ConsumeInstallStateResult =
  | { status: 'success'; state: GitHubInstallState }
  | InstallStateUserMismatch
  | { status: 'unusable'; reason: InstallStateRejectionReason };

export async function checkInstallState(
  token: string,
  userId: string
): Promise<InstallStatePreflightResult> {
  const [state] = await db
    .select({
      userId: github_install_states.kilo_user_id,
      ownerType: github_install_states.owner_type,
      ownerId: github_install_states.owner_id,
      returnTo: github_install_states.return_to,
    })
    .from(github_install_states)
    .where(
      and(
        eq(github_install_states.token, token),
        isNull(github_install_states.consumed_at),
        sql`${github_install_states.expires_at} > NOW()`
      )
    )
    .limit(1);

  if (!state) return { status: 'unusable' };
  if (state.userId !== userId) {
    return {
      status: 'user_mismatch',
      returnTo: state.returnTo,
      organizationId: state.ownerType === 'org' ? state.ownerId : null,
    };
  }
  return { status: 'valid' };
}

export async function consumeInstallState(
  token: string,
  userId: string
): Promise<ConsumeInstallStateResult> {
  const result = await db
    .update(github_install_states)
    .set({ consumed_at: sql`NOW()` })
    .where(
      and(
        eq(github_install_states.token, token),
        eq(github_install_states.kilo_user_id, userId),
        isNull(github_install_states.consumed_at),
        sql`${github_install_states.expires_at} > NOW()`
      )
    )
    .returning();

  const state = result[0];
  if (state) return { status: 'success', state };

  const [diagnostic] = await db
    .select({
      userId: github_install_states.kilo_user_id,
      ownerType: github_install_states.owner_type,
      ownerId: github_install_states.owner_id,
      returnTo: github_install_states.return_to,
      consumed: sql<boolean>`${github_install_states.consumed_at} IS NOT NULL`,
      expired: sql<boolean>`${github_install_states.expires_at} <= NOW()`,
    })
    .from(github_install_states)
    .where(eq(github_install_states.token, token))
    .limit(1);

  if (!diagnostic) return { status: 'unusable', reason: 'not_found' };
  if (diagnostic.consumed) return { status: 'unusable', reason: 'consumed' };
  if (diagnostic.expired) return { status: 'unusable', reason: 'expired' };
  if (diagnostic.userId !== userId) {
    return {
      status: 'user_mismatch',
      returnTo: diagnostic.returnTo,
      organizationId: diagnostic.ownerType === 'org' ? diagnostic.ownerId : null,
    };
  }
  return { status: 'unusable', reason: 'unavailable' };
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
