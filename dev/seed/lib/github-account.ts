import { kilocode_users, user_github_app_tokens } from '@kilocode/db/schema';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';

import { getSeedDb } from './db';

export type GitHubAccountStatus = {
  userId: string;
  email: string;
  authorizationId: string;
  githubLogin: string;
  connected: boolean;
  revoked: boolean;
};

const STANDARD_APP = 'standard' as const;

export function noDonorAvailableError(): Error {
  return new Error(
    'no donor available: no live GitHub user authorization in this database. Connect GitHub once in the local web app, then re-run.'
  );
}

export function donorRevokedError(githubLogin: string, reason: string | null): Error {
  const suffix = reason ? ` reason=${reason}` : '';
  return new Error(
    `donor revoked: githubLogin=${githubLogin}${suffix}. Reconnect that GitHub account in the local web app.`
  );
}

export function verificationFailedError(status: { connected: boolean; revoked: boolean }): Error {
  return new Error(
    `verification failed: expected connected=true revoked=false, got connected=${status.connected} revoked=${status.revoked}.`
  );
}

export async function readGitHubUserAuthorizationStatus(
  kiloUserId: string
): Promise<{ connected: boolean; githubLogin: string | null; revoked: boolean }> {
  const db = getSeedDb();
  const [authorization] = await db
    .select({
      githubLogin: user_github_app_tokens.github_login,
      revokedAt: user_github_app_tokens.revoked_at,
    })
    .from(user_github_app_tokens)
    .where(
      and(
        eq(user_github_app_tokens.kilo_user_id, kiloUserId),
        eq(user_github_app_tokens.github_app_type, STANDARD_APP)
      )
    )
    .limit(1);

  return authorization
    ? {
        connected: authorization.revokedAt === null,
        githubLogin: authorization.githubLogin,
        revoked: authorization.revokedAt !== null,
      }
    : { connected: false, githubLogin: null, revoked: false };
}

export async function findLiveGitHubDonor(userId?: string): Promise<GitHubAccountStatus | null> {
  const db = getSeedDb();
  const filters = [
    eq(user_github_app_tokens.github_app_type, STANDARD_APP),
    isNull(user_github_app_tokens.revoked_at),
  ];
  if (userId) {
    filters.push(eq(user_github_app_tokens.kilo_user_id, userId));
  }
  const [row] = await db
    .select({
      userId: kilocode_users.id,
      email: kilocode_users.google_user_email,
      authorizationId: user_github_app_tokens.id,
      githubLogin: user_github_app_tokens.github_login,
    })
    .from(user_github_app_tokens)
    .innerJoin(kilocode_users, eq(kilocode_users.id, user_github_app_tokens.kilo_user_id))
    .where(and(...filters))
    .limit(1);

  if (!row) {
    return null;
  }
  return {
    userId: row.userId,
    email: row.email,
    authorizationId: row.authorizationId,
    githubLogin: row.githubLogin,
    connected: true,
    revoked: false,
  };
}

export async function findRevokedGitHubDonor(userId?: string): Promise<{
  githubLogin: string;
  reason: string | null;
} | null> {
  const db = getSeedDb();
  const filters = [
    eq(user_github_app_tokens.github_app_type, STANDARD_APP),
    isNotNull(user_github_app_tokens.revoked_at),
  ];
  if (userId) {
    filters.push(eq(user_github_app_tokens.kilo_user_id, userId));
  }
  const [row] = await db
    .select({
      githubLogin: user_github_app_tokens.github_login,
      reason: user_github_app_tokens.revocation_reason,
    })
    .from(user_github_app_tokens)
    .where(and(...filters))
    .limit(1);
  return row ?? null;
}

export async function verifyLiveGitHubAuthorization(userId: string): Promise<{
  connected: boolean;
  githubLogin: string | null;
  revoked: boolean;
}> {
  const status = await readGitHubUserAuthorizationStatus(userId);
  if (!status.connected || status.revoked) {
    throw verificationFailedError(status);
  }
  return status;
}
