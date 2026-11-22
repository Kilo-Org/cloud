import 'server-only';

import { captureException } from '@sentry/nextjs';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { github_connection_attempts } from '@kilocode/db/schema';
import type { Owner } from '@/lib/integrations/core/types';
import {
  connectVerifiedGitHubInstallation,
  logGitHubWorkflowRoleTransfers,
} from '@/lib/integrations/db/github-installations';
import {
  fetchGitHubInstallationDetails,
  fetchGitHubRepositoriesForMaintenance,
} from '@/lib/integrations/platforms/github/adapter';
import type { GitHubAppType } from '@/lib/integrations/platforms/github/app-selector';
import type { GitHubInstallationCandidate } from './installation-authorization';

const candidatesSchema: z.ZodType<GitHubInstallationCandidate[]> = z.array(
  z.object({
    installationId: z.string(),
    accountId: z.string(),
    accountLogin: z.string(),
    accountType: z.enum(['Organization', 'User']),
  })
);

/**
 * Returns the stored candidate that is identical to the submitted one in all
 * four fields, and only when its installation id is canonical. Both the
 * pre-provider check and the locked in-transaction check use this helper so
 * they cannot drift apart.
 */
function matchStoredCandidate(
  stored: unknown,
  submitted: GitHubInstallationCandidate
): GitHubInstallationCandidate | null {
  const parsed = candidatesSchema.safeParse(stored);
  if (!parsed.success) return null;
  const matched = parsed.data.find(
    candidate =>
      candidate.installationId === submitted.installationId &&
      candidate.accountId === submitted.accountId &&
      candidate.accountLogin === submitted.accountLogin &&
      candidate.accountType === submitted.accountType
  );
  if (!matched || !/^[1-9][0-9]*$/.test(matched.installationId)) return null;
  return matched;
}

export async function createGitHubConnectionAttempt(input: {
  kiloUserId: string;
  owner: Owner;
  githubAppType: GitHubAppType;
  returnTo: string | null;
}) {
  const [attempt] = await db
    .insert(github_connection_attempts)
    .values({
      kilo_user_id: input.kiloUserId,
      owner_type: input.owner.type,
      owner_id: input.owner.id,
      github_app_type: input.githubAppType,
      return_to: input.returnTo,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    })
    .returning({ id: github_connection_attempts.id });
  if (!attempt) throw new Error('Unable to create GitHub connection attempt');
  return attempt.id;
}

export async function recordGitHubConnectionDiscovery(input: {
  attemptId: string;
  userId: string;
  githubUserId: string;
  candidates: GitHubInstallationCandidate[];
}) {
  const [attempt] = await db
    .update(github_connection_attempts)
    .set({ github_user_id: input.githubUserId, eligible_installations: input.candidates })
    .where(
      and(
        eq(github_connection_attempts.id, input.attemptId),
        eq(github_connection_attempts.kilo_user_id, input.userId),
        isNull(github_connection_attempts.consumed_at),
        sql`${github_connection_attempts.expires_at} > NOW()`
      )
    )
    .returning();
  return attempt ?? null;
}

export async function selectGitHubConnectionInstallation(input: {
  attemptId: string;
  userId: string;
  installationId: string;
}) {
  const [attempt] = await db
    .select()
    .from(github_connection_attempts)
    .where(
      and(
        eq(github_connection_attempts.id, input.attemptId),
        eq(github_connection_attempts.kilo_user_id, input.userId),
        isNull(github_connection_attempts.consumed_at),
        sql`${github_connection_attempts.expires_at} > NOW()`
      )
    )
    .limit(1);
  if (!attempt) return null;
  const parsed = candidatesSchema.safeParse(attempt.eligible_installations);
  if (
    !parsed.success ||
    !parsed.data.some(candidate => candidate.installationId === input.installationId)
  )
    return null;
  const [selected] = await db
    .update(github_connection_attempts)
    .set({ selected_installation_id: input.installationId })
    .where(
      and(
        eq(github_connection_attempts.id, attempt.id),
        eq(github_connection_attempts.kilo_user_id, input.userId),
        or(
          isNull(github_connection_attempts.selected_installation_id),
          eq(github_connection_attempts.selected_installation_id, input.installationId)
        ),
        isNull(github_connection_attempts.consumed_at),
        sql`${github_connection_attempts.expires_at} > NOW()`
      )
    )
    .returning();
  return selected ?? null;
}

export async function getGitHubConnectionAttempt(attemptId: string, userId: string) {
  const [attempt] = await db
    .select()
    .from(github_connection_attempts)
    .where(
      and(
        eq(github_connection_attempts.id, attemptId),
        eq(github_connection_attempts.kilo_user_id, userId),
        isNull(github_connection_attempts.consumed_at),
        sql`${github_connection_attempts.expires_at} > NOW()`
      )
    )
    .limit(1);
  if (!attempt) return null;
  const candidates = candidatesSchema.safeParse(attempt.eligible_installations);
  return candidates.success
    ? { ownerId: attempt.owner_id, ownerType: attempt.owner_type, candidates: candidates.data }
    : null;
}

export async function completeGitHubConnectionAttempt(input: {
  attemptId: string;
  userId: string;
  githubUserId: string;
  candidate: GitHubInstallationCandidate;
  authorizeOwner: (owner: Owner) => Promise<void>;
}) {
  // Read scoped to this caller's own attempt, but deliberately without the
  // consumed/expiry predicates used by the picker reads: the documented
  // idempotent replay below runs against an already-consumed row that carries
  // `completed_integration_id`, and Postgres must not hide it from us.
  const [initialAttempt] = await db
    .select()
    .from(github_connection_attempts)
    .where(
      and(
        eq(github_connection_attempts.id, input.attemptId),
        eq(github_connection_attempts.kilo_user_id, input.userId),
        eq(github_connection_attempts.github_user_id, input.githubUserId)
      )
    )
    .limit(1);
  if (!initialAttempt) return { ok: false as const, reason: 'installation_unavailable' as const };
  if (
    initialAttempt.completed_integration_id &&
    initialAttempt.selected_installation_id === input.candidate.installationId
  ) {
    return { ok: true as const, integrationId: initialAttempt.completed_integration_id };
  }
  // The recorded eligible-installation entry supplies the installation id,
  // account id, login and account type that the provider reads and the connect
  // below use. A candidate this attempt did not record returns
  // `installation_unavailable` before the first provider read runs.
  if (initialAttempt.consumed_at || new Date(initialAttempt.expires_at) <= new Date())
    return { ok: false as const, reason: 'installation_unavailable' as const };
  if (initialAttempt.selected_installation_id !== input.candidate.installationId)
    return { ok: false as const, reason: 'installation_unavailable' as const };
  const storedCandidate = matchStoredCandidate(
    initialAttempt.eligible_installations,
    input.candidate
  );
  if (!storedCandidate) return { ok: false as const, reason: 'installation_unavailable' as const };
  const details = await fetchGitHubInstallationDetails(
    storedCandidate.installationId,
    initialAttempt.github_app_type
  );
  if (
    details.account.id.toString() !== storedCandidate.accountId ||
    details.account.login !== storedCandidate.accountLogin
  )
    return { ok: false as const, reason: 'installation_unavailable' as const };
  // Cache the repository inventory for both selections, not only
  // `selected`. A newly attached shared association starts with
  // repositories=null, and discovery/Slack read the cached list, so an
  // all-repositories shared attach would otherwise look repository-less on
  // first use.
  //
  // For `all` installs this sync is best-effort: a transient listing failure
  // (rate limit, 5xx, timeout) must not block connecting, and the cache can
  // be populated later — the pending-install completion path treats the same
  // call the same way. A `selected` install keeps surfacing the failure
  // because that listing is the user's own selection.
  const fetchInventory = () =>
    fetchGitHubRepositoriesForMaintenance(
      storedCandidate.installationId,
      initialAttempt.github_app_type
    );
  const repositories =
    details.repository_selection === 'selected'
      ? await fetchInventory()
      : await fetchInventory().catch(error => {
          captureException(error, {
            tags: { operation: 'github-connect-attach-repository-sync' },
          });
          return null;
        });
  const completed = await db.transaction(async tx => {
    const [attempt] = await tx
      .select()
      .from(github_connection_attempts)
      .where(
        and(
          eq(github_connection_attempts.id, input.attemptId),
          eq(github_connection_attempts.kilo_user_id, input.userId)
        )
      )
      .for('update');
    if (
      !attempt ||
      attempt.github_user_id !== input.githubUserId ||
      attempt.selected_installation_id !== input.candidate.installationId
    )
      return { ok: false as const, reason: 'installation_unavailable' as const };
    if (attempt.completed_integration_id)
      return {
        ok: true as const,
        integrationId: attempt.completed_integration_id,
        roleTransfers: [],
      };
    if (attempt.consumed_at || new Date(attempt.expires_at) <= new Date())
      return { ok: false as const, reason: 'installation_unavailable' as const };
    // Same helper as the pre-provider check above, so the two checks cannot
    // drift apart.
    const storedCandidate = matchStoredCandidate(attempt.eligible_installations, input.candidate);
    if (!storedCandidate) {
      return { ok: false as const, reason: 'installation_unavailable' as const };
    }
    const owner = { type: attempt.owner_type, id: attempt.owner_id } as const;
    await input.authorizeOwner(owner);
    const result = await connectVerifiedGitHubInstallation(
      owner,
      {
        platformInstallationId: storedCandidate.installationId,
        platformAccountId: storedCandidate.accountId,
        platformAccountLogin: storedCandidate.accountLogin,
        permissions: details.permissions,
        scopes: details.events,
        repositoryAccess: details.repository_selection,
        repositories,
        installedAt: details.created_at,
        githubAppType: attempt.github_app_type,
        kiloUserId: input.userId,
        githubUserId: input.githubUserId,
        accountType: storedCandidate.accountType,
      },
      tx
    );
    if (!result.ok) return result;
    await tx
      .update(github_connection_attempts)
      .set({
        consumed_at: new Date().toISOString(),
        completed_integration_id: result.integrationId,
      })
      .where(eq(github_connection_attempts.id, attempt.id));
    return result;
  });
  // Log the workflow-role transfers only after this transaction has committed —
  // see the ConnectVerifiedGitHubInstallationInTransactionResult doc comment.
  if (completed.ok) logGitHubWorkflowRoleTransfers(completed.roleTransfers);
  return completed.ok
    ? { ok: true as const, integrationId: completed.integrationId }
    : { ok: false as const, reason: completed.reason };
}
