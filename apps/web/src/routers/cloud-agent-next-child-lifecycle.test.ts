import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { User } from '@kilocode/db/schema';
import type { CloudAgentAuthority } from '@kilocode/worker-utils/cloud-agent-authority';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import { createCallerFactory, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import type * as TrpcInitModule from '@kilocode/web-shared/lib/trpc/init';
import type * as ZodModule from 'zod';

type VerifyResult = { kiloSessionId: string };

const mockListChildSessions = jest.fn<(input: unknown) => Promise<unknown>>();
const mockGetMessageResult = jest.fn<(input: unknown) => Promise<unknown>>();
const mockClient = {
  listChildSessions: mockListChildSessions,
  getMessageResult: mockGetMessageResult,
};
const mockCreateCloudAgentNextClient = jest.fn<(token: string) => typeof mockClient>();
const mockCreateCloudAgentNextClientForModel =
  jest.fn<(token: string, input: unknown) => typeof mockClient>();
const mockRethrowCloudAgentError = jest.fn<(error: unknown) => never>(error => {
  throw error;
});
const mockVerifyUserOwnsSessionV2ByCloudAgentId =
  jest.fn<(db: unknown, userId: string, sessionId: string) => Promise<VerifyResult | null>>();
const mockVerifyOrgOwnsSessionV2ByCloudAgentId =
  jest.fn<
    (
      db: unknown,
      organizationId: string,
      userId: string,
      sessionId: string
    ) => Promise<VerifyResult | null>
  >();
const mockAssertSessionWorktree = jest.fn<(db: unknown, input: unknown) => Promise<void>>();
const mockEnsureOrganizationAccess = jest.fn<
  (ctx: unknown, organizationId: string) => Promise<string>
>(async () => 'member');
const mockCreateControlTokenForRequest = jest.fn<
  (user: User, audience: string, options: unknown) => Promise<{ token: string }>
>(async () => ({ token: 'scoped-worker-token' }));

jest.mock('@/lib/auth/resource-delegation', () => ({
  createControlTokenForRequest: mockCreateControlTokenForRequest,
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: mockCreateCloudAgentNextClient,
  createCloudAgentNextClientForModel: mockCreateCloudAgentNextClientForModel,
  rethrowCloudAgentError: mockRethrowCloudAgentError,
}));

jest.mock('@/lib/cloud-agent/session-ownership', () => ({
  verifyUserOwnsSessionV2ByCloudAgentId: mockVerifyUserOwnsSessionV2ByCloudAgentId,
  verifyOrgOwnsSessionV2ByCloudAgentId: mockVerifyOrgOwnsSessionV2ByCloudAgentId,
}));

jest.mock('@/lib/cloud-agent-next/worktree-review-access', () => ({
  assertSessionWorktree: mockAssertSessionWorktree,
}));

jest.mock('@kilocode/web-shared/routers/organizations/utils', () => {
  const trpcInit = jest.requireActual<typeof TrpcInitModule>('@kilocode/web-shared/lib/trpc/init');
  const z = jest.requireActual<typeof ZodModule>('zod');
  const organizationProcedure = trpcInit.baseProcedure
    .input(z.object({ organizationId: z.uuid() }))
    .use(async ({ ctx, input, next }) => {
      await mockEnsureOrganizationAccess(ctx, input.organizationId);
      return next();
    });

  return {
    ensureOrganizationAccess: mockEnsureOrganizationAccess,
    organizationMemberProcedure: organizationProcedure,
    organizationMemberMutationProcedure: organizationProcedure,
  };
});

async function buildCaller() {
  const { cloudAgentNextRouter } = await import('./cloud-agent-next-router');
  const { organizationCloudAgentNextRouter } =
    await import('./organizations/organization-cloud-agent-next-router');
  return createCallerFactory(
    createTRPCRouter({
      cloudAgentNext: cloudAgentNextRouter,
      organizations: createTRPCRouter({
        cloudAgentNext: organizationCloudAgentNextRouter,
      }),
    })
  );
}

let createCaller: Awaited<ReturnType<typeof buildCaller>>;

const user = { id: 'oauth/child-lifecycle-owner' } as User;
const organizationId = '11111111-1111-4111-8111-111111111111';
const parentSessionId = 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const childSessionId = 'workspace_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const messageId = 'msg_123456789abc123456789ABCDE';
const worktreeId = 'worktree_cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const personalAuthority: CloudAgentAuthority = {
  version: 1,
  ownerId: user.id,
  parentSessionId,
  organizationId: null,
  authorizationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

const organizationAuthority: CloudAgentAuthority = {
  ...personalAuthority,
  organizationId,
};

function callerFor(cloudAgentAuthority?: CloudAgentAuthority) {
  return createCaller({ user, cloudAgentAuthority } as TRPCContext);
}

beforeAll(async () => {
  createCaller = await buildCaller();
});

describe('cloudAgentNext child lifecycle web adapters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateCloudAgentNextClient.mockReturnValue(mockClient);
    mockCreateCloudAgentNextClientForModel.mockReturnValue(mockClient);
    mockVerifyUserOwnsSessionV2ByCloudAgentId.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    mockVerifyOrgOwnsSessionV2ByCloudAgentId.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    mockListChildSessions.mockResolvedValue({
      sessions: [{ cloudAgentSessionId: childSessionId, initialMessageId: messageId, worktreeId }],
      nextCursor: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    });
    mockGetMessageResult.mockResolvedValue({
      cloudAgentSessionId: childSessionId,
      messageId,
      status: 'completed',
      createdAt: 1,
      terminalAt: 2,
      completionSource: 'assistant_message_event',
      assistant: { messageId: 'msg_aaaaaaaaaaaa123456789ABCDE', text: 'terminal text' },
    });
  });

  it('lists personal children with the scoped delegated token and exact page input', async () => {
    await expect(
      callerFor(personalAuthority).cloudAgentNext.listChildSessions({ limit: 5 })
    ).resolves.toEqual({
      sessions: [{ cloudAgentSessionId: childSessionId, initialMessageId: messageId, worktreeId }],
      nextCursor: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    });

    expect(mockCreateControlTokenForRequest).toHaveBeenCalledWith(
      user,
      'cloud-agent-next',
      expect.objectContaining({ tokenSource: 'cloud-agent' })
    );
    expect(mockCreateCloudAgentNextClient).toHaveBeenCalledWith('scoped-worker-token');
    expect(mockListChildSessions).toHaveBeenCalledWith({ limit: 5 });
  });

  it('refuses an unscoped personal child listing without minting a Worker token', async () => {
    await expect(callerFor().cloudAgentNext.listChildSessions({ limit: 5 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
    expect(mockListChildSessions).not.toHaveBeenCalled();
  });

  it('reads a scoped personal result without expectedWorktreeId but keeps ownership mandatory', async () => {
    await expect(
      callerFor(personalAuthority).cloudAgentNext.getMessageResult({
        cloudAgentSessionId: childSessionId,
        messageId,
      })
    ).resolves.toMatchObject({
      status: 'completed',
      createdAt: 1,
      assistant: { text: 'terminal text' },
    });

    expect(mockVerifyUserOwnsSessionV2ByCloudAgentId).toHaveBeenCalledWith(
      expect.anything(),
      user.id,
      childSessionId
    );
    expect(mockGetMessageResult).toHaveBeenCalledWith({
      cloudAgentSessionId: childSessionId,
      messageId,
    });
  });

  it('requires expectedWorktreeId for an ordinary personal result call', async () => {
    await expect(
      callerFor().cloudAgentNext.getMessageResult({
        cloudAgentSessionId: childSessionId,
        messageId,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockVerifyUserOwnsSessionV2ByCloudAgentId).not.toHaveBeenCalled();
    expect(mockGetMessageResult).not.toHaveBeenCalled();
  });

  it('lists organization children pinned to the organization', async () => {
    await expect(
      callerFor(organizationAuthority).organizations.cloudAgentNext.listChildSessions({
        organizationId,
        limit: 10,
      })
    ).resolves.toMatchObject({
      sessions: [{ cloudAgentSessionId: childSessionId }],
    });

    expect(mockEnsureOrganizationAccess).toHaveBeenCalledWith(
      expect.objectContaining({ user }),
      organizationId
    );
    expect(mockListChildSessions).toHaveBeenCalledWith({ organizationId, limit: 10 });
  });

  it('includes organizationId for a scoped organization result', async () => {
    await callerFor(organizationAuthority).organizations.cloudAgentNext.getMessageResult({
      organizationId,
      cloudAgentSessionId: childSessionId,
      messageId,
    });

    expect(mockGetMessageResult).toHaveBeenCalledWith({
      cloudAgentSessionId: childSessionId,
      messageId,
      organizationId,
    });
  });

  it('omits organizationId for an ordinary organization result call', async () => {
    await callerFor().organizations.cloudAgentNext.getMessageResult({
      organizationId,
      cloudAgentSessionId: childSessionId,
      expectedWorktreeId: worktreeId,
      messageId,
    });

    expect(mockGetMessageResult).toHaveBeenCalledWith({
      cloudAgentSessionId: childSessionId,
      messageId,
    });
    expect(mockGetMessageResult.mock.calls[0]?.[0]).not.toHaveProperty('organizationId');
  });

  it('requires expectedWorktreeId for an ordinary organization result call', async () => {
    await expect(
      callerFor().organizations.cloudAgentNext.getMessageResult({
        organizationId,
        cloudAgentSessionId: childSessionId,
        messageId,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockVerifyOrgOwnsSessionV2ByCloudAgentId).not.toHaveBeenCalled();
    expect(mockGetMessageResult).not.toHaveBeenCalled();
  });

  it('rejects a command payload for a scoped personal send before dispatch', async () => {
    await expect(
      callerFor(personalAuthority).cloudAgentNext.sendMessage({
        cloudAgentSessionId: childSessionId,
        messageId,
        payload: { type: 'command', command: 'review', arguments: '' },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockGetMessageResult).not.toHaveBeenCalled();
  });
});
