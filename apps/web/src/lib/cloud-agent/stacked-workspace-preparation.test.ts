import { beforeEach, describe, expect, it } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { cloud_agent_worktrees } from '@kilocode/db/schema';
import {
  resolveStackedWorkspacePreparation,
  resolveStackedWorkspaceSource,
} from './stacked-workspace-preparation';

const mockGetProviderBranchHead = jest.fn();

jest.mock('@/lib/cloud-agent/provider-branch-listing', () => ({
  ...jest.requireActual('@/lib/cloud-agent/provider-branch-listing'),
  getProviderBranchHead: (...args: unknown[]) => mockGetProviderBranchHead(...args),
}));

const userId = 'user_1';
const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';

function database(params: {
  parent?: Record<string, unknown> | null;
  root?: Record<string, unknown> | null;
}) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows = async () =>
            table === cloud_agent_worktrees ? [params.parent] : [params.root];
          return {
            limit: rows,
            orderBy: () => ({ limit: rows }),
          };
        },
      }),
    }),
  };
}

const parent = {
  userId,
  organizationId: null,
  deletionStartedAt: null,
  deletionCompletedAt: null,
};
const root = {
  cloudAgentSessionId: 'workspace_parent',
  gitUrl: 'https://github.com/acme/repo.git',
  prNumber: 42,
};

function client(branchName = 'feat-parent', overrides: Record<string, unknown> = {}) {
  return {
    getSession: jest.fn(async () => ({
      branchName,
      gitUrl: 'https://github.com/acme/repo.git',
      platform: 'github' as const,
      githubRepo: 'acme/repo',
      githubIntegrationId: 'intg_parent',
      ...overrides,
    })),
  };
}

function sourceParams(
  overrides: Record<string, unknown> = {}
): Parameters<typeof resolveStackedWorkspaceSource>[0] {
  return {
    db: database({ parent, root }) as never,
    client: client() as never,
    userId,
    worktreeId,
    ...overrides,
  } as unknown as Parameters<typeof resolveStackedWorkspaceSource>[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetProviderBranchHead.mockResolvedValue({ sha: 'a'.repeat(40) });
});

describe('resolveStackedWorkspaceSource', () => {
  it('derives the parent repository and exact integration from runtime metadata', async () => {
    const resolved = await resolveStackedWorkspaceSource(sourceParams());

    expect(resolved.source).toEqual({
      worktreeId,
      repository: 'acme/repo',
      gitUrl: 'https://github.com/acme/repo.git',
      platform: 'github',
      branch: 'feat-parent',
      prNumber: 42,
      basePushed: true,
      githubIntegrationId: 'intg_parent',
      providerInput: {
        githubRepo: 'acme/repo',
        githubIntegrationId: 'intg_parent',
      },
    });
    expect(resolved.repository).toEqual({
      platform: 'github',
      fullName: 'acme/repo',
      canonicalUrl: 'https://github.com/acme/repo',
      githubIntegrationId: 'intg_parent',
    });
    expect(mockGetProviderBranchHead).toHaveBeenCalledWith({
      platform: 'github',
      userId,
      repositoryFullName: 'acme/repo',
      branch: 'feat-parent',
      githubIntegrationId: 'intg_parent',
    });
  });

  it('reports an unpushed base as basePushed false rather than failing the read', async () => {
    mockGetProviderBranchHead.mockResolvedValue({ missing: true });

    await expect(resolveStackedWorkspaceSource(sourceParams())).resolves.toMatchObject({
      source: { basePushed: false },
      headSha: null,
    });
  });

  it('does not reveal a parent outside the caller scope', async () => {
    const db = database({ parent: { ...parent, userId: 'someone_else' }, root });
    await expect(resolveStackedWorkspaceSource(sourceParams({ db }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses a deleting parent', async () => {
    const db = database({
      parent: { ...parent, deletionStartedAt: '2026-01-01T00:00:00Z' },
      root,
    });
    await expect(resolveStackedWorkspaceSource(sourceParams({ db }))).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('fails accurately when the provider head read fails', async () => {
    const failure = new TRPCError({ code: 'BAD_GATEWAY', message: 'provider down' });
    mockGetProviderBranchHead.mockRejectedValue(failure);
    await expect(resolveStackedWorkspaceSource(sourceParams())).rejects.toBe(failure);
  });
});

describe('resolveStackedWorkspacePreparation', () => {
  it('derives baseBranch/baseSha/parent for a parent-only request', async () => {
    const prepared = await resolveStackedWorkspacePreparation({
      ...sourceParams(),
      stackOnWorktreeId: worktreeId,
    });
    expect(prepared).toEqual({
      baseBranch: 'feat-parent',
      baseSha: 'a'.repeat(40),
      parentWorktreeId: worktreeId,
    });
  });

  it('rejects a supplied repository that differs from the parent', async () => {
    await expect(
      resolveStackedWorkspacePreparation({
        ...sourceParams(),
        stackOnWorktreeId: worktreeId,
        repository: {
          platform: 'github',
          fullName: 'acme/other',
          canonicalUrl: 'https://github.com/acme/other',
        },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects a different source-control connection than the parent', async () => {
    await expect(
      resolveStackedWorkspacePreparation({
        ...sourceParams(),
        stackOnWorktreeId: worktreeId,
        repository: {
          platform: 'github',
          fullName: 'acme/repo',
          canonicalUrl: 'https://github.com/acme/repo',
          githubIntegrationId: 'intg_other',
        },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects an upstream branch with a parent even without baseBranch', async () => {
    await expect(
      resolveStackedWorkspacePreparation({
        ...sourceParams(),
        stackOnWorktreeId: worktreeId,
        upstreamBranch: 'other',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects an unpushed parent base before any session is created', async () => {
    mockGetProviderBranchHead.mockResolvedValue({ missing: true });
    await expect(
      resolveStackedWorkspacePreparation({
        ...sourceParams(),
        stackOnWorktreeId: worktreeId,
      })
    ).rejects.toThrow('has not been pushed');
  });
});
