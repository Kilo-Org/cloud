import 'server-only';

import { db } from '@/lib/drizzle';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { github_connection_attempts } from '@kilocode/db/schema';
import type { Owner } from '@/lib/integrations/core/types';
import { connectVerifiedGitHubInstallation } from '@/lib/integrations/db/github-installations';
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
    .where(eq(github_connection_attempts.id, attempt.id))
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
  const [initialAttempt] = await db
    .select({ appType: github_connection_attempts.github_app_type })
    .from(github_connection_attempts)
    .where(eq(github_connection_attempts.id, input.attemptId))
    .limit(1);
  if (!initialAttempt) return { ok: false as const, reason: 'installation_unavailable' as const };
  const details = await fetchGitHubInstallationDetails(
    input.candidate.installationId,
    initialAttempt.appType
  );
  if (
    details.account.id.toString() !== input.candidate.accountId ||
    details.account.login !== input.candidate.accountLogin
  )
    return { ok: false as const, reason: 'installation_unavailable' as const };
  const repositories =
    details.repository_selection === 'selected'
      ? await fetchGitHubRepositoriesForMaintenance(
          input.candidate.installationId,
          initialAttempt.appType
        )
      : null;
  return db.transaction(async tx => {
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
      attempt.consumed_at ||
      new Date(attempt.expires_at) <= new Date() ||
      attempt.github_user_id !== input.githubUserId ||
      attempt.selected_installation_id !== input.candidate.installationId
    )
      return { ok: false as const, reason: 'installation_unavailable' as const };
    const storedCandidates = candidatesSchema.safeParse(attempt.eligible_installations);
    if (
      !storedCandidates.success ||
      !storedCandidates.data.some(
        candidate =>
          candidate.installationId === input.candidate.installationId &&
          candidate.accountId === input.candidate.accountId &&
          candidate.accountLogin === input.candidate.accountLogin &&
          candidate.accountType === input.candidate.accountType
      )
    ) {
      return { ok: false as const, reason: 'installation_unavailable' as const };
    }
    if (attempt.completed_integration_id)
      return { ok: true as const, integrationId: attempt.completed_integration_id };
    const owner = { type: attempt.owner_type, id: attempt.owner_id } as const;
    await input.authorizeOwner(owner);
    const result = await connectVerifiedGitHubInstallation(
      owner,
      {
        platformInstallationId: input.candidate.installationId,
        platformAccountId: input.candidate.accountId,
        platformAccountLogin: input.candidate.accountLogin,
        permissions: details.permissions,
        scopes: details.events,
        repositoryAccess: details.repository_selection,
        repositories,
        installedAt: details.created_at,
        githubAppType: attempt.github_app_type,
        kiloUserId: input.userId,
        githubUserId: input.githubUserId,
        accountType: input.candidate.accountType,
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
}
