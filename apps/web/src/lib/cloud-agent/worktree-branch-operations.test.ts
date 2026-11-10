import { beforeEach, describe, expect, it } from '@jest/globals';
import { runWorktreeBranchOperation } from './worktree-branch-operations';

const mockGetProviderBranchHead = jest.fn();
const mockListProviderBranches = jest.fn();
const mockRetarget = jest.fn();

jest.mock('@/lib/cloud-agent/provider-branch-listing', () => ({
  providerBranchPlatformForGitUrl: () => 'github',
  repositoryFullNameFromGitUrl: () => 'acme/repo',
  getProviderBranchHead: (...args: unknown[]) => mockGetProviderBranchHead(...args),
  listProviderRepositoryBranches: (...args: unknown[]) => mockListProviderBranches(...args),
}));

jest.mock('@/lib/cloud-agent/github-branch-ops', () => ({
  retargetGitHubPullRequestBase: (...args: unknown[]) => mockRetarget(...args),
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: async () => ({
    id: 'intg_1',
    platform_installation_id: 'install_1',
    integration_status: 'active',
    suspended_at: null,
    auth_invalid_at: null,
    github_disconnected_at: null,
    github_app_type: 'standard',
  }),
  getIntegrationsByOrganization: async () => [],
  getGitHubIntegrationById: async () => null,
}));

jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  logExceptInTest: () => {},
  warnExceptInTest: () => {},
}));

const userId = 'user_1';
const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
const parentWorktreeId = 'worktree_22222222-2222-4222-8222-222222222222';
const cloudAgentSessionId = 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function database(responses: unknown[][], updates: Record<string, unknown>[] = []) {
  let index = 0;
  const query = {
    from: () => query,
    innerJoin: () => query,
    where: () => query,
    orderBy: () => query,
    limit: async () => responses[index++] ?? [],
    then: (resolve: (rows: unknown[]) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve(responses[index++] ?? []).then(resolve, reject),
  };
  return {
    select: () => query,
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push(values);
        },
      }),
    }),
  };
}

function client(overrides: Record<string, unknown> = {}) {
  return {
    getSession: jest.fn(async () => ({
      branchName: 'feat-child',
      gitUrl: 'https://github.com/acme/repo.git',
      platform: 'github' as const,
      ...overrides,
    })),
    syncWorktreeBranch: jest.fn(),
    restackWorktreeBranch: jest.fn(),
    adoptWorktreeBase: jest.fn(
      async (_input: {
        cloudAgentSessionId: string;
        expectedWorktreeId: string;
        baseBranch: string;
        baseSha: string;
      }) => ({ success: true as const })
    ),
  };
}

const sessionRow = {
  worktreeId,
  gitBranch: 'feat-child',
  gitUrl: 'https://github.com/acme/repo.git',
  prNumber: 7,
};

function childRow(overrides: Record<string, unknown> = {}) {
  return {
    userId,
    baseSha: 'b'.repeat(40),
    baseBranch: 'main',
    parentWorktreeId: null,
    deletionStartedAt: null,
    deletionCompletedAt: null,
    ...overrides,
  };
}

function completed(operation: 'sync' | 'restack', overrides: Record<string, unknown> = {}) {
  return {
    status: 'changed',
    operation,
    branch: 'feat-child',
    baseBranch: 'main',
    baseSha: 'c'.repeat(40),
    previousRemoteSha: 'd'.repeat(40),
    remoteSha: 'e'.repeat(40),
    headSha: 'f'.repeat(40),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetProviderBranchHead.mockResolvedValue({ sha: 'a'.repeat(40) });
});

describe('runWorktreeBranchOperation', () => {
  it('persists the base from a completed sync and never retargets the PR', async () => {
    const updates: Record<string, unknown>[] = [];
    const db = database(
      [
        [sessionRow],
        [childRow()],
        [],
        [{ prBaseRef: 'main' }],
        [{ cloudAgentSessionId: 'workspace_sibling' }],
      ],
      updates
    );
    const gateway = client();
    gateway.syncWorktreeBranch.mockResolvedValue(completed('sync'));

    await expect(
      runWorktreeBranchOperation({
        db: db as never,
        client: gateway as never,
        userId,
        cloudAgentSessionId,
        operation: 'sync',
      })
    ).resolves.toMatchObject({ status: 'changed', operation: 'sync' });

    expect(gateway.syncWorktreeBranch).toHaveBeenCalledWith({
      cloudAgentSessionId,
      baseBranch: 'main',
      upstreamSha: 'b'.repeat(40),
    });
    expect(updates).toEqual([{ base_sha: 'c'.repeat(40) }]);
    expect(gateway.adoptWorktreeBase).toHaveBeenCalledWith({
      cloudAgentSessionId: 'workspace_sibling',
      expectedWorktreeId: worktreeId,
      baseBranch: 'main',
      baseSha: 'c'.repeat(40),
    });
    expect(mockRetarget).not.toHaveBeenCalled();
  });

  it('does not write a new base when a restack was answered as a sync', async () => {
    const updates: Record<string, unknown>[] = [];
    const db = database([[sessionRow], [childRow()], [], [{ prBaseRef: 'main' }]], updates);
    const gateway = client();
    gateway.restackWorktreeBranch.mockResolvedValue(completed('sync'));

    await expect(
      runWorktreeBranchOperation({
        db: db as never,
        client: gateway as never,
        userId,
        cloudAgentSessionId,
        operation: 'restack',
      })
    ).resolves.toMatchObject({ status: 'changed', operation: 'sync' });

    expect(updates).toEqual([]);
    expect(mockRetarget).not.toHaveBeenCalled();
    expect(gateway.adoptWorktreeBase).not.toHaveBeenCalled();
  });

  it('refuses a branch claimed by another live worktree in the same repository', async () => {
    const db = database([[sessionRow], [childRow()], [{ worktreeId: parentWorktreeId }]]);
    const gateway = client();

    await expect(
      runWorktreeBranchOperation({
        db: db as never,
        client: gateway as never,
        userId,
        cloudAgentSessionId,
        operation: 'sync',
      })
    ).resolves.toMatchObject({
      status: 'refused',
      reason: 'branch_owned_by_sibling',
    });
    expect(gateway.syncWorktreeBranch).not.toHaveBeenCalled();
    expect(gateway.adoptWorktreeBase).not.toHaveBeenCalled();
  });

  it('uses the merged parent base for a restack and retargets on success', async () => {
    const updates: Record<string, unknown>[] = [];
    const db = database(
      [
        [sessionRow],
        [childRow({ parentWorktreeId, baseSha: null, baseBranch: 'feat-parent' })],
        [],
        [{ userId, baseBranch: 'feat-parent', deletionStartedAt: null, deletionCompletedAt: null }],
        [
          {
            cloudAgentSessionId: 'workspace_parent',
            gitUrl: sessionRow.gitUrl,
            gitBranch: 'feat-parent',
          },
        ],
        [{ prState: 'merged', prBaseRef: 'main', prHeadSha: '1'.repeat(40) }],
        [{ cloudAgentSessionId: 'workspace_sibling' }],
      ],
      updates
    );
    const gateway = client();
    gateway.restackWorktreeBranch.mockResolvedValue(
      completed('restack', { baseBranch: 'main', baseSha: '2'.repeat(40) })
    );

    await runWorktreeBranchOperation({
      db: db as never,
      client: gateway as never,
      userId,
      cloudAgentSessionId,
      operation: 'restack',
    });

    expect(gateway.restackWorktreeBranch).toHaveBeenCalledWith({
      cloudAgentSessionId,
      baseBranch: 'main',
      upstreamSha: '1'.repeat(40),
    });
    expect(updates).toEqual([{ base_sha: '2'.repeat(40), base_branch: 'main' }]);
    expect(mockRetarget).toHaveBeenCalledWith(
      expect.objectContaining({ pullNumber: 7, base: 'main' })
    );
    expect(gateway.adoptWorktreeBase).toHaveBeenCalledWith({
      cloudAgentSessionId: 'workspace_sibling',
      expectedWorktreeId: worktreeId,
      baseBranch: 'main',
      baseSha: '2'.repeat(40),
    });
  });

  it('keeps the successful result when a sibling adoption fails', async () => {
    const db = database(
      [
        [sessionRow],
        [childRow()],
        [],
        [{ prBaseRef: 'main' }],
        [{ cloudAgentSessionId: 'workspace_sibling' }],
      ],
      []
    );
    const gateway = client();
    gateway.syncWorktreeBranch.mockResolvedValue(completed('sync'));
    gateway.adoptWorktreeBase.mockRejectedValue(new Error('sandbox not ready'));

    await expect(
      runWorktreeBranchOperation({
        db: db as never,
        client: gateway as never,
        userId,
        cloudAgentSessionId,
        operation: 'sync',
      })
    ).resolves.toMatchObject({ status: 'changed', operation: 'sync' });
    expect(gateway.adoptWorktreeBase).toHaveBeenCalledTimes(1);
  });

  it('does not adopt on a worker-refused result', async () => {
    const db = database([[sessionRow], [childRow()], []], []);
    const gateway = client();
    gateway.restackWorktreeBranch.mockResolvedValue({
      status: 'refused',
      operation: 'restack',
      branch: 'feat-child',
      baseBranch: null,
      baseSha: null,
      previousRemoteSha: null,
      remoteSha: null,
      headSha: null,
      reason: 'turn_running',
      message: 'Wait for the current turn to finish.',
    });

    await expect(
      runWorktreeBranchOperation({
        db: db as never,
        client: gateway as never,
        userId,
        cloudAgentSessionId,
        operation: 'restack',
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'turn_running' });
    expect(gateway.adoptWorktreeBase).not.toHaveBeenCalled();
  });

  it('does not adopt on a conflict result', async () => {
    const db = database([[sessionRow], [childRow()], []], []);
    const gateway = client();
    gateway.restackWorktreeBranch.mockResolvedValue({
      status: 'conflict',
      operation: 'restack',
      branch: 'feat-child',
      baseBranch: 'main',
      baseSha: 'c'.repeat(40),
      previousRemoteSha: 'd'.repeat(40),
      remoteSha: 'e'.repeat(40),
      headSha: 'f'.repeat(40),
      files: ['src/a.ts'],
      command: 'git rebase origin/main',
      instruction: 'Resolve the conflict and continue.',
    });

    await expect(
      runWorktreeBranchOperation({
        db: db as never,
        client: gateway as never,
        userId,
        cloudAgentSessionId,
        operation: 'restack',
      })
    ).resolves.toMatchObject({ status: 'conflict' });
    expect(gateway.adoptWorktreeBase).not.toHaveBeenCalled();
  });
});
