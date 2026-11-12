import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { WorkerDb } from './client';
import { kilocode_users, user_github_app_tokens } from './schema';
import { isGoneOrDeletingBlockedReason } from './user-soft-delete-reasons';

export const GitHubIdentityPreconditionSchema = z
  .object({
    authorizationId: z.string().uuid().nullable(),
    credentialVersion: z.number().int().positive().nullable(),
  })
  .strict()
  .refine(value => (value.authorizationId === null) === (value.credentialVersion === null));

export type GitHubIdentityPrecondition = z.infer<typeof GitHubIdentityPreconditionSchema>;
export type GitHubIdentityTransaction = Parameters<Parameters<WorkerDb['transaction']>[0]>[0];

export class GitHubIdentityConflictError extends Error {
  constructor() {
    super('github_identity_conflict');
  }
}

/** A provided token with a known expiry in the past cannot authenticate. */
export function isExpiredProvidedToken(
  credentialSource: 'github_app' | 'provided_token' | null,
  expiresAt: string | null
): boolean {
  return (
    credentialSource === 'provided_token' &&
    expiresAt !== null &&
    new Date(expiresAt).getTime() <= Date.now()
  );
}

/**
 * Serializes identity writers and account cleanup for one Kilo user.
 *
 * Writers hold this lock across GitHub requests, so it is an advisory lock and
 * never a row lock on kilocode_users. Take it before any row lock on the user.
 */
export async function lockGitHubIdentityWrites(tx: GitHubIdentityTransaction, userId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`github-identity:${userId}`}))`);
}

/** All identity writers call this before the provider grant lock. */
export async function lockGitHubIdentity(
  tx: GitHubIdentityTransaction,
  userId: string,
  expected: GitHubIdentityPrecondition
) {
  await lockGitHubIdentityWrites(tx, userId);
  const [user] = await tx
    .select({
      blockedReason: kilocode_users.blocked_reason,
      deletionRequestedAt: kilocode_users.account_deletion_requested_at,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);
  if (!user || isGoneOrDeletingBlockedReason(user.blockedReason) || user.deletionRequestedAt) {
    throw new GitHubIdentityConflictError();
  }
  const [authorization] = await tx
    .select()
    .from(user_github_app_tokens)
    .where(
      and(
        eq(user_github_app_tokens.kilo_user_id, userId),
        eq(user_github_app_tokens.github_app_type, 'standard')
      )
    )
    .limit(1);
  if (
    (authorization?.id ?? null) !== expected.authorizationId ||
    (authorization?.credential_version ?? null) !== expected.credentialVersion
  ) {
    throw new GitHubIdentityConflictError();
  }
  return authorization;
}

export async function lockGitHubGrant(tx: GitHubIdentityTransaction, githubUserId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`github-user-authorization:standard:${githubUserId}`}))`
  );
}
