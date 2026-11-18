import { TRPCError } from '@trpc/server';
import type { CloudAgentAuthority } from '@kilocode/worker-utils/cloud-agent-authority';
import type * as CloudAgentAuthorityModule from '@kilocode/worker-utils/cloud-agent-authority';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertCloudAgentChildTarget,
  assertCloudAgentManagementRequest,
  listCloudAgentChildSessions,
} from './cloud-agent-child-management.js';

const {
  cloudAgentAuthorityProceduresMock,
  cloudAgentAuthorityProcedureKindMock,
  validateCloudAgentAuthorityRequestMock,
  getSandboxSessionStubMock,
  requireCurrentSessionAccessMock,
} = vi.hoisted(() => ({
  cloudAgentAuthorityProceduresMock: vi.fn(),
  cloudAgentAuthorityProcedureKindMock: vi.fn(),
  validateCloudAgentAuthorityRequestMock: vi.fn(),
  getSandboxSessionStubMock: vi.fn(),
  requireCurrentSessionAccessMock: vi.fn(),
}));

vi.mock('@kilocode/worker-utils/cloud-agent-authority', async importOriginal => ({
  ...(await importOriginal<typeof CloudAgentAuthorityModule>()),
  cloudAgentAuthorityProcedures: cloudAgentAuthorityProceduresMock,
  cloudAgentAuthorityProcedureKind: cloudAgentAuthorityProcedureKindMock,
  validateCloudAgentAuthorityRequest: validateCloudAgentAuthorityRequestMock,
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

const USER_ID = 'user_1';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PARENT_ID = 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHILD_ID = 'workspace_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WORKTREE_ID = 'worktree_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function authority(overrides: Partial<CloudAgentAuthority> = {}): CloudAgentAuthority {
  return {
    version: 1,
    ownerId: USER_ID,
    parentSessionId: PARENT_ID,
    organizationId: null,
    authorizationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function managementRequest(
  input: Omit<Parameters<typeof assertCloudAgentManagementRequest>[0], 'userId' | 'authToken'> & {
    userId?: string;
    authToken?: string;
  }
) {
  return assertCloudAgentManagementRequest({
    userId: USER_ID,
    authToken: 'management-token',
    ...input,
  });
}

type Stub = {
  assertCloudAgentManagementAuthority: ReturnType<typeof vi.fn>;
  getMetadata: ReturnType<typeof vi.fn>;
  listCloudAgentChildSessions: ReturnType<typeof vi.fn>;
};

function stub(overrides: Partial<Stub> = {}): Stub {
  return {
    assertCloudAgentManagementAuthority: vi.fn().mockResolvedValue(undefined),
    getMetadata: vi.fn().mockResolvedValue(null),
    listCloudAgentChildSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    ...overrides,
  };
}

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    identity: { sessionId: CHILD_ID, userId: USER_ID, orgId: null },
    parentCloudAgentSessionId: PARENT_ID,
    initialMessage: { id: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn' },
    workspace: { worktreeId: WORKTREE_ID },
    ...overrides,
  };
}

function mockDirectChild(metadataValue: unknown = metadata()): Stub {
  const child = stub({ getMetadata: vi.fn().mockResolvedValue(metadataValue) });
  getSandboxSessionStubMock.mockImplementation((_env, _owner, sessionId) =>
    sessionId === PARENT_ID ? stub() : child
  );
  return child;
}

function expectForbidden(promise: Promise<unknown>): Promise<void> {
  return expect(promise).rejects.toMatchObject({ code: 'FORBIDDEN' });
}

beforeEach(() => {
  vi.clearAllMocks();
  cloudAgentAuthorityProceduresMock.mockReset();
  cloudAgentAuthorityProcedureKindMock.mockReset();
  validateCloudAgentAuthorityRequestMock.mockReset();
  getSandboxSessionStubMock.mockReset();
  requireCurrentSessionAccessMock.mockReset();
  requireCurrentSessionAccessMock.mockResolvedValue({});
  cloudAgentAuthorityProceduresMock.mockImplementation((scoped: CloudAgentAuthority) =>
    scoped.organizationId === null
      ? [
          'cloudAgentNext.listChildSessions',
          'cloudAgentNext.getSession',
          'cloudAgentNext.getMessageResult',
          'cloudAgentNext.interruptSession',
          'cloudAgentNext.sendMessage',
        ]
      : [
          'organizations.cloudAgentNext.listChildSessions',
          'organizations.cloudAgentNext.getSession',
          'organizations.cloudAgentNext.getMessageResult',
          'organizations.cloudAgentNext.interruptSession',
          'organizations.cloudAgentNext.sendMessage',
        ]
  );
  cloudAgentAuthorityProcedureKindMock.mockImplementation(
    (procedure: string): 'query' | 'mutation' =>
      procedure.endsWith('.sendMessage') || procedure.endsWith('.interruptSession')
        ? 'mutation'
        : 'query'
  );
});

describe('assertCloudAgentManagementRequest', () => {
  it('rejects a context user that does not match the authority owner', async () => {
    await expectForbidden(
      managementRequest({
        env: {} as never,
        authority: authority(),
        userId: 'other-user',
        path: 'getSession',
        rawInput: { cloudAgentSessionId: CHILD_ID },
      })
    );
    expect(getSandboxSessionStubMock).not.toHaveBeenCalled();
  });

  it('rejects a missing authenticated token', async () => {
    await expectForbidden(
      managementRequest({
        env: {} as never,
        authority: authority(),
        authToken: undefined,
        path: 'getSession',
        rawInput: { cloudAgentSessionId: CHILD_ID },
      })
    );
    expect(getSandboxSessionStubMock).not.toHaveBeenCalled();
  });

  it.each([
    ['updateSession', 'query'],
    ['sendMessage', 'mutation'],
    ['health', 'query'],
  ] as const)('rejects a non-management Worker path (%s)', async (path, kind) => {
    cloudAgentAuthorityProcedureKindMock.mockReturnValue(kind);
    await expectForbidden(
      managementRequest({
        env: {} as never,
        authority: authority(),
        path,
        rawInput: {},
      })
    );
    expect(getSandboxSessionStubMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown procedure denied by the shared contract before parent access', async () => {
    cloudAgentAuthorityProceduresMock.mockReturnValue([]);
    validateCloudAgentAuthorityRequestMock.mockImplementation(() => {
      throw new Error('unknown procedure');
    });
    await expectForbidden(
      managementRequest({
        env: {} as never,
        authority: authority(),
        path: 'getSession',
        rawInput: { cloudAgentSessionId: CHILD_ID },
      })
    );
    expect(getSandboxSessionStubMock).not.toHaveBeenCalled();
  });

  it('rejects unknown input fields before parent access', async () => {
    validateCloudAgentAuthorityRequestMock.mockImplementation(() => {
      throw new Error('unexpected field');
    });
    await expectForbidden(
      managementRequest({
        env: {} as never,
        authority: authority(),
        path: 'getSession',
        rawInput: { cloudAgentSessionId: CHILD_ID, extra: true },
      })
    );
    expect(getSandboxSessionStubMock).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', () => Promise.reject(new Error('Cloud Agent parent authority denied'))],
    ['revoked', () => Promise.reject(new Error('Cloud Agent parent authority denied'))],
    ['expired', () => Promise.reject(new Error('Cloud Agent parent authority denied'))],
    ['replaced', () => Promise.reject(new Error('Cloud Agent parent authority denied'))],
  ])('rejects a %s parent authority', async (_name, reject) => {
    const parent = stub({ assertCloudAgentManagementAuthority: vi.fn(reject) });
    mockDirectChild();
    getSandboxSessionStubMock.mockImplementation((_env, _owner, sessionId) =>
      sessionId === PARENT_ID
        ? parent
        : stub({ getMetadata: vi.fn().mockResolvedValue(metadata()) })
    );
    await expectForbidden(
      managementRequest({
        env: {} as never,
        authority: authority(),
        path: 'getSession',
        rawInput: { cloudAgentSessionId: CHILD_ID },
      })
    );
  });

  it('maps a transient parent lookup failure to SERVICE_UNAVAILABLE', async () => {
    const parent = stub({
      assertCloudAgentManagementAuthority: vi.fn().mockRejectedValue(new Error('network down')),
    });
    getSandboxSessionStubMock.mockImplementation((_env, _owner, sessionId) =>
      sessionId === PARENT_ID ? parent : stub()
    );
    await expect(
      managementRequest({
        env: {} as never,
        authority: authority(),
        path: 'getSession',
        rawInput: { cloudAgentSessionId: CHILD_ID },
      })
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('rejects the parent session as its own target', async () => {
    mockDirectChild();
    await expectForbidden(
      managementRequest({
        env: {} as never,
        authority: authority(),
        path: 'getSession',
        rawInput: { cloudAgentSessionId: PARENT_ID },
      })
    );
    expect(requireCurrentSessionAccessMock).not.toHaveBeenCalled();
  });

  it('rejects a target the current user cannot access', async () => {
    mockDirectChild();
    requireCurrentSessionAccessMock.mockRejectedValue(
      new TRPCError({ code: 'FORBIDDEN', message: 'No access' })
    );
    await expectForbidden(
      managementRequest({
        env: {} as never,
        authority: authority(),
        path: 'getSession',
        rawInput: { cloudAgentSessionId: CHILD_ID },
      })
    );
  });

  it.each([
    [
      'foreign owner',
      metadata({ identity: { sessionId: CHILD_ID, userId: 'other', orgId: null } }),
    ],
    [
      'foreign org',
      metadata({ identity: { sessionId: CHILD_ID, userId: USER_ID, orgId: ORG_ID } }),
    ],
    ['unrelated or sibling', metadata({ parentCloudAgentSessionId: PARENT_ID.replace('a', 'd') })],
    ['missing lineage', metadata({ parentCloudAgentSessionId: undefined })],
    [
      'self identity',
      metadata({ identity: { sessionId: PARENT_ID, userId: USER_ID, orgId: null } }),
    ],
  ])('rejects a %s target', async (_name, childMetadata) => {
    mockDirectChild(childMetadata);
    await expectForbidden(
      managementRequest({
        env: {} as never,
        authority: authority(),
        path: 'getSession',
        rawInput: { cloudAgentSessionId: CHILD_ID },
      })
    );
  });

  it('rejects a target whose current worktree does not match the expected worktree', async () => {
    mockDirectChild();
    await expectForbidden(
      managementRequest({
        env: {} as never,
        authority: authority(),
        path: 'getMessageResult',
        rawInput: {
          cloudAgentSessionId: CHILD_ID,
          messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
          expectedWorktreeId: 'worktree_dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        },
      })
    );
  });

  it('accepts a direct child and pins organization procedures to the exact organization', async () => {
    mockDirectChild(
      metadata({ identity: { sessionId: CHILD_ID, userId: USER_ID, orgId: ORG_ID } })
    );
    await expect(
      managementRequest({
        env: {} as never,
        authority: authority({ organizationId: ORG_ID }),
        path: 'sendMessageV2',
        rawInput: {
          cloudAgentSessionId: CHILD_ID,
          messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
          payload: { type: 'prompt', prompt: 'follow up', mode: 'code', model: 'test/model' },
          organizationId: ORG_ID,
        },
      })
    ).resolves.toBeUndefined();
    expect(validateCloudAgentAuthorityRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_ID }),
      'organizations.cloudAgentNext.sendMessage',
      expect.objectContaining({ cloudAgentSessionId: CHILD_ID })
    );
    expect(requireCurrentSessionAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedOrganizationId: ORG_ID })
    );
  });

  it('accepts a lineage-valid child that is absent from the durable registry', async () => {
    mockDirectChild();
    await expect(
      assertCloudAgentChildTarget({
        env: {} as never,
        authority: authority(),
        childSessionId: CHILD_ID,
      })
    ).resolves.toMatchObject({ parentCloudAgentSessionId: PARENT_ID });
    expect(getSandboxSessionStubMock).toHaveBeenCalledWith(expect.anything(), USER_ID, CHILD_ID);
  });
});

describe('listCloudAgentChildSessions', () => {
  it('pages a registry hint but filters entries that no longer authorize', async () => {
    const parent = stub({
      listCloudAgentChildSessions: vi.fn().mockResolvedValue({
        sessions: [
          { cloudAgentSessionId: CHILD_ID },
          { cloudAgentSessionId: 'workspace_dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
        ],
        nextCursor: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      }),
    });
    getSandboxSessionStubMock.mockImplementation((_env, _owner, sessionId) =>
      sessionId === PARENT_ID
        ? parent
        : stub({
            getMetadata: vi.fn().mockImplementation(async () =>
              sessionId === CHILD_ID
                ? metadata()
                : metadata({
                    identity: { sessionId: sessionId, userId: USER_ID, orgId: null },
                    parentCloudAgentSessionId: 'workspace_ffffffff-ffff-4fff-8fff-ffffffffffff',
                  })
            ),
          })
    );
    await expect(
      listCloudAgentChildSessions({
        env: {} as never,
        authority: authority(),
        limit: 20,
      })
    ).resolves.toEqual({
      sessions: [
        {
          cloudAgentSessionId: CHILD_ID,
          initialMessageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
          worktreeId: WORKTREE_ID,
        },
      ],
      nextCursor: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    });
    expect(parent.listCloudAgentChildSessions).toHaveBeenCalledWith({ limit: 20 });
  });

  it('propagates a database service outage instead of returning an empty page', async () => {
    const parent = stub({
      listCloudAgentChildSessions: vi.fn().mockResolvedValue({
        sessions: [{ cloudAgentSessionId: CHILD_ID }],
      }),
    });
    getSandboxSessionStubMock.mockImplementation((_env, _owner, sessionId) =>
      sessionId === PARENT_ID ? parent : stub()
    );
    requireCurrentSessionAccessMock.mockRejectedValue(
      new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Database unavailable' })
    );
    await expect(
      listCloudAgentChildSessions({
        env: {} as never,
        authority: authority(),
        limit: 20,
      })
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('propagates a child metadata outage instead of returning an empty page', async () => {
    const parent = stub({
      listCloudAgentChildSessions: vi.fn().mockResolvedValue({
        sessions: [{ cloudAgentSessionId: CHILD_ID }],
      }),
    });
    getSandboxSessionStubMock.mockImplementation((_env, _owner, sessionId) =>
      sessionId === PARENT_ID
        ? parent
        : stub({
            getMetadata: vi.fn().mockRejectedValue(new Error('Durable Object unavailable')),
          })
    );
    await expect(
      listCloudAgentChildSessions({
        env: {} as never,
        authority: authority(),
        limit: 20,
      })
    ).rejects.toThrow('Durable Object unavailable');
  });
});
