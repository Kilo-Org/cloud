import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudAgentAuthority } from '@kilocode/worker-utils/cloud-agent-authority';

import {
  assertCloudAgentManagementRequest,
  type CloudAgentManagementPath,
} from './cloud-agent-child-management.js';

const { getSandboxSessionStubMock, requireCurrentSessionAccessMock } = vi.hoisted(() => ({
  getSandboxSessionStubMock: vi.fn(),
  requireCurrentSessionAccessMock: vi.fn(),
}));

vi.mock('./sandbox-session/session-stub.js', () => ({
  getSandboxSessionStub: getSandboxSessionStubMock,
}));

vi.mock('./session-access.js', () => ({
  requireCurrentSessionAccess: requireCurrentSessionAccessMock,
}));

vi.mock('./utils/do-retry.js', () => ({
  withDORetry: async (getStub: () => unknown, operation: (stub: unknown) => unknown) =>
    operation(getStub()),
}));

const USER_ID = 'user_contract';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PARENT_ID = 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHILD_ID = 'workspace_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WORKTREE_ID = 'worktree_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MESSAGE_ID = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';

const promptPayload = {
  type: 'prompt' as const,
  prompt: 'follow up',
  mode: 'code' as const,
  model: 'test/model',
};

function authority(organizationId: string | null): CloudAgentAuthority {
  return {
    version: 1,
    ownerId: USER_ID,
    parentSessionId: PARENT_ID,
    organizationId,
    authorizationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function metadata(organizationId: string | null) {
  return {
    identity: { sessionId: CHILD_ID, userId: USER_ID, orgId: organizationId },
    parentCloudAgentSessionId: PARENT_ID,
    workspace: { worktreeId: WORKTREE_ID },
  };
}

function stub(overrides: Record<string, unknown> = {}) {
  return {
    assertCloudAgentManagementAuthority: vi.fn().mockResolvedValue(undefined),
    getMetadata: vi.fn().mockResolvedValue(metadata(null)),
    listCloudAgentChildSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    ...overrides,
  };
}

function request(scoped: CloudAgentAuthority, path: CloudAgentManagementPath, rawInput: unknown) {
  return assertCloudAgentManagementRequest({
    env: {} as never,
    authority: scoped,
    userId: USER_ID,
    authToken: 'management-token',
    path,
    rawInput,
  });
}

const personalInputs: Record<CloudAgentManagementPath, unknown> = {
  listChildSessions: { limit: 20 },
  getSession: { cloudAgentSessionId: CHILD_ID },
  getMessageResult: {
    cloudAgentSessionId: CHILD_ID,
    messageId: MESSAGE_ID,
    expectedWorktreeId: WORKTREE_ID,
  },
  interruptSession: { sessionId: CHILD_ID },
  sendMessageV2: {
    cloudAgentSessionId: CHILD_ID,
    messageId: MESSAGE_ID,
    payload: promptPayload,
    autoCommit: true,
    expectedWorktreeId: WORKTREE_ID,
  },
};

const organizationInputs: Record<CloudAgentManagementPath, unknown> = {
  listChildSessions: { limit: 20, organizationId: ORG_ID },
  getSession: { cloudAgentSessionId: CHILD_ID, organizationId: ORG_ID },
  getMessageResult: {
    cloudAgentSessionId: CHILD_ID,
    messageId: MESSAGE_ID,
    expectedWorktreeId: WORKTREE_ID,
    organizationId: ORG_ID,
  },
  interruptSession: { sessionId: CHILD_ID, organizationId: ORG_ID },
  sendMessageV2: {
    cloudAgentSessionId: CHILD_ID,
    messageId: MESSAGE_ID,
    payload: promptPayload,
    autoCommit: true,
    expectedWorktreeId: WORKTREE_ID,
    organizationId: ORG_ID,
  },
};

const paths = Object.keys(personalInputs) as CloudAgentManagementPath[];

beforeEach(() => {
  getSandboxSessionStubMock.mockReset();
  requireCurrentSessionAccessMock.mockReset();
  requireCurrentSessionAccessMock.mockResolvedValue({
    kiloSessionId: 'ses_12345678901234567890123456',
    organizationId: null,
  });
  getSandboxSessionStubMock.mockImplementation((_env, _owner, sessionId) => {
    if (sessionId === PARENT_ID) return stub();
    return stub({
      getMetadata: vi.fn().mockResolvedValue(metadata(null)),
    });
  });
});

describe('management request against the real shared contract', () => {
  it.each(paths)('accepts the personal Worker path %s', async path => {
    await expect(request(authority(null), path, personalInputs[path])).resolves.toBeUndefined();
  });

  it.each(paths)('accepts the organization Worker path %s', async path => {
    requireCurrentSessionAccessMock.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: ORG_ID,
    });
    getSandboxSessionStubMock.mockImplementation((_env, _owner, sessionId) =>
      sessionId === PARENT_ID
        ? stub()
        : stub({ getMetadata: vi.fn().mockResolvedValue(metadata(ORG_ID)) })
    );

    await expect(
      request(authority(ORG_ID), path, organizationInputs[path])
    ).resolves.toBeUndefined();
  });

  it.each([
    [
      'extra top-level field',
      {
        cloudAgentSessionId: CHILD_ID,
        messageId: MESSAGE_ID,
        extra: true,
      },
    ],
    [
      'extra nested payload field',
      {
        cloudAgentSessionId: CHILD_ID,
        messageId: MESSAGE_ID,
        payload: { ...promptPayload, extra: true },
      },
    ],
    [
      'non-prompt payload',
      {
        cloudAgentSessionId: CHILD_ID,
        messageId: MESSAGE_ID,
        payload: { type: 'command', command: 'status', arguments: '' },
      },
    ],
  ])('rejects %s on sendMessage', async (_name, rawInput) => {
    await expect(request(authority(null), 'sendMessageV2', rawInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('rejects an organization field on a personal authority', async () => {
    await expect(
      request(authority(null), 'getSession', {
        cloudAgentSessionId: CHILD_ID,
        organizationId: ORG_ID,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects a missing organization field on an organization authority', async () => {
    await expect(
      request(authority(ORG_ID), 'getSession', { cloudAgentSessionId: CHILD_ID })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects a mismatched organization field on an organization authority', async () => {
    await expect(
      request(authority(ORG_ID), 'getSession', {
        cloudAgentSessionId: CHILD_ID,
        organizationId: '22222222-2222-4222-8222-222222222222',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
