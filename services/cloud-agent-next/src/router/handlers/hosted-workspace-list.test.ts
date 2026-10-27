import {
  encodeCloudAgentRootSessionsCursor,
  encodeCloudAgentWorkspacesCursor,
} from '@kilocode/session-ingest-contracts';
import { describe, expect, it, vi } from 'vitest';
import type { Env, TRPCContext } from '../../types.js';
import { router } from '../auth.js';
import { getHostedWorkspace, listHostedWorkspaces } from './hosted-workspace-list.js';

const userId = 'oauth/google:workspace-owner';
const workspaceId = 'worktree_11111111-1111-4111-8111-111111111111' as const;
const sessionId = 'ses_12345678901234567890123456';
const sessionCursor = encodeCloudAgentRootSessionsCursor({
  updatedAt: '2026-10-18 22:31:14.123456+00',
  sessionId,
});
const workspaceCursor = encodeCloudAgentWorkspacesCursor({
  updatedAt: '2026-10-18 22:31:14.123456+00',
  workspaceId,
});

function workspace() {
  return {
    workspaceId,
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
        workspaceId,
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

function fixture() {
  const listCloudAgentWorkspaces = vi.fn(async () => ({
    items: [workspace()],
    nextCursor: workspaceCursor,
  }));
  const getCloudAgentWorkspace = vi.fn(async () => workspace());
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
      items: [{ workspaceId, userId, sessions: [{ workspaceId, userId }] }],
      nextCursor: workspaceCursor,
    });
    expect(test.listCloudAgentWorkspaces).toHaveBeenCalledWith({
      kiloUserId: userId,
      limit: 25,
      sessionLimit: 5,
      cursor: workspaceCursor,
      repositoryUrl: 'https://github.com/Kilo-Org/cloud',
    });
    expect(test.durableObjectAccess).not.toHaveBeenCalled();
  });

  it('gets an authorized workspace by stable ID without runtime access', async () => {
    const test = fixture();

    await expect(
      test.caller.getHostedWorkspace({ workspaceId, sessionLimit: 20, sessionCursor })
    ).resolves.toMatchObject({ workspaceId, userId, sessions: [{ workspaceId, userId }] });
    expect(test.getCloudAgentWorkspace).toHaveBeenCalledWith({
      kiloUserId: userId,
      workspaceId,
      sessionLimit: 20,
      sessionCursor,
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
    expect(test.durableObjectAccess).not.toHaveBeenCalled();
  });
});
