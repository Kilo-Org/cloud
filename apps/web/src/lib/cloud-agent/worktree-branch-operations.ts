import 'server-only';

import { TRPCError } from '@trpc/server';
import { and, desc, eq, isNotNull, isNull, ne, type SQL } from 'drizzle-orm';
import type { db as WebDb } from '@kilocode/web-shared/lib/drizzle';
import {
  cli_sessions_v2,
  cloud_agent_worktrees,
  github_branch_pull_requests,
} from '@kilocode/db/schema';
import { normalizeGitUrl } from '@kilocode/worker-utils/normalize-git-url';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import type { WorktreeBranchOperationResult } from '@kilocode/worker-utils/cloud-agent-worktree-operations';

import { PLATFORM } from '@/lib/integrations/core/constants';
import { isPlatformIntegrationHealthy } from '@/lib/integrations/core/health';
import type { Owner } from '@/lib/integrations/core/types';
import {
  getGitHubIntegrationById,
  getIntegrationForOwner,
  getIntegrationsByOrganization,
} from '@/lib/integrations/db/platform-integrations';
import { retargetGitHubPullRequestBase } from '@/lib/cloud-agent/github-branch-ops';
import {
  getProviderBranchHead,
  listProviderRepositoryBranches,
  providerBranchPlatformForGitUrl,
  repositoryFullNameFromGitUrl,
  type ProviderBranchPlatform,
} from '@/lib/cloud-agent/provider-branch-listing';

type Database = Pick<typeof WebDb, 'select' | 'update'>;

type WorktreeOperationClient = {
  getSession(cloudAgentSessionId: string): Promise<{
    branchName?: string;
    gitUrl?: string;
    platform?: ProviderBranchPlatform;
    githubIntegrationId?: string;
  }>;
  syncWorktreeBranch(input: {
    cloudAgentSessionId: string;
    baseBranch?: string;
    upstreamSha?: string;
  }): Promise<WorktreeBranchOperationResult>;
  restackWorktreeBranch(input: {
    cloudAgentSessionId: string;
    baseBranch?: string;
    upstreamSha?: string;
  }): Promise<WorktreeBranchOperationResult>;
  adoptWorktreeBase(input: {
    cloudAgentSessionId: string;
    expectedWorktreeId: string;
    baseBranch: string;
    baseSha: string;
  }): Promise<{ success: true }>;
};

export type WorktreeBranchOperationParams = {
  db: Database;
  client: WorktreeOperationClient;
  userId: string;
  organizationId?: string;
  cloudAgentSessionId: string;
  operation: 'sync' | 'restack';
};

type Refused = Extract<WorktreeBranchOperationResult, { status: 'refused' }>;

function organizationCondition(organizationId: string | undefined): SQL | undefined {
  return organizationId
    ? eq(cli_sessions_v2.organization_id, organizationId)
    : isNull(cli_sessions_v2.organization_id);
}

function organizationConditionForWorktree(organizationId: string | undefined): SQL | undefined {
  return organizationId
    ? eq(cloud_agent_worktrees.organization_id, organizationId)
    : isNull(cloud_agent_worktrees.organization_id);
}

function repositoryCondition(organizationId: string | undefined, userId: string): SQL | undefined {
  return organizationId
    ? eq(github_branch_pull_requests.owned_by_organization_id, organizationId)
    : and(
        isNull(github_branch_pull_requests.owned_by_organization_id),
        eq(github_branch_pull_requests.owned_by_user_id, userId)
      );
}

function refused(
  operation: 'sync' | 'restack',
  branch: string | null,
  reason: Refused['reason'],
  message: string
): WorktreeBranchOperationResult {
  return {
    status: 'refused',
    operation,
    branch,
    baseBranch: null,
    baseSha: null,
    previousRemoteSha: null,
    remoteSha: null,
    headSha: null,
    reason,
    message,
  };
}

async function retargetPullRequest(params: {
  userId: string;
  organizationId?: string;
  gitUrl: string;
  prNumber: number | null;
  baseBranch: string;
  githubIntegrationId?: string;
}): Promise<void> {
  if (params.prNumber === null) return;
  const repositoryFullName = repositoryFullNameFromGitUrl(params.gitUrl);
  if (repositoryFullName === null) return;
  if (providerBranchPlatformForGitUrl(params.gitUrl) !== 'github') return;
  try {
    const owner: Owner = params.organizationId
      ? { type: 'org', id: params.organizationId }
      : { type: 'user', id: params.userId };
    const installation = await resolveGitHubInstallation(
      owner,
      repositoryFullName,
      params.githubIntegrationId
    );
    // KiloConnect-Lite is read-only, so there is no write path to retarget.
    if (!installation || installation.appType === 'lite') return;
    await retargetGitHubPullRequestBase({
      installationId: installation.installationId,
      expectedIntegrationId: installation.integrationId,
      repositoryFullName,
      pullNumber: params.prNumber,
      base: params.baseBranch,
      purpose: 'agent',
    });
  } catch (error) {
    warnExceptInTest('[cloud-agent-next.worktree-branch-operation] PR retarget failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function resolveGitHubInstallation(
  owner: Owner,
  repositoryFullName: string,
  expectedIntegrationId?: string
): Promise<{ installationId: string; integrationId: string; appType: 'standard' | 'lite' } | null> {
  if (expectedIntegrationId !== undefined) {
    const integration = await getGitHubIntegrationById(owner, expectedIntegrationId);
    if (
      !integration ||
      !isPlatformIntegrationHealthy(integration) ||
      !integration.platform_installation_id
    ) {
      return null;
    }
    return {
      installationId: integration.platform_installation_id,
      integrationId: integration.id,
      appType: integration.github_app_type ?? 'standard',
    };
  }
  if (owner.type === 'org') {
    const integrations = (
      await getIntegrationsByOrganization(owner.id, PLATFORM.GITHUB, 'agent')
    ).filter(isPlatformIntegrationHealthy);
    if (integrations.length === 0) return null;
    const wanted = repositoryFullName.toLowerCase();
    const integration =
      integrations.find(row =>
        (row.repositories ?? []).some(repository => repository.full_name?.toLowerCase() === wanted)
      ) ?? integrations[0];
    if (!integration.platform_installation_id) return null;
    return {
      installationId: integration.platform_installation_id,
      integrationId: integration.id,
      appType: integration.github_app_type ?? 'standard',
    };
  }
  const integration = await getIntegrationForOwner(owner, PLATFORM.GITHUB);
  if (
    !integration ||
    !isPlatformIntegrationHealthy(integration) ||
    !integration.platform_installation_id
  ) {
    return null;
  }
  return {
    installationId: integration.platform_installation_id,
    integrationId: integration.id,
    appType: integration.github_app_type ?? 'standard',
  };
}

async function defaultBranch(params: {
  platform: ProviderBranchPlatform | 'git';
  userId: string;
  organizationId?: string;
  repositoryFullName: string | null;
}): Promise<string | null> {
  if (params.platform === 'git' || params.repositoryFullName === null) return null;
  const listing = await listProviderRepositoryBranches({
    platform: params.platform,
    userId: params.userId,
    ...(params.organizationId ? { organizationId: params.organizationId } : {}),
    repositoryFullName: params.repositoryFullName,
  });
  return listing.defaultBranch;
}

async function baseBranchOrFallback(params: {
  candidate: string | null;
  platform: ProviderBranchPlatform | 'git';
  userId: string;
  organizationId?: string;
  repositoryFullName: string | null;
}): Promise<string | null> {
  if (params.candidate !== null) {
    if (params.platform === 'git' || params.repositoryFullName === null) return params.candidate;
    const head = await getProviderBranchHead({
      platform: params.platform,
      userId: params.userId,
      ...(params.organizationId ? { organizationId: params.organizationId } : {}),
      repositoryFullName: params.repositoryFullName,
      branch: params.candidate,
    });
    if ('sha' in head) return params.candidate;
  }
  return defaultBranch(params);
}

async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await task(item);
    }
  });
  await Promise.all(workers);
}

/**
 * After Postgres records a completed base, the selected session's DO has it but
 * sibling chats on the same worktree still hold the old snapshot. Fan the base
 * out to every other root chat, best effort: a peer that is not ready must not
 * hide a successful git operation.
 */
async function adoptSiblingWorktreeBases(params: {
  db: Database;
  client: WorktreeOperationClient;
  userId: string;
  organizationId?: string;
  worktreeId: string;
  currentCloudAgentSessionId: string;
  baseBranch: string;
  baseSha: string;
}): Promise<void> {
  let siblings: Array<{ cloudAgentSessionId: string | null }>;
  try {
    siblings = await params.db
      .select({ cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id })
      .from(cli_sessions_v2)
      .innerJoin(
        cloud_agent_worktrees,
        and(
          eq(cloud_agent_worktrees.worktree_id, cli_sessions_v2.cloud_agent_worktree_id),
          eq(cloud_agent_worktrees.kilo_user_id, params.userId),
          organizationConditionForWorktree(params.organizationId),
          isNull(cloud_agent_worktrees.deletion_started_at),
          isNull(cloud_agent_worktrees.deletion_completed_at)
        )
      )
      .where(
        and(
          eq(cli_sessions_v2.cloud_agent_worktree_id, params.worktreeId),
          eq(cli_sessions_v2.kilo_user_id, params.userId),
          organizationCondition(params.organizationId),
          isNull(cli_sessions_v2.parent_session_id),
          isNotNull(cli_sessions_v2.cloud_agent_session_id),
          ne(cli_sessions_v2.cloud_agent_session_id, params.currentCloudAgentSessionId)
        )
      );
  } catch (error) {
    warnExceptInTest('[cloud-agent-next.worktree-branch-operation] sibling base lookup failed', {
      worktreeId: params.worktreeId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const sessionIds = siblings
    .map(row => row.cloudAgentSessionId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  await forEachWithConcurrency(sessionIds, 3, async cloudAgentSessionId => {
    try {
      await params.client.adoptWorktreeBase({
        cloudAgentSessionId,
        expectedWorktreeId: params.worktreeId,
        baseBranch: params.baseBranch,
        baseSha: params.baseSha,
      });
    } catch (error) {
      warnExceptInTest(
        '[cloud-agent-next.worktree-branch-operation] sibling base adoption failed',
        {
          cloudAgentSessionId,
          worktreeId: params.worktreeId,
          reason: error instanceof Error ? error.message : String(error),
        }
      );
    }
  });
}

/**
 * Run one operation for the session's own worktree. Everything that decides
 * what to rewrite is resolved from the worktree's own records and runtime
 * metadata; the caller only names the session.
 */
export async function runWorktreeBranchOperation(
  params: WorktreeBranchOperationParams
): Promise<WorktreeBranchOperationResult> {
  const [session] = await params.db
    .select({
      worktreeId: cli_sessions_v2.cloud_agent_worktree_id,
      gitBranch: cli_sessions_v2.git_branch,
      gitUrl: cli_sessions_v2.git_url,
      prNumber: cli_sessions_v2.pr_number,
    })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, params.userId),
        eq(cli_sessions_v2.cloud_agent_session_id, params.cloudAgentSessionId),
        organizationCondition(params.organizationId)
      )
    )
    .orderBy(cli_sessions_v2.created_at)
    .limit(1);

  if (!session?.worktreeId) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Sync and Restack are only available for a workspace branch.',
    });
  }
  const worktreeId = session.worktreeId;

  const [worktree] = await params.db
    .select({
      userId: cloud_agent_worktrees.kilo_user_id,
      baseSha: cloud_agent_worktrees.base_sha,
      baseBranch: cloud_agent_worktrees.base_branch,
      parentWorktreeId: cloud_agent_worktrees.parent_worktree_id,
      deletionStartedAt: cloud_agent_worktrees.deletion_started_at,
      deletionCompletedAt: cloud_agent_worktrees.deletion_completed_at,
    })
    .from(cloud_agent_worktrees)
    .where(
      and(
        eq(cloud_agent_worktrees.worktree_id, worktreeId),
        organizationConditionForWorktree(params.organizationId)
      )
    )
    .limit(1);

  if (!worktree || worktree.userId !== params.userId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' });
  }
  if (worktree.deletionStartedAt !== null || worktree.deletionCompletedAt !== null) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'That workspace is being deleted.',
    });
  }

  const metadata = await params.client.getSession(params.cloudAgentSessionId);
  const branch = metadata?.branchName ?? session.gitBranch;
  if (!branch) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'That workspace has no branch to sync.',
    });
  }
  const gitUrl = metadata?.gitUrl ?? session.gitUrl;
  if (!gitUrl) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'That workspace has no repository to sync.',
    });
  }
  if (
    metadata?.gitUrl !== undefined &&
    session.gitUrl !== null &&
    normalizeGitUrl(metadata.gitUrl) !== normalizeGitUrl(session.gitUrl)
  ) {
    return refused(
      params.operation,
      branch,
      'branch_mismatch',
      'The workspace switched repositories. Reload it before syncing.'
    );
  }
  if (session.gitBranch !== null && session.gitBranch !== branch) {
    if (params.operation === 'sync') {
      return refused(
        params.operation,
        branch,
        'branch_mismatch',
        'The workspace is on a different branch than its recorded branch.'
      );
    }
  }

  const platform = metadata?.platform ?? providerBranchPlatformForGitUrl(gitUrl);
  const repositoryFullName = repositoryFullNameFromGitUrl(gitUrl);

  const [claim] = await params.db
    .select({ worktreeId: cli_sessions_v2.cloud_agent_worktree_id })
    .from(cli_sessions_v2)
    .innerJoin(
      cloud_agent_worktrees,
      and(
        eq(cloud_agent_worktrees.worktree_id, cli_sessions_v2.cloud_agent_worktree_id),
        eq(cloud_agent_worktrees.kilo_user_id, params.userId),
        organizationConditionForWorktree(params.organizationId)
      )
    )
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, params.userId),
        organizationCondition(params.organizationId),
        eq(cli_sessions_v2.git_branch, branch),
        ne(cli_sessions_v2.cloud_agent_worktree_id, worktreeId),
        isNull(cloud_agent_worktrees.deletion_started_at),
        isNull(cloud_agent_worktrees.deletion_completed_at),
        eq(cli_sessions_v2.git_url, normalizeGitUrl(gitUrl))
      )
    )
    .limit(1);
  if (claim) {
    return refused(
      params.operation,
      branch,
      'branch_owned_by_sibling',
      `Another workspace already owns branch \`${branch}\`.`
    );
  }

  let upstreamSha = worktree.baseSha ?? undefined;
  let newBase: string | null = null;

  if (worktree.parentWorktreeId !== null) {
    const [parent] = await params.db
      .select({
        userId: cloud_agent_worktrees.kilo_user_id,
        baseBranch: cloud_agent_worktrees.base_branch,
        deletionStartedAt: cloud_agent_worktrees.deletion_started_at,
        deletionCompletedAt: cloud_agent_worktrees.deletion_completed_at,
      })
      .from(cloud_agent_worktrees)
      .where(
        and(
          eq(cloud_agent_worktrees.worktree_id, worktree.parentWorktreeId),
          organizationConditionForWorktree(params.organizationId)
        )
      )
      .limit(1);

    if (
      !parent ||
      parent.userId !== params.userId ||
      parent.deletionStartedAt !== null ||
      parent.deletionCompletedAt !== null
    ) {
      newBase = await baseBranchOrFallback({
        candidate: worktree.baseBranch,
        platform,
        userId: params.userId,
        ...(params.organizationId ? { organizationId: params.organizationId } : {}),
        repositoryFullName,
      });
    } else {
      const [parentRoot] = await params.db
        .select({
          cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
          gitUrl: cli_sessions_v2.git_url,
          gitBranch: cli_sessions_v2.git_branch,
        })
        .from(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.cloud_agent_worktree_id, worktree.parentWorktreeId),
            isNull(cli_sessions_v2.parent_session_id)
          )
        )
        .orderBy(cli_sessions_v2.created_at)
        .limit(1);

      const parentMetadata = parentRoot?.cloudAgentSessionId
        ? await params.client.getSession(parentRoot.cloudAgentSessionId).catch(() => null)
        : null;
      const parentGitUrl = parentMetadata?.gitUrl ?? parentRoot?.gitUrl ?? null;
      if (parentGitUrl !== null && normalizeGitUrl(parentGitUrl) !== normalizeGitUrl(gitUrl)) {
        return refused(
          params.operation,
          branch,
          'branch_mismatch',
          'The parent workspace uses a different repository.'
        );
      }

      const parentBranch = parentMetadata?.branchName ?? parentRoot?.gitBranch ?? parent.baseBranch;
      const [parentPr] = parentBranch
        ? await params.db
            .select({
              prState: github_branch_pull_requests.pr_state,
              prBaseRef: github_branch_pull_requests.pr_base_ref,
              prHeadSha: github_branch_pull_requests.pr_head_sha,
            })
            .from(github_branch_pull_requests)
            .where(
              and(
                eq(github_branch_pull_requests.git_url, normalizeGitUrl(gitUrl)),
                eq(github_branch_pull_requests.git_branch, parentBranch),
                repositoryCondition(params.organizationId, params.userId)
              )
            )
            .orderBy(desc(github_branch_pull_requests.pr_last_synced_at))
            .limit(1)
        : [];

      if (upstreamSha === undefined && parentPr?.prHeadSha) {
        upstreamSha = parentPr.prHeadSha;
      }

      if (parentPr?.prState === 'merged' || parentPr?.prState === 'closed') {
        newBase = await baseBranchOrFallback({
          candidate: parentPr.prBaseRef ?? parent.baseBranch,
          platform,
          userId: params.userId,
          ...(params.organizationId ? { organizationId: params.organizationId } : {}),
          repositoryFullName,
        });
      } else {
        newBase = parentBranch ?? null;
      }
    }
  } else {
    newBase = await baseBranchOrFallback({
      candidate: worktree.baseBranch,
      platform,
      userId: params.userId,
      ...(params.organizationId ? { organizationId: params.organizationId } : {}),
      repositoryFullName,
    });
  }

  if (params.operation === 'restack' && newBase === null) {
    return refused(
      params.operation,
      branch,
      'remote_branch_missing',
      'The new base branch no longer exists. Choose another base.'
    );
  }

  let result: WorktreeBranchOperationResult;
  if (params.operation === 'sync') {
    const [childPr] = await params.db
      .select({ prBaseRef: github_branch_pull_requests.pr_base_ref })
      .from(github_branch_pull_requests)
      .where(
        and(
          eq(github_branch_pull_requests.git_url, normalizeGitUrl(gitUrl)),
          eq(github_branch_pull_requests.git_branch, branch),
          repositoryCondition(params.organizationId, params.userId)
        )
      )
      .orderBy(desc(github_branch_pull_requests.pr_last_synced_at))
      .limit(1);
    const syncBase = childPr?.prBaseRef ?? worktree.baseBranch ?? undefined;
    result = await params.client.syncWorktreeBranch({
      cloudAgentSessionId: params.cloudAgentSessionId,
      ...(syncBase ? { baseBranch: syncBase } : {}),
      // The wrapper refuses to regress a still-live recorded boundary, so the
      // current DB fork point is the server-derived upstream for Sync.
      ...(worktree.baseSha ? { upstreamSha: worktree.baseSha } : {}),
    });
  } else {
    result = await params.client.restackWorktreeBranch({
      cloudAgentSessionId: params.cloudAgentSessionId,
      ...(newBase !== null ? { baseBranch: newBase } : {}),
      ...(upstreamSha !== undefined ? { upstreamSha } : {}),
    });
  }

  const completed = result.status === 'changed' || result.status === 'unchanged';
  if (!completed) return result;
  // A restack that the wrapper answered as a sync only reconciled the remote
  // rewrite; the intended new base was not applied. Leave both records alone
  // so the next Restack still derives from the old fork point.
  if (params.operation === 'restack' && result.operation === 'sync') return result;

  const updates: { base_sha?: string; base_branch?: string } = {};
  if (result.baseSha !== null && result.baseSha !== worktree.baseSha) {
    updates.base_sha = result.baseSha;
  }
  if (result.baseBranch !== null && result.baseBranch !== worktree.baseBranch) {
    updates.base_branch = result.baseBranch;
  }
  if (updates.base_sha !== undefined || updates.base_branch !== undefined) {
    await params.db
      .update(cloud_agent_worktrees)
      .set(updates)
      .where(
        and(
          eq(cloud_agent_worktrees.worktree_id, worktreeId),
          eq(cloud_agent_worktrees.kilo_user_id, params.userId),
          organizationConditionForWorktree(params.organizationId)
        )
      );
  }

  const effectiveBaseBranch = updates.base_branch ?? worktree.baseBranch;
  const effectiveBaseSha = updates.base_sha ?? worktree.baseSha;
  if (effectiveBaseBranch !== null && effectiveBaseSha !== null) {
    await adoptSiblingWorktreeBases({
      db: params.db,
      client: params.client,
      userId: params.userId,
      ...(params.organizationId ? { organizationId: params.organizationId } : {}),
      worktreeId,
      currentCloudAgentSessionId: params.cloudAgentSessionId,
      baseBranch: effectiveBaseBranch,
      baseSha: effectiveBaseSha,
    });
  }

  if (params.operation === 'restack' && result.baseBranch !== null) {
    await retargetPullRequest({
      userId: params.userId,
      ...(params.organizationId ? { organizationId: params.organizationId } : {}),
      gitUrl,
      prNumber: session.prNumber,
      baseBranch: result.baseBranch,
      ...(metadata?.githubIntegrationId
        ? { githubIntegrationId: metadata.githubIntegrationId }
        : {}),
    });
  }

  return result;
}
