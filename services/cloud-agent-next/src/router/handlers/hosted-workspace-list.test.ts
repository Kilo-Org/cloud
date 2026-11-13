import {
  encodeCloudAgentRootSessionsCursor,
  encodeCloudAgentWorkspacesCursor,
} from '@kilocode/session-ingest-contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, TRPCContext } from '../../types.js';
import type * as workspacePullRequestModule from '../../session/workspace-pull-request.js';
import { router } from '../auth.js';
import { getHostedWorkspace, listHostedWorkspaces } from './hosted-workspace-list.js';

const mocks = vi.hoisted(() => ({
  readWorkspacePullRequestSummaries: vi.fn(async () => new Map()),
}));
vi.mock('../../session/workspace-pull-request.js', async importOriginal => {
  const actual = await importOriginal<typeof workspacePullRequestModule>();
  return {
    ...actual,
    readWorkspacePullRequestSummaries: mocks.readWorkspacePullRequestSummaries,
  };
});

const userId = 'oauth/google:workspace-owner';
const workspaceId = 'worktree_11111111-1111-4111-8111-111111111111' as const;
const secondWorkspaceId = 'worktree_22222222-2222-4222-8222-222222222222' as const;
const sessionId = 'ses_12345678901234567890123456';
const sessionCursor = encodeCloudAgentRootSessionsCursor({
  updatedAt: '2026-10-18 22:31:14.123456+00',
  sessionId,
});
const workspaceCursor = encodeCloudAgentWorkspacesCursor({
  updatedAt: '2026-10-18 22:31:14.123456+00',
  workspaceId,
});

function pullRequest() {
  return {
    url: 'https://github.com/Kilo-Org/cloud/pull/142',
    number: 142,
    state: 'open' as const,
    title: 'Expose hosted workspace PR status',
    headSha: 'a'.repeat(40),
    lastSyncedAt: '2026-10-21T12:00:00.000Z',
    review: { decision: 'approved' as const, available: true, pending: false },
    checks: {
      total: 2,
      passed: 2,
      failed: 0,
      pending: 0,
      skipped: 0,
      unknown: 0,
      complete: true,
      available: true,
    },
    conversations: { unresolved: 0, complete: true },
    mergeability: { mergeable: true, state: 'clean', complete: true },
    partial: false,
    unavailable: [],
  };
}

function workspace(id: string = workspaceId) {
  return {
    workspaceId: id,
    userId: 'untrusted-service-owner',
    organizationId: null,
    name: 'Cloud workspace',
    repositoryProvider: 'github' as const,
    gitUrl: 'https://github.com/Kilo-Org/cloud',
    gitBranch: 'feature/workspace-catalog',
    profileId: null,
    deletionState: 'active' as const,
    created: 1_760_000_000_000,
    updated: 1_760_000_001_000,
    lastActivity: 1_760_000_002_000,
    sessions: [
      {
        kiloSessionId: sessionId,
        cloudAgentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
        workspaceId: id,
        userId: 'untrusted-service-owner',
        organizationId: null,
        title: 'Hosted root',
        gitUrl: 'https://github.com/Kilo-Org/cloud',
        gitBranch: 'feature/workspace-catalog',
        profileId: null,
        createdOnPlatform: 'cloud-agent-web',
        created: 1_760_000_000_000,
        updated: 1_760_000_001_000,
      },
    ],
    nextSessionCursor: sessionCursor,
  };
}

function fixture(items = [workspace()]) {
  const listCloudAgentWorkspaces = vi.fn(async () => ({
    items,
    nextCursor: workspaceCursor,
  }));
  const getCloudAgentWorkspace = vi.fn(async () => items[0] ?? null);
  const durableObjectAccess = vi.fn(() => {
    throw new Error('Hosted workspace discovery must not access Durable Objects');
  });
  const ctx = {
    env: {
      SESSION_INGEST: { listCloudAgentWorkspaces, getCloudAgentWorkspace },
      CLOUD_AGENT_SESSION: { idFromName: durableObjectAccess, get: durableObjectAccess },
      SANDBOX_SESSION: { idFromName: durableObjectAccess, get: durableObjectAccess },
    } as unknown as Env,
    userId,
    authToken: 'authenticated-user-token',
    request: new Request('https://worker.test/trpc/listHostedWorkspaces'),
  } satisfies TRPCContext;
  return {
    caller: router({ listHostedWorkspaces, getHostedWorkspace }).createCaller(ctx),
    listCloudAgentWorkspaces,
    getCloudAgentWorkspace,
    durableObjectAccess,
  };
}

beforeEach(() => {
  mocks.readWorkspacePullRequestSummaries.mockReset();
  mocks.readWorkspacePullRequestSummaries.mockResolvedValue(new Map());
});

describe('hosted workspace discovery', () => {
  it('projects the authenticated owner into workspace and nested session results', async () => {
    const test = fixture();

    await expect(
      test.caller.listHostedWorkspaces({
        limit: 25,
        sessionLimit: 5,
        cursor: workspaceCursor,
        repositoryUrl: 'https://github.com/Kilo-Org/cloud',
      })
    ).resolves.toMatchObject({
      items: [
        {
          workspaceId,
          userId,
          pullRequest: null,
          sessions: [{ workspaceId, userId }],
        },
      ],
      nextCursor: workspaceCursor,
    });
    expect(test.listCloudAgentWorkspaces).toHaveBeenCalledWith({
      kiloUserId: userId,
      limit: 25,
      sessionLimit: 5,
      cursor: workspaceCursor,
      repositoryUrl: 'https://github.com/Kilo-Org/cloud',
    });
    expect(mocks.readWorkspacePullRequestSummaries).toHaveBeenCalledWith(
      expect.objectContaining({ SESSION_INGEST: expect.anything() }),
      {
        userId,
        workspaces: [{ workspaceId, organizationId: null }],
      }
    );
    expect(test.durableObjectAccess).not.toHaveBeenCalled();
  });

  it('gets an authorized workspace by stable ID without runtime access', async () => {
    const test = fixture();

    await expect(
      test.caller.getHostedWorkspace({ workspaceId, sessionLimit: 20, sessionCursor })
    ).resolves.toMatchObject({
      workspaceId,
      userId,
      pullRequest: null,
      sessions: [{ workspaceId, userId }],
    });
    expect(test.getCloudAgentWorkspace).toHaveBeenCalledWith({
      kiloUserId: userId,
      workspaceId,
      sessionLimit: 20,
      sessionCursor,
    });
    expect(mocks.readWorkspacePullRequestSummaries).toHaveBeenCalledWith(expect.anything(), {
      userId,
      workspaces: [{ workspaceId, organizationId: null }],
    });
    expect(test.durableObjectAccess).not.toHaveBeenCalled();
  });

  it('attaches one workspace-level PR summary independently of root sessions', async () => {
    const test = fixture();
    mocks.readWorkspacePullRequestSummaries.mockResolvedValueOnce(
      new Map([[workspaceId, pullRequest()]])
    );

    await expect(test.caller.listHostedWorkspaces({})).resolves.toMatchObject({
      items: [{ workspaceId, pullRequest: { number: 142, review: { decision: 'approved' } } }],
    });
    expect(test.durableObjectAccess).not.toHaveBeenCalled();
  });

  it('keeps two workspaces for the same repository distinct when they share a PR', async () => {
    const test = fixture([workspace(workspaceId), { ...workspace(secondWorkspaceId) }]);
    mocks.readWorkspacePullRequestSummaries.mockResolvedValueOnce(
      new Map([
        [workspaceId, pullRequest()],
        [secondWorkspaceId, pullRequest()],
      ])
    );

    const result = await test.caller.listHostedWorkspaces({});
    expect(result.items.map(item => item.workspaceId)).toEqual([workspaceId, secondWorkspaceId]);
    expect(result.items[0]?.pullRequest).toMatchObject({ number: 142 });
    expect(result.items[1]?.pullRequest).toMatchObject({ number: 142 });
  });

  it('fails the read instead of reporting no PR when the PR projection fails', async () => {
    const test = fixture();
    mocks.readWorkspacePullRequestSummaries.mockRejectedValueOnce(
      new Error('PR cache unavailable')
    );

    await expect(test.caller.listHostedWorkspaces({})).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    expect(test.durableObjectAccess).not.toHaveBeenCalled();
  });

  it('rejects client ownership and invalid cursors before session ingest', async () => {
    const test = fixture();

    await expect(
      test.caller.listHostedWorkspaces({ cursor: 'not-a-cursor', userId } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      test.caller.getHostedWorkspace({ workspaceId, sessionCursor: 'not-a-cursor' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(test.listCloudAgentWorkspaces).not.toHaveBeenCalled();
    expect(test.getCloudAgentWorkspace).not.toHaveBeenCalled();
    expect(mocks.readWorkspacePullRequestSummaries).not.toHaveBeenCalled();
    expect(test.durableObjectAccess).not.toHaveBeenCalled();
  });
});
