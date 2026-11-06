import type { WorkerDb } from '@kilocode/db/client';
import { oauth_refresh_exchange_leases } from '@kilocode/db/schema';
import { and, eq, isNotNull, sql } from 'drizzle-orm';

/** The transaction handle this service's Drizzle client hands to a callback. */
export type RefreshLeaseTransaction = Parameters<Parameters<WorkerDb['transaction']>[0]>[0];

/**
 * Which credential row a refresh exchange belongs to. GitLab and Bitbucket
 * refresh `platform_oauth_credentials`; GitHub user authorization refreshes
 * `user_github_app_tokens`.
 */
export type RefreshLeaseScope =
  | { kind: 'platform-oauth-credential'; credentialId: string }
  | { kind: 'user-github-app-token'; credentialId: string };

/**
 * Extra time a lease outlives its holder's provider request budget, so a slow
 * but still-running exchange never overlaps a takeover.
 */
export const REFRESH_LEASE_SETTLE_MS = 5_000;

export function newRefreshLeaseAttemptId(): string {
  return crypto.randomUUID();
}

function leaseExpiry(leaseMs: number) {
  return sql`now() + (${leaseMs}::int * interval '1 millisecond')`;
}

/**
 * Claims the credential's provider exchange lease.
 *
 * Succeeds only when no other attempt holds a live lease; a taken-over lease is
 * the only row the statement may overwrite. Both the expiry it writes and the
 * takeover predicate use the database clock, so worker clock skew cannot make a
 * stale attempt look live.
 */
export async function claimRefreshLease(
  tx: RefreshLeaseTransaction,
  input: RefreshLeaseScope & { attemptId: string; providerRequestBudgetMs: number }
): Promise<boolean> {
  const leaseMs = input.providerRequestBudgetMs + REFRESH_LEASE_SETTLE_MS;
  const owned =
    input.kind === 'platform-oauth-credential'
      ? { platform_oauth_credential_id: input.credentialId }
      : { user_github_app_token_id: input.credentialId };
  const uniqueColumn =
    input.kind === 'platform-oauth-credential'
      ? oauth_refresh_exchange_leases.platform_oauth_credential_id
      : oauth_refresh_exchange_leases.user_github_app_token_id;
  const [claimed] = await tx
    .insert(oauth_refresh_exchange_leases)
    .values({
      ...owned,
      attempt_id: input.attemptId,
      expires_at: leaseExpiry(leaseMs),
    })
    .onConflictDoUpdate({
      target: uniqueColumn,
      targetWhere: isNotNull(uniqueColumn),
      set: { attempt_id: input.attemptId, expires_at: leaseExpiry(leaseMs) },
      setWhere: sql`${oauth_refresh_exchange_leases.expires_at} <= now()`,
    })
    .returning({ attemptId: oauth_refresh_exchange_leases.attempt_id });
  return claimed?.attemptId === input.attemptId;
}

/**
 * Releases the lease and reports whether this attempt still held it.
 *
 * A `false` result means the lease expired mid-exchange and another attempt may
 * own the credential's provider exchange, so this attempt's provider answer
 * cannot be used to revoke or overwrite anything.
 */
export async function releaseRefreshLease(
  tx: RefreshLeaseTransaction,
  input: RefreshLeaseScope & { attemptId: string }
): Promise<boolean> {
  const ownerCondition =
    input.kind === 'platform-oauth-credential'
      ? eq(oauth_refresh_exchange_leases.platform_oauth_credential_id, input.credentialId)
      : eq(oauth_refresh_exchange_leases.user_github_app_token_id, input.credentialId);
  const released = await tx
    .delete(oauth_refresh_exchange_leases)
    .where(and(ownerCondition, eq(oauth_refresh_exchange_leases.attempt_id, input.attemptId)))
    .returning({ id: oauth_refresh_exchange_leases.id });
  return released.length > 0;
}
