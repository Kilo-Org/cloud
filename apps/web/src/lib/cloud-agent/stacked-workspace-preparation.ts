import 'server-only';

import { TRPCError } from '@trpc/server';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { db as WebDb } from '@kilocode/web-shared/lib/drizzle';
import { cli_sessions_v2, cloud_agent_worktrees } from '@kilocode/db/schema';
import { normalizeGitUrl } from '@kilocode/worker-utils/normalize-git-url';

import {
  getProviderBranchHead,
  providerBranchPlatformForGitUrl,
  repositoryFullNameFromGitUrl,
  type ProviderBranchPlatform,
} from '@/lib/cloud-agent/provider-branch-listing';

type Database = Pick<typeof WebDb, 'select'>;

/** The slice of the Cloud Agent client this module reads. */
type SessionMetadataReader = {
  getSession(cloudAgentSessionId: string): Promise<{
    branchName?: string;
    gitUrl?: string;
    platform?: ProviderBranchPlatform;
    githubRepo?: string;
    githubIntegrationId?: string;
    bitbucketWorkspaceUuid?: string;
    bitbucketRepositoryUuid?: string;
    gitlabProject?: string;
  }>;
};

export type StackedWorkspaceRepository = {
  platform: ProviderBranchPlatform | 'git';
  /** `owner/repo`, `group/project`, or `workspace/slug`, as the provider names it. */
  fullName: string;
  /** The canonical clone URL the Worker records for the new session. */
  canonicalUrl: string;
  /** The exact integration the parent session used, when it is a GitHub repository. */
  githubIntegrationId?: string;
};

export type StackedWorkspaceProviderInput = {
  githubRepo?: string;
  githubIntegrationId?: string | null;
  gitlabProject?: string;
  bitbucketRepo?: { fullName: string; workspaceUuid: string; repositoryUuid: string };
  publicRepoUrl?: string;
};

export type StackedWorkspaceSource = {
  worktreeId: string;
  repository: string;
  gitUrl: string;
  platform: ProviderBranchPlatform | 'git';
  branch: string;
  prNumber: number | null;
  basePushed: boolean;
  githubIntegrationId: string | null;
  providerInput: StackedWorkspaceProviderInput;
};

/** Everything the routers need from one parent lookup; only the public fields are returned to clients. */
export type ResolvedStackedWorkspace = {
  source: StackedWorkspaceSource;
  /** The parent head when the branch is pushed; null when it is missing. */
  headSha: string | null;
  repository: StackedWorkspaceRepository;
};

export type StackedWorkspacePreparation = {
  baseBranch?: string;
  baseSha?: string;
  parentWorktreeId?: string;
};

export const BASE_BRANCH_MAX_LENGTH = 256;

const SAME_REPOSITORY_MESSAGE =
  'A stacked workspace must use the same repository as the workspace it is stacked on.';
const PARENT_DELETING_MESSAGE = 'That workspace is being deleted.';
const PARENT_UNAVAILABLE_MESSAGE = 'That workspace is not available.';

function invalidBaseBranch(message: string): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message });
}

function assertBaseBranchShape(baseBranch: string): void {
  if (
    baseBranch.length === 0 ||
    baseBranch.length > BASE_BRANCH_MAX_LENGTH ||
    baseBranch.trim() !== baseBranch
  ) {
    throw invalidBaseBranch(`Branch names must be 1-${BASE_BRANCH_MAX_LENGTH} characters.`);
  }
}

function assertBranchPair(
  baseBranch: string | undefined,
  upstreamBranch: string | undefined
): void {
  if (baseBranch !== undefined && upstreamBranch !== undefined) {
    throw invalidBaseBranch('Choose either a base branch or an upstream branch, not both.');
  }
  if (baseBranch !== undefined) assertBaseBranchShape(baseBranch);
}

function detectPlatform(gitUrl: string): ProviderBranchPlatform | 'git' {
  return providerBranchPlatformForGitUrl(gitUrl);
}

function repositoryPath(gitUrl: string): string | null {
  return repositoryFullNameFromGitUrl(gitUrl);
}

function githubFullName(metadata: { githubRepo?: string }, gitUrl: string): string | null {
  return metadata.githubRepo ?? repositoryPath(gitUrl);
}

async function resolveBaseSha(params: {
  platform: ProviderBranchPlatform;
  userId: string;
  organizationId?: string;
  repository: StackedWorkspaceRepository;
  baseBranch: string;
}): Promise<string> {
  const head = await getProviderBranchHead({
    platform: params.platform,
    userId: params.userId,
    ...(params.organizationId ? { organizationId: params.organizationId } : {}),
    repositoryFullName: params.repository.fullName,
    branch: params.baseBranch,
    ...(params.repository.githubIntegrationId
      ? { githubIntegrationId: params.repository.githubIntegrationId }
      : {}),
  });
  if ('missing' in head) {
    throw invalidBaseBranch(`Base branch \`${params.baseBranch}\` has not been pushed`);
  }
  return head.sha;
}

type ParentWorkspace = {
  rootCloudAgentSessionId: string;
  rootGitUrl: string | null;
  prNumber: number | null;
};

/**
 * The parent's root chat is the authoritative branch source: `git_branch` can be
 * stale when the agent switched branches, while the runtime's stored metadata
 * follows the checkout.
 */
async function readParentWorkspace(
  db: Database,
  parentWorktreeId: string
): Promise<ParentWorkspace> {
  const [root] = await db
    .select({
      cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
      gitUrl: cli_sessions_v2.git_url,
      prNumber: cli_sessions_v2.pr_number,
    })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.cloud_agent_worktree_id, parentWorktreeId),
        isNull(cli_sessions_v2.parent_session_id),
        isNotNull(cli_sessions_v2.cloud_agent_session_id)
      )
    )
    .orderBy(cli_sessions_v2.created_at)
    .limit(1);
  if (!root?.cloudAgentSessionId) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'That workspace has no session yet, so it has no branch to stack on.',
    });
  }
  return {
    rootCloudAgentSessionId: root.cloudAgentSessionId,
    rootGitUrl: root.gitUrl,
    prNumber: root.prNumber,
  };
}

async function assertParentScope(
  db: Database,
  parentWorktreeId: string,
  userId: string,
  organizationId: string | undefined
): Promise<void> {
  const [parent] = await db
    .select({
      userId: cloud_agent_worktrees.kilo_user_id,
      organizationId: cloud_agent_worktrees.organization_id,
      deletionStartedAt: cloud_agent_worktrees.deletion_started_at,
      deletionCompletedAt: cloud_agent_worktrees.deletion_completed_at,
    })
    .from(cloud_agent_worktrees)
    .where(eq(cloud_agent_worktrees.worktree_id, parentWorktreeId))
    .limit(1);

  // A workspace outside the caller's scope is indistinguishable from a missing
  // one, so stacking cannot be used to probe another user's or organization's
  // worktree ids.
  if (!parent || parent.userId !== userId || parent.organizationId !== (organizationId ?? null)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: PARENT_UNAVAILABLE_MESSAGE });
  }
  if (parent.deletionStartedAt !== null || parent.deletionCompletedAt !== null) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: PARENT_DELETING_MESSAGE });
  }
}

function deriveRepository(params: {
  worktreeId: string;
  metadata: Awaited<ReturnType<SessionMetadataReader['getSession']>>;
  rootGitUrl: string | null;
  prNumber: number | null;
}): { source: StackedWorkspaceSource; repository: StackedWorkspaceRepository } {
  const { metadata } = params;
  const gitUrl = metadata.gitUrl ?? params.rootGitUrl;
  if (gitUrl === null || gitUrl.length === 0) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'That workspace has no repository to stack on.',
    });
  }

  const platform = metadata.platform ?? detectPlatform(gitUrl);
  const base = {
    worktreeId: params.worktreeId,
    gitUrl,
    platform,
    branch: metadata.branchName ?? '',
    prNumber: params.prNumber,
    githubIntegrationId: metadata.githubIntegrationId ?? null,
  } satisfies Omit<StackedWorkspaceSource, 'repository' | 'basePushed' | 'providerInput'>;

  if (platform === 'github') {
    const fullName = githubFullName(metadata, gitUrl);
    if (fullName === null) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'That workspace has no GitHub repository to stack on.',
      });
    }
    return {
      source: {
        ...base,
        repository: fullName,
        basePushed: false,
        providerInput: {
          githubRepo: fullName,
          githubIntegrationId: metadata.githubIntegrationId ?? null,
        },
      },
      repository: {
        platform: 'github',
        fullName,
        canonicalUrl: `https://github.com/${fullName}`,
        ...(metadata.githubIntegrationId
          ? { githubIntegrationId: metadata.githubIntegrationId }
          : {}),
      },
    };
  }

  if (platform === 'gitlab') {
    const project = metadata.gitlabProject ?? repositoryPath(gitUrl);
    if (project === null) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'That workspace has no GitLab project to stack on.',
      });
    }
    return {
      source: {
        ...base,
        repository: project,
        basePushed: false,
        providerInput: { gitlabProject: project },
      },
      repository: { platform: 'gitlab', fullName: project, canonicalUrl: gitUrl },
    };
  }

  if (platform === 'bitbucket') {
    const fullName = repositoryPath(gitUrl);
    if (fullName === null) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'That workspace has no Bitbucket repository to stack on.',
      });
    }
    const workspaceUuid = metadata.bitbucketWorkspaceUuid;
    const repositoryUuid = metadata.bitbucketRepositoryUuid;
    return {
      source: {
        ...base,
        repository: fullName,
        basePushed: false,
        providerInput:
          workspaceUuid !== undefined && repositoryUuid !== undefined
            ? {
                bitbucketRepo: { fullName, workspaceUuid, repositoryUuid },
              }
            : {},
      },
      repository: { platform: 'bitbucket', fullName, canonicalUrl: gitUrl },
    };
  }

  return {
    source: {
      ...base,
      repository: repositoryPath(gitUrl) ?? gitUrl,
      basePushed: false,
      providerInput: { publicRepoUrl: gitUrl },
    },
    repository: {
      platform: 'git',
      fullName: repositoryPath(gitUrl) ?? gitUrl,
      canonicalUrl: gitUrl,
    },
  };
}

/**
 * Resolve a parent workspace for a read-only source view or a create. The
 * provider preflight runs here, before any session or attachment is created.
 */
export async function resolveStackedWorkspaceSource(params: {
  db: Database;
  client: SessionMetadataReader;
  userId: string;
  organizationId?: string;
  worktreeId: string;
}): Promise<ResolvedStackedWorkspace> {
  await assertParentScope(params.db, params.worktreeId, params.userId, params.organizationId);
  const root = await readParentWorkspace(params.db, params.worktreeId);

  let metadata: Awaited<ReturnType<SessionMetadataReader['getSession']>>;
  try {
    metadata = await params.client.getSession(root.rootCloudAgentSessionId);
  } catch (error) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Could not read the branch of that workspace. Try again.',
      cause: error,
    });
  }
  if (metadata.branchName === undefined || metadata.branchName.length === 0) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'That workspace has no branch to stack on yet.',
    });
  }

  const derived = deriveRepository({
    worktreeId: params.worktreeId,
    metadata,
    rootGitUrl: root.rootGitUrl,
    prNumber: root.prNumber,
  });

  if (derived.repository.platform === 'git') {
    return { ...derived, source: { ...derived.source, basePushed: false }, headSha: null };
  }

  const head = await getProviderBranchHead({
    platform: derived.repository.platform,
    userId: params.userId,
    ...(params.organizationId ? { organizationId: params.organizationId } : {}),
    repositoryFullName: derived.repository.fullName,
    branch: metadata.branchName,
    ...(derived.repository.githubIntegrationId
      ? { githubIntegrationId: derived.repository.githubIntegrationId }
      : {}),
  });
  const headSha = 'sha' in head ? head.sha : null;
  return {
    ...derived,
    headSha,
    source: { ...derived.source, basePushed: headSha !== null },
  };
}

/**
 * Resolve the fields the Worker records for a new session. `stackOnWorktreeId`
 * is the only source of the parent repository; a caller-supplied repository
 * that differs is refused rather than silently replaced.
 */
export async function resolveStackedWorkspacePreparation(params: {
  db: Database;
  client: SessionMetadataReader;
  userId: string;
  organizationId?: string;
  stackOnWorktreeId?: string;
  baseBranch?: string;
  upstreamBranch?: string;
  repository?: StackedWorkspaceRepository;
  parent?: ResolvedStackedWorkspace;
}): Promise<StackedWorkspacePreparation> {
  assertBranchPair(params.baseBranch, params.upstreamBranch);

  if (params.stackOnWorktreeId !== undefined) {
    if (params.upstreamBranch !== undefined) {
      throw invalidBaseBranch('Choose either a base branch or an upstream branch, not both.');
    }
    const parent =
      params.parent ??
      (await resolveStackedWorkspaceSource({
        db: params.db,
        client: params.client,
        userId: params.userId,
        ...(params.organizationId ? { organizationId: params.organizationId } : {}),
        worktreeId: params.stackOnWorktreeId,
      }));
    if (
      params.repository !== undefined &&
      normalizeGitUrl(params.repository.canonicalUrl) !==
        normalizeGitUrl(parent.repository.canonicalUrl)
    ) {
      throw invalidBaseBranch(SAME_REPOSITORY_MESSAGE);
    }
    if (params.repository?.githubIntegrationId !== undefined) {
      const parentIntegration = parent.source.githubIntegrationId;
      if (
        parentIntegration === null ||
        parentIntegration !== params.repository.githubIntegrationId
      ) {
        throw invalidBaseBranch(
          'A stacked workspace must use the same source-control connection as the workspace it is stacked on.'
        );
      }
    }
    if (params.baseBranch !== undefined && params.baseBranch !== parent.source.branch) {
      throw invalidBaseBranch(
        `A stacked workspace must start from \`${parent.source.branch}\`, the branch it is stacked on.`
      );
    }
    if (parent.headSha === null) {
      throw invalidBaseBranch(`Base branch \`${parent.source.branch}\` has not been pushed`);
    }
    return {
      baseBranch: parent.source.branch,
      baseSha: parent.headSha,
      parentWorktreeId: params.stackOnWorktreeId,
    };
  }

  if (params.baseBranch === undefined) return {};
  if (params.repository === undefined) {
    throw invalidBaseBranch('A base branch needs a connected repository provider.');
  }
  if (params.repository.platform === 'git') {
    throw invalidBaseBranch('A base branch needs a connected repository provider.');
  }
  const baseSha = await resolveBaseSha({
    platform: params.repository.platform,
    userId: params.userId,
    ...(params.organizationId ? { organizationId: params.organizationId } : {}),
    repository: params.repository,
    baseBranch: params.baseBranch,
  });
  return { baseBranch: params.baseBranch, baseSha };
}

export function stackedWorkspaceSourceOutput(
  parent: ResolvedStackedWorkspace
): StackedWorkspaceSource {
  return parent.source;
}

export function assertSuppliedRepositoryMatchesParent(params: {
  supplied: {
    githubRepo?: string;
    githubIntegrationId?: string;
    gitlabProject?: string;
    publicRepoUrl?: string;
    bitbucketRepo?: { fullName: string; workspaceUuid: string; repositoryUuid: string };
  };
  parent: ResolvedStackedWorkspace;
}): void {
  const { supplied, parent } = params;
  const sameFullName = (value: string | undefined): boolean =>
    value === undefined || value.toLowerCase() === parent.repository.fullName.toLowerCase();
  const sameUrl = (value: string | undefined): boolean =>
    value === undefined ||
    normalizeGitUrl(value) === normalizeGitUrl(parent.repository.canonicalUrl);

  if (
    !sameFullName(supplied.githubRepo) ||
    !sameFullName(supplied.gitlabProject) ||
    !sameFullName(supplied.bitbucketRepo?.fullName) ||
    !sameUrl(supplied.publicRepoUrl) ||
    (supplied.bitbucketRepo !== undefined &&
      (supplied.bitbucketRepo.workspaceUuid !==
        parent.source.providerInput.bitbucketRepo?.workspaceUuid ||
        supplied.bitbucketRepo.repositoryUuid !==
          parent.source.providerInput.bitbucketRepo?.repositoryUuid))
  ) {
    throw invalidBaseBranch(SAME_REPOSITORY_MESSAGE);
  }
  if (
    supplied.githubIntegrationId !== undefined &&
    supplied.githubIntegrationId !== parent.source.githubIntegrationId
  ) {
    throw invalidBaseBranch(
      'A stacked workspace must use the same source-control connection as the workspace it is stacked on.'
    );
  }
}
