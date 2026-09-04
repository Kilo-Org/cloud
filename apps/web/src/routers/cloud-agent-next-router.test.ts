import { describe, expect, it, jest, beforeAll, beforeEach } from '@jest/globals';
import { cli_sessions_v2, organizations, type User } from '@kilocode/db/schema';
import type { createWorktreeChat as CreateWorktreeChat } from '@/lib/cloud-agent-next/worktree-chat';
import type { CloudAgentNextClient } from '@/lib/cloud-agent-next/cloud-agent-client';
import type * as MinimumVersionModule from '@/lib/trpc/min-version';
import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type * as SessionOwnership from '@/lib/cloud-agent/session-ownership';
import type {
  GetWorktreeChangesOutput,
  GetWorktreeFileOutput,
  RefreshWorktreeChangesOutput,
  WorktreeFileQuery,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import type { z } from 'zod';
import type {
  personalPrepareSessionNextSchema,
  SandboxStatusSnapshot,
} from '@/routers/cloud-agent-next-schemas';
import { TRPCError } from '@trpc/server';
import type { verifyUserOwnsSessionV2ByCloudAgentId } from '@/lib/cloud-agent/session-ownership';

type AttachmentReference = { path: string; files: string[] };

const mockPrepareSession = jest.fn<
  (input: {
    githubRepo?: string;
    devcontainer?: boolean;
    attachments?: AttachmentReference;
  }) => Promise<{
    cloudAgentSessionId: string;
    kiloSessionId: string;
  }>
>();

const mockSendMessage = jest.fn<
  (input: { attachments?: AttachmentReference }) => Promise<{
    cloudAgentSessionId: string;
    status: 'started';
    streamUrl: string;
    messageId: string;
    delivery: 'sent';
  }>
>(() =>
  Promise.resolve({
    cloudAgentSessionId: 'agent_123',
    status: 'started',
    streamUrl: '/stream',
    messageId: 'msg_123456789abc123456789ABCDE',
    delivery: 'sent',
  })
);
const mockGenerateCloudAgentAttachmentUploadUrl = jest.fn<
  (input: {
    userId: string;
    messageUuid: string;
    attachmentId: string;
    contentType: string;
    contentLength: number;
  }) => Promise<{ signedUrl: string; key: string; expiresAt: string }>
>(() => Promise.resolve({ signedUrl: 'signed', key: 'key', expiresAt: 'expires' }));

const mockGenerateCloudAgentAttachmentDownloadUrl = jest.fn<
  (input: { userId: string; messageUuid: string; filename: string }) => Promise<{
    signedUrl: string;
    key: string;
    expiresAt: string;
  }>
>(() => Promise.resolve({ signedUrl: 'signed', key: 'key', expiresAt: 'expires' }));

const mockGetSession = jest.fn<(cloudAgentSessionId: string) => Promise<{ model?: string }>>();
const mockGetMessageResult = jest.fn<CloudAgentNextClient['getMessageResult']>();
const mockCreateWorktreeChat = jest.fn<typeof CreateWorktreeChat>();

const mockCancelQueuedMessage =
  jest.fn<(input: { sessionId: string; messageId: string }) => Promise<{ dropped: boolean }>>();
const mockGetSandboxStatus =
  jest.fn<(cloudAgentSessionId: string) => Promise<SandboxStatusSnapshot>>();
const mockGetWorktreeChanges =
  jest.fn<(cloudAgentSessionId: string) => Promise<GetWorktreeChangesOutput>>();
const mockRefreshWorktreeChanges =
  jest.fn<(cloudAgentSessionId: string) => Promise<RefreshWorktreeChangesOutput>>();
const mockGetWorktreeFile =
  jest.fn<
    (input: WorktreeFileQuery & { cloudAgentSessionId: string }) => Promise<GetWorktreeFileOutput>
  >();

const mockCreateCloudAgentNextClient = jest.fn((_authToken: string) => ({
  prepareSession: mockPrepareSession,
  sendMessage: mockSendMessage,
  getSession: mockGetSession,
  getMessageResult: mockGetMessageResult,
  cancelQueuedMessage: mockCancelQueuedMessage,
  getSandboxStatus: mockGetSandboxStatus,
  getWorktreeChanges: mockGetWorktreeChanges,
  refreshWorktreeChanges: mockRefreshWorktreeChanges,
  getWorktreeFile: mockGetWorktreeFile,
}));

const mockCreateCloudAgentNextClientForModel = jest.fn(
  (_authToken: string, _eligibility: unknown) => ({
    prepareSession: mockPrepareSession,
    sendMessage: mockSendMessage,
  })
);

const mockComputeCloudAgentNextBalanceCheckEligibility = jest.fn<
  (...args: unknown[]) => Promise<{
    isFree: boolean;
    hasUserByokAvailable: boolean;
  }>
>();

const mockIsFeatureFlagEnabledOrDevelopment =
  jest.fn<(flagName: string, distinctId: string) => Promise<boolean>>();
const mockVerifyUserOwnsSessionV2ByCloudAgentId =
  jest.fn<typeof verifyUserOwnsSessionV2ByCloudAgentId>();
const mockGetBalanceForUser = jest.fn<(user: User) => Promise<{ balance: number }>>();
const mockFetchGitHubRepositoriesForUser = jest.fn<
  (
    userId: string,
    forceRefresh: boolean
  ) => Promise<{
    repositories: unknown[];
    integrationInstalled: boolean;
    syncedAt: null;
  }>
>();
const mockFetchGitLabRepositoriesForUser = jest.fn<
  (
    userId: string,
    forceRefresh: boolean
  ) => Promise<{
    repositories: unknown[];
    integrationInstalled: boolean;
    syncedAt: null;
    instanceUrl?: string;
  }>
>();
const mockOrderRepositoriesByUsage =
  jest.fn<
    <T extends { fullName: string }>(params: {
      userId: string;
      organizationId: string | null;
      platform: 'github' | 'gitlab' | 'bitbucket';
      repositories: T[];
      gitlabInstanceUrl?: string;
    }) => Promise<T[]>
  >();

jest.mock('@/lib/tokens', () => ({
  generateCloudAgentToken: jest.fn(() => 'cloud-agent-token'),
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: mockCreateCloudAgentNextClient,
  createCloudAgentNextClientForModel: mockCreateCloudAgentNextClientForModel,
  rethrowAsPaymentRequired: jest.fn(),
}));

jest.mock('@/lib/cloud-agent-next/worktree-chat', () => ({
  createWorktreeChat: mockCreateWorktreeChat,
}));

jest.mock('@/lib/trpc/min-version', () => ({
  ...jest.requireActual<typeof MinimumVersionModule>('@/lib/trpc/min-version'),
  getMinimumVersions: jest.fn(async () => ({ ios: '0.0.0', android: '0.0.0' })),
  enforceMinimumVersion: jest.fn(() => ({ pass: true })),
}));

jest.mock('@/lib/cloud-agent-next/balance-check-eligibility', () => ({
  computeCloudAgentNextBalanceCheckEligibility: mockComputeCloudAgentNextBalanceCheckEligibility,
}));

jest.mock('@/lib/posthog-feature-flags', () => ({
  isFeatureFlagEnabledOrDevelopment: mockIsFeatureFlagEnabledOrDevelopment,
}));

jest.mock('@/lib/user/balance', () => ({
  getBalanceForUser: mockGetBalanceForUser,
}));

jest.mock('@/lib/cloud-agent/github-integration-helpers', () => ({
  fetchGitHubRepositoriesForUser: mockFetchGitHubRepositoriesForUser,
}));

jest.mock('@/lib/cloud-agent/gitlab-integration-helpers', () => ({
  buildGitLabCloneUrl: jest.fn(),
  fetchGitLabRepositoriesForUser: mockFetchGitLabRepositoriesForUser,
  getGitLabInstanceUrlForUser: jest.fn(),
}));

jest.mock('@/lib/cloud-agent/order-repositories', () => ({
  orderRepositoriesByUsage: mockOrderRepositoriesByUsage,
}));

jest.mock('@/lib/r2/cloud-agent-attachments', () => ({
  generateImageUploadUrl: jest.fn(),
  generateCloudAgentAttachmentUploadUrl: mockGenerateCloudAgentAttachmentUploadUrl,
  generateCloudAgentAttachmentDownloadUrl: mockGenerateCloudAgentAttachmentDownloadUrl,
}));

jest.mock('@/lib/cloud-agent/session-ownership', () => ({
  verifyUserOwnsSessionV2ByCloudAgentId: mockVerifyUserOwnsSessionV2ByCloudAgentId,
}));

let createCaller: (ctx: { user: User; headersList?: Headers }) => {
  prepareSession: (input: z.infer<typeof personalPrepareSessionNextSchema>) => Promise<{
    cloudAgentSessionId: string;
    kiloSessionId: string;
  }>;
  createWorktreeChat: (input: { sourceKiloSessionId: string; operationKey: string }) => Promise<{
    kiloSessionId: string;
    cloudAgentSessionId: string;
    worktreeId: string;
    replayed?: boolean;
  }>;
  getMessageResult: (input: {
    cloudAgentSessionId: string;
    expectedWorktreeId: `worktree_${string}`;
    messageId: string;
  }) => ReturnType<CloudAgentNextClient['getMessageResult']>;
  sendMessage: (input: {
    cloudAgentSessionId: string;
    expectedWorktreeId?: `worktree_${string}`;
    messageId?: string;
    payload:
      | { type: 'prompt'; prompt: string; mode: string; model: string }
      | { type: 'command'; command: string; arguments: string };
    attachments?: { path: string; files: string[] };
    images?: { path: string; files: string[] };
  }) => Promise<unknown>;
  getAttachmentUploadUrl: (input: {
    messageUuid: string;
    attachmentId: string;
    contentType: 'application/pdf';
    contentLength: number;
  }) => Promise<unknown>;
  getAttachmentDownloadUrl: (input: { messageUuid: string; filename: string }) => Promise<unknown>;
  cancelQueuedMessage: (input: { sessionId: string; messageId: string }) => Promise<unknown>;
  getSandboxStatus: (input: { cloudAgentSessionId: string }) => Promise<SandboxStatusSnapshot>;
  getWorktreeChanges: (input: { cloudAgentSessionId: string }) => Promise<GetWorktreeChangesOutput>;
  getWorktreeFile: (
    input: WorktreeFileQuery & { cloudAgentSessionId: string }
  ) => Promise<GetWorktreeFileOutput>;
  refreshWorktreeChanges: (input: {
    cloudAgentSessionId: string;
  }) => Promise<RefreshWorktreeChangesOutput>;
  checkEligibility: () => Promise<{
    balance: number;
    minBalance: number;
    isEligible: boolean;
    accessLevel: 'full' | 'limited' | 'blocked';
  }>;
  listGitHubRepositories: (input: { forceRefresh: boolean }) => Promise<unknown>;
  listGitLabRepositories: (input: { forceRefresh: boolean }) => Promise<unknown>;
};

beforeAll(async () => {
  const { createCallerFactory } = await import('@/lib/trpc/init');
  const mod = await import('./cloud-agent-next-router');
  createCaller = createCallerFactory(mod.cloudAgentNextRouter);
});

describe('cloudAgentNextRouter worktree changes access', () => {
  const personalSessionId = 'workspace_12345678-1234-4234-9234-123456789abc';
  const orgSessionId = 'workspace_12345678-1234-4234-9234-123456789abd';
  const worktreeId = 'worktree_12345678-1234-4234-9234-123456789abc';
  const reviewMessageId = 'msg_123456789abc123456789ABCDE';
  let owner: User;
  let otherUser: User;

  beforeAll(async () => {
    owner = await insertTestUser({ id: 'oauth/worktree-personal-owner' });
    otherUser = await insertTestUser();
    const [organization] = await db
      .insert(organizations)
      .values({
        name: 'Personal changes scope test',
        created_by_kilo_user_id: owner.id,
      })
      .returning();
    await db.insert(cli_sessions_v2).values([
      {
        session_id: 'ses_changes_personal',
        cloud_agent_session_id: personalSessionId,
        cloud_agent_worktree_id: worktreeId,
        kilo_user_id: owner.id,
        created_on_platform: 'cloud-agent-web',
      },
      {
        session_id: 'ses_changes_personal_org',
        cloud_agent_session_id: orgSessionId,
        organization_id: organization.id,
        kilo_user_id: owner.id,
        created_on_platform: 'cloud-agent-web',
      },
    ]);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyUserOwnsSessionV2ByCloudAgentId.mockImplementation(
      jest.requireActual<typeof SessionOwnership>('@/lib/cloud-agent/session-ownership')
        .verifyUserOwnsSessionV2ByCloudAgentId
    );
    mockGetWorktreeChanges.mockResolvedValue({ snapshot: null });
    mockRefreshWorktreeChanges.mockResolvedValue({ status: 'offline', snapshot: null });
    mockGetWorktreeFile.mockResolvedValue({ status: 'not_captured' });
  });

  describe.each(['sendMessage', 'getMessageResult'] as const)('review %s', procedure => {
    const payload = {
      type: 'prompt' as const,
      prompt: 'Review feedback',
      mode: 'code',
      model: 'model/target',
    };
    function call(
      user: User,
      cloudAgentSessionId = personalSessionId,
      expectedWorktreeId: `worktree_${string}` = worktreeId
    ) {
      const caller = createCaller({ user });
      const input = { cloudAgentSessionId, expectedWorktreeId, messageId: reviewMessageId };
      return procedure === 'sendMessage'
        ? caller.sendMessage({ ...input, payload })
        : caller.getMessageResult(input);
    }

    beforeEach(() => {
      mockGetMessageResult.mockResolvedValue({
        cloudAgentSessionId: personalSessionId,
        messageId: reviewMessageId,
        status: 'completed',
        acceptedAt: 1,
      });
      mockComputeCloudAgentNextBalanceCheckEligibility.mockResolvedValue({
        isFree: false,
        hasUserByokAvailable: false,
      });
    });

    it('checks the exact worktree and keeps its guard out of the Worker payload', async () => {
      await call(owner);
      if (procedure === 'sendMessage') {
        expect(mockSendMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            cloudAgentSessionId: personalSessionId,
            payload,
            messageId: reviewMessageId,
          })
        );
        expect(mockSendMessage.mock.calls[0]?.[0]).not.toHaveProperty('expectedWorktreeId');
        expect(mockComputeCloudAgentNextBalanceCheckEligibility).toHaveBeenCalledWith(
          expect.objectContaining({ user: owner, modelId: payload.model })
        );
      } else {
        expect(mockGetMessageResult).toHaveBeenCalledWith({
          cloudAgentSessionId: personalSessionId,
          messageId: reviewMessageId,
        });
        expect(mockComputeCloudAgentNextBalanceCheckEligibility).not.toHaveBeenCalled();
        expect(mockSendMessage).not.toHaveBeenCalled();
      }
    });

    it('rejects the wrong worktree before any Worker call', async () => {
      await expect(
        call(owner, personalSessionId, 'worktree_22345678-1234-4234-9234-123456789abc')
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
      expect(mockCreateCloudAgentNextClientForModel).not.toHaveBeenCalled();
    });

    it('denies other owners and cross-organization targets', async () => {
      await expect(call(otherUser)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(call(owner, orgSessionId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockGetMessageResult).not.toHaveBeenCalled();
    });

    it('rejects missing targets and non-control-plane references', async () => {
      await expect(
        call(owner, 'workspace_22345678-1234-4234-9234-123456789abc')
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(call(owner, 'agent_12345678-1234-4234-9234-123456789abc')).rejects.toMatchObject(
        { code: 'BAD_REQUEST' }
      );
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockGetMessageResult).not.toHaveBeenCalled();
    });
  });

  it('bounds follow-up prompts on the server', async () => {
    await expect(
      createCaller({ user: owner }).sendMessage({
        cloudAgentSessionId: personalSessionId,
        expectedWorktreeId: worktreeId,
        payload: {
          type: 'prompt',
          prompt: 'a'.repeat(100_001),
          mode: 'code',
          model: 'model/target',
        },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockVerifyUserOwnsSessionV2ByCloudAgentId).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('rechecks ownership after a saved-file session is deleted', async () => {
    const cloudAgentSessionId = 'workspace_12345678-1234-4234-9234-123456789abf';
    await db.insert(cli_sessions_v2).values({
      session_id: 'ses_changes_personal_deleted',
      cloud_agent_session_id: cloudAgentSessionId,
      kilo_user_id: owner.id,
      created_on_platform: 'cloud-agent-web',
    });
    const input = { cloudAgentSessionId, path: 'file.ts', expectedRevision: 1 };
    await expect(createCaller({ user: owner }).getWorktreeFile(input)).resolves.toEqual({
      status: 'not_captured',
    });
    await db
      .delete(cli_sessions_v2)
      .where(eq(cli_sessions_v2.cloud_agent_session_id, cloudAgentSessionId));
    mockCreateCloudAgentNextClient.mockClear();
    await expect(createCaller({ user: owner }).getWorktreeFile(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
  });

  describe.each(['getWorktreeChanges', 'refreshWorktreeChanges', 'getWorktreeFile'] as const)(
    '%s',
    procedure => {
      function call(user: User, cloudAgentSessionId: string) {
        const caller = createCaller({ user });
        return procedure === 'getWorktreeFile'
          ? caller.getWorktreeFile({
              cloudAgentSessionId,
              path: 'src/exact\nfile.ts',
              expectedRevision: 7,
            })
          : caller[procedure]({ cloudAgentSessionId });
      }

      it('allows the creator in personal scope without model or rollout gates', async () => {
        const result = await call(owner, personalSessionId);
        expect(result).toEqual(
          procedure === 'getWorktreeFile'
            ? { status: 'not_captured' }
            : procedure === 'getWorktreeChanges'
              ? { snapshot: null }
              : { status: 'offline', snapshot: null }
        );
        if (procedure === 'getWorktreeFile') {
          expect(mockGetWorktreeFile).toHaveBeenCalledWith({
            cloudAgentSessionId: personalSessionId,
            path: 'src/exact\nfile.ts',
            expectedRevision: 7,
          });
        }
        expect(mockComputeCloudAgentNextBalanceCheckEligibility).not.toHaveBeenCalled();
        expect(mockGetBalanceForUser).not.toHaveBeenCalled();
        expect(mockIsFeatureFlagEnabledOrDevelopment).not.toHaveBeenCalled();
      });

      it('denies another creator before constructing a Worker client', async () => {
        await expect(call(otherUser, personalSessionId)).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
      });

      it('denies the same creator accessing an organization session through personal scope', async () => {
        await expect(call(owner, orgSessionId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
      });

      it('denies a missing session before constructing a Worker client', async () => {
        await expect(
          call(owner, 'workspace_12345678-1234-4234-9234-123456789abe')
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
      });

      it.each(['agent_12345678-1234-4234-9234-123456789abc', 'ses_12345678901234567890123456'])(
        'rejects legacy ID %s before ownership or Worker calls',
        async cloudAgentSessionId => {
          await expect(call(owner, cloudAgentSessionId)).rejects.toMatchObject({
            code: 'BAD_REQUEST',
          });
          expect(mockVerifyUserOwnsSessionV2ByCloudAgentId).not.toHaveBeenCalled();
          expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
        }
      );
    }
  );
});

describe('cloudAgentNextRouter attachment forwarding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyUserOwnsSessionV2ByCloudAgentId.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    mockComputeCloudAgentNextBalanceCheckEligibility.mockResolvedValue({
      isFree: false,
      hasUserByokAvailable: false,
    });
    mockGetSession.mockResolvedValue({ model: 'kilo/paid-model' });
  });

  it('denies a session the authenticated user does not own before calling the Worker', async () => {
    mockVerifyUserOwnsSessionV2ByCloudAgentId.mockResolvedValueOnce(null);
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    await expect(
      caller.sendMessage({
        cloudAgentSessionId: 'agent_123',
        payload: { type: 'prompt', prompt: 'Read PDF', mode: 'code', model: 'test' },
      })
    ).rejects.toThrow('Session not found or access denied');

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('forwards canonical document attachments when sending a message', async () => {
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });
    const attachments = {
      path: '12345678-1234-4234-9234-123456789abc',
      files: ['87654321-4321-4321-8321-cba987654321.pdf'],
    };

    await caller.sendMessage({
      cloudAgentSessionId: 'agent_123',
      payload: { type: 'prompt', prompt: 'Read PDF', mode: 'code', model: 'test' },
      attachments,
    });

    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({ attachments }));
  });

  it('normalizes legacy image requests to canonical Worker attachments', async () => {
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });
    const images = {
      path: '12345678-1234-4234-9234-123456789abc',
      files: ['87654321-4321-4321-8321-cba987654321.png'],
    };

    await caller.sendMessage({
      cloudAgentSessionId: 'agent_123',
      payload: { type: 'prompt', prompt: 'Read image', mode: 'code', model: 'test' },
      images,
    });

    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({ attachments: images }));
    expect(mockSendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ images }));
  });

  it('routes free follow-up prompt models through the balance-skip client', async () => {
    mockComputeCloudAgentNextBalanceCheckEligibility.mockResolvedValueOnce({
      isFree: true,
      hasUserByokAvailable: false,
    });
    const caller = createCaller({ user: { id: 'user-free', is_admin: false } as User });

    await caller.sendMessage({
      cloudAgentSessionId: 'agent_123',
      payload: {
        type: 'prompt',
        prompt: 'Follow up on this',
        mode: 'code',
        model: 'kilo/free-model',
      },
    });

    expect(mockComputeCloudAgentNextBalanceCheckEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'kilo/free-model' })
    );
    expect(mockCreateCloudAgentNextClientForModel).toHaveBeenCalledWith('cloud-agent-token', {
      isFree: true,
      hasUserByokAvailable: false,
    });
    expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
  });

  it('routes free follow-up command turns through the balance-skip client using the session model', async () => {
    mockGetSession.mockResolvedValueOnce({ model: 'kilo/free-model' });
    mockComputeCloudAgentNextBalanceCheckEligibility.mockResolvedValueOnce({
      isFree: true,
      hasUserByokAvailable: false,
    });
    const caller = createCaller({ user: { id: 'user-free', is_admin: false } as User });

    await caller.sendMessage({
      cloudAgentSessionId: 'agent_123',
      payload: { type: 'command', command: 'review', arguments: '' },
    });

    expect(mockGetSession).toHaveBeenCalledWith('agent_123');
    expect(mockComputeCloudAgentNextBalanceCheckEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'kilo/free-model' })
    );
    expect(mockCreateCloudAgentNextClientForModel).toHaveBeenCalledWith('cloud-agent-token', {
      isFree: true,
      hasUserByokAvailable: false,
    });
  });

  it('keeps the balance check for command turns on paid sessions', async () => {
    mockGetSession.mockResolvedValueOnce({ model: 'kilo/paid-model' });
    const caller = createCaller({ user: { id: 'user-paid', is_admin: false } as User });

    await caller.sendMessage({
      cloudAgentSessionId: 'agent_123',
      payload: { type: 'command', command: 'review', arguments: '' },
    });

    expect(mockGetSession).toHaveBeenCalledWith('agent_123');
    expect(mockComputeCloudAgentNextBalanceCheckEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'kilo/paid-model' })
    );
    expect(mockCreateCloudAgentNextClientForModel).toHaveBeenCalledWith('cloud-agent-token', {
      isFree: false,
      hasUserByokAvailable: false,
    });
  });

  it('falls back to the balance-checked client when the session model is unavailable', async () => {
    mockGetSession.mockResolvedValueOnce({ model: undefined });
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    await caller.sendMessage({
      cloudAgentSessionId: 'agent_123',
      payload: { type: 'command', command: 'review', arguments: '' },
    });

    expect(mockGetSession).toHaveBeenCalledWith('agent_123');
    expect(mockComputeCloudAgentNextBalanceCheckEligibility).not.toHaveBeenCalled();
    expect(mockCreateCloudAgentNextClientForModel).toHaveBeenCalledWith('cloud-agent-token', {
      isFree: false,
      hasUserByokAvailable: false,
    });
  });

  it('falls back to the balance-checked client when getSession rejects', async () => {
    mockGetSession.mockRejectedValueOnce(new Error('worker unavailable'));
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    await caller.sendMessage({
      cloudAgentSessionId: 'agent_123',
      payload: { type: 'command', command: 'review', arguments: '' },
    });

    expect(mockGetSession).toHaveBeenCalledWith('agent_123');
    expect(mockComputeCloudAgentNextBalanceCheckEligibility).not.toHaveBeenCalled();
    expect(mockCreateCloudAgentNextClientForModel).toHaveBeenCalledWith('cloud-agent-token', {
      isFree: false,
      hasUserByokAvailable: false,
    });
    expect(mockSendMessage).toHaveBeenCalled();
  });

  it('signs Cloud Agent document uploads with the authenticated user scope', async () => {
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });
    await caller.getAttachmentUploadUrl({
      messageUuid: '12345678-1234-4234-9234-123456789abc',
      attachmentId: '87654321-4321-4321-8321-cba987654321',
      contentType: 'application/pdf',
      contentLength: 42,
    });

    expect(mockGenerateCloudAgentAttachmentUploadUrl).toHaveBeenCalledWith({
      userId: 'user-1',
      messageUuid: '12345678-1234-4234-9234-123456789abc',
      attachmentId: '87654321-4321-4321-8321-cba987654321',
      contentType: 'application/pdf',
      contentLength: 42,
    });
  });

  it('presigns Cloud Agent attachment downloads with the caller-scoped key prefix', async () => {
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });
    await caller.getAttachmentDownloadUrl({
      messageUuid: '12345678-1234-4234-9234-123456789abc',
      filename: '87654321-4321-4321-8321-cba987654321.kilo',
    });

    expect(mockGenerateCloudAgentAttachmentDownloadUrl).toHaveBeenCalledWith({
      userId: 'user-1',
      messageUuid: '12345678-1234-4234-9234-123456789abc',
      filename: '87654321-4321-4321-8321-cba987654321.kilo',
    });
  });

  it('rejects a deny-listed extension before reaching the presign helper', async () => {
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    await expect(
      caller.getAttachmentDownloadUrl({
        messageUuid: '12345678-1234-4234-9234-123456789abc',
        filename: '87654321-4321-4321-8321-cba987654321.exe',
      })
    ).rejects.toThrow();
    expect(mockGenerateCloudAgentAttachmentDownloadUrl).not.toHaveBeenCalled();
  });

  it('rejects a filename that violates the relaxed-regex shape', async () => {
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    await expect(
      caller.getAttachmentDownloadUrl({
        messageUuid: '12345678-1234-4234-9234-123456789abc',
        filename: 'not-a-uuid.kilo',
      })
    ).rejects.toThrow();
    expect(mockGenerateCloudAgentAttachmentDownloadUrl).not.toHaveBeenCalled();
  });
});

describe('cloudAgentNextRouter.cancelQueuedMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyUserOwnsSessionV2ByCloudAgentId.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    mockCancelQueuedMessage.mockResolvedValue({ dropped: true });
  });

  it('denies canceling a queued message on a session the user does not own', async () => {
    mockVerifyUserOwnsSessionV2ByCloudAgentId.mockResolvedValueOnce(null);
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    await expect(
      caller.cancelQueuedMessage({
        sessionId: 'agent_123',
        messageId: 'msg_123456789abc123456789ABCDE',
      })
    ).rejects.toThrow('Session not found or access denied');

    expect(mockCancelQueuedMessage).not.toHaveBeenCalled();
  });
});

describe('cloudAgentNextRouter.getSandboxStatus', () => {
  const cloudAgentSessionId = 'workspace_12345678-1234-4234-9234-123456789abc';
  const user = { id: 'oauth/provider:status-owner', is_admin: false } as User;
  const snapshot = {
    status: 'sleeping',
    provider: 'Vercel',
    observedAt: 1_800_000_000_000,
    detailCode: 'sandbox_stopped',
    inactivityTimeoutMs: 300_000,
    estimatedSleepAt: null,
  } satisfies SandboxStatusSnapshot;

  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyUserOwnsSessionV2ByCloudAgentId.mockReset().mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    mockGetSandboxStatus.mockReset().mockResolvedValue(snapshot);
  });

  it('authorizes personal creator access before contacting the Worker without balance checks', async () => {
    mockVerifyUserOwnsSessionV2ByCloudAgentId.mockImplementationOnce(async () => {
      expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
      expect(mockGetSandboxStatus).not.toHaveBeenCalled();
      return { kiloSessionId: 'ses_12345678901234567890123456' };
    });
    await expect(createCaller({ user }).getSandboxStatus({ cloudAgentSessionId })).resolves.toEqual(
      snapshot
    );
    expect(mockVerifyUserOwnsSessionV2ByCloudAgentId).toHaveBeenCalledWith(
      expect.anything(),
      user.id,
      cloudAgentSessionId
    );
    expect(mockGetSandboxStatus).toHaveBeenCalledWith(cloudAgentSessionId);
    expect(mockCreateCloudAgentNextClient).toHaveBeenCalledWith('cloud-agent-token');
    expect(mockCreateCloudAgentNextClientForModel).not.toHaveBeenCalled();
    expect(mockComputeCloudAgentNextBalanceCheckEligibility).not.toHaveBeenCalled();
    expect(mockGetBalanceForUser).not.toHaveBeenCalled();
  });

  it.each([
    'agent_12345678-1234-4234-9234-123456789abc',
    'ses_12345678901234567890123456',
    'workspace_',
    'workspace_pending',
    'workspace_../../private',
    `${cloudAgentSessionId} `,
    '',
  ])('rejects invalid reference %s before ownership or Worker lookup', async invalidId => {
    await expect(
      createCaller({ user }).getSandboxStatus({ cloudAgentSessionId: invalidId })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockVerifyUserOwnsSessionV2ByCloudAgentId).not.toHaveBeenCalled();
    expect(mockGetSandboxStatus).not.toHaveBeenCalled();
    expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
  });

  it.each([
    'provider',
    'ownerId',
    'userId',
    'organizationId',
    'sandboxId',
    'observedAt',
    'inactivityTimeoutMs',
    'estimatedSleepAt',
  ])('rejects caller override %s', async field => {
    const input = { cloudAgentSessionId, [field]: 'private-override' };
    await expect(createCaller({ user }).getSandboxStatus(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockVerifyUserOwnsSessionV2ByCloudAgentId).not.toHaveBeenCalled();
    expect(mockGetSandboxStatus).not.toHaveBeenCalled();
  });

  it('keeps inaccessible personal or organization sessions denied before status', async () => {
    mockVerifyUserOwnsSessionV2ByCloudAgentId.mockResolvedValueOnce(null);
    await expect(
      createCaller({ user }).getSandboxStatus({ cloudAgentSessionId })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Session not found or access denied',
    });
    expect(mockGetSandboxStatus).not.toHaveBeenCalled();
    expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
  });

  it('fails closed without leaking unavailable authorization storage diagnostics', async () => {
    mockVerifyUserOwnsSessionV2ByCloudAgentId.mockRejectedValueOnce(
      new Error('private-database-diagnostics')
    );
    await expect(
      createCaller({ user }).getSandboxStatus({ cloudAgentSessionId })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Session not found or access denied',
      cause: undefined,
    });
    expect(mockGetSandboxStatus).not.toHaveBeenCalled();
  });

  it.each(['UNAUTHORIZED', 'FORBIDDEN'] as const)('preserves Worker %s denials', async code => {
    mockGetSandboxStatus.mockRejectedValueOnce(
      new TRPCError({ code, message: 'Session access denied' })
    );
    await expect(
      createCaller({ user }).getSandboxStatus({ cloudAgentSessionId })
    ).rejects.toMatchObject({ code });
  });

  it('strips unexpected client fields at the web output boundary', async () => {
    mockGetSandboxStatus.mockResolvedValueOnce({
      ...snapshot,
      credentials: 'private-token',
      sandboxId: 'private-runtime',
    } as SandboxStatusSnapshot);
    const response = await createCaller({ user }).getSandboxStatus({ cloudAgentSessionId });
    expect(response).toEqual(snapshot);
    expect(JSON.stringify(response)).not.toContain('private');
  });
});

describe('cloudAgentNextRouter helper procedures', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOrderRepositoriesByUsage.mockImplementation(async ({ repositories }) => repositories);
  });

  it.each([
    { balance: 1, isEligible: true, accessLevel: 'full' as const },
    { balance: 0.99, isEligible: false, accessLevel: 'limited' as const },
  ])('reports eligibility for a $balance balance', async ({ balance, isEligible, accessLevel }) => {
    mockGetBalanceForUser.mockResolvedValue({ balance });
    const user = { id: 'user-eligibility', is_admin: false } as User;
    const caller = createCaller({ user });

    await expect(caller.checkEligibility()).resolves.toEqual({
      balance,
      minBalance: 1,
      isEligible,
      accessLevel,
    });
    expect(mockGetBalanceForUser).toHaveBeenCalledWith(user);
    expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
  });

  it.each([
    ['GitHub', 'listGitHubRepositories', mockFetchGitHubRepositoriesForUser, 'github'],
    ['GitLab', 'listGitLabRepositories', mockFetchGitLabRepositoriesForUser, 'gitlab'],
  ] as const)(
    'lists %s repositories without creating a runtime client',
    async (_, method, fetchRepositories, platform) => {
      const repositories = {
        repositories: [],
        integrationInstalled: true,
        syncedAt: null,
      };
      fetchRepositories.mockResolvedValue(repositories);
      const caller = createCaller({ user: { id: 'user-repositories', is_admin: false } as User });

      await expect(caller[method]({ forceRefresh: true })).resolves.toEqual(repositories);
      expect(fetchRepositories).toHaveBeenCalledWith('user-repositories', true);
      expect(mockOrderRepositoriesByUsage).toHaveBeenCalledWith({
        userId: 'user-repositories',
        organizationId: null,
        platform,
        repositories: [],
      });
      expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
    }
  );

  it('passes the GitLab instance URL to repository ranking', async () => {
    const repositories = [{ id: 1, name: 'repo', fullName: 'acme/repo', private: false }];
    mockFetchGitLabRepositoriesForUser.mockResolvedValue({
      repositories,
      integrationInstalled: true,
      syncedAt: null,
      instanceUrl: 'https://gitlab.example.com',
    });
    const caller = createCaller({ user: { id: 'user-repositories', is_admin: false } as User });

    await caller.listGitLabRepositories({ forceRefresh: false });

    expect(mockOrderRepositoriesByUsage).toHaveBeenCalledWith({
      userId: 'user-repositories',
      organizationId: null,
      platform: 'gitlab',
      repositories,
      gitlabInstanceUrl: 'https://gitlab.example.com',
    });
  });

  it('does not expose the GitLab instance URL in the output shape', async () => {
    mockFetchGitLabRepositoriesForUser.mockResolvedValue({
      repositories: [],
      integrationInstalled: true,
      syncedAt: null,
      instanceUrl: 'https://gitlab.example.com',
    });
    const caller = createCaller({ user: { id: 'user-repositories', is_admin: false } as User });

    const result = await caller.listGitLabRepositories({ forceRefresh: false });

    expect(result).toEqual({ repositories: [], integrationInstalled: true, syncedAt: null });
    expect(result).not.toHaveProperty('instanceUrl');
  });

  it('propagates provider fetch errors without swallowing them', async () => {
    mockFetchGitHubRepositoriesForUser.mockRejectedValueOnce(new Error('provider down'));
    const caller = createCaller({ user: { id: 'user-repositories', is_admin: false } as User });

    await expect(caller.listGitHubRepositories({ forceRefresh: false })).rejects.toThrow(
      'provider down'
    );
    expect(mockOrderRepositoriesByUsage).not.toHaveBeenCalled();
  });
});

describe('cloudAgentNextRouter.prepareSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrepareSession.mockResolvedValue({
      cloudAgentSessionId: 'agent_123',
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    mockComputeCloudAgentNextBalanceCheckEligibility.mockResolvedValue({
      isFree: false,
      hasUserByokAvailable: false,
    });
  });

  it('derives browser provenance when the authenticated request is not mobile', async () => {
    const caller = createCaller({
      user: { id: 'user-browser', is_admin: false } as User,
      headersList: new Headers({ 'x-kilo-client': 'web' }),
    });

    await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'code',
      model: 'kilo/test-model',
      githubRepo: 'acme/repo',
      autoInitiate: true,
    });

    expect(mockPrepareSession).toHaveBeenCalledWith(
      expect.objectContaining({ createdOnPlatform: 'cloud-agent-web', clientProvenance: 'browser' })
    );
  });

  it('derives mobile provenance from authenticated headers even when public input attempts to forge browser provenance', async () => {
    const caller = createCaller({
      user: { id: 'user-mobile', is_admin: false } as User,
      headersList: new Headers({
        'x-kilo-client': 'mobile',
        'x-kilo-app-platform': 'ios',
        'x-kilo-app-version': '1.0.0',
      }),
    });

    await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'code',
      model: 'kilo/test-model',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      clientProvenance: 'browser',
    } as z.infer<typeof personalPrepareSessionNextSchema>);

    expect(mockPrepareSession).toHaveBeenCalledWith(
      expect.objectContaining({ createdOnPlatform: 'cloud-agent-web', clientProvenance: 'mobile' })
    );
  });

  it('rejects devcontainer sessions when the feature flag is disabled', async () => {
    mockIsFeatureFlagEnabledOrDevelopment.mockResolvedValue(false);
    const caller = createCaller({
      user: { id: 'user-1', is_admin: true } as User,
    });

    await expect(
      caller.prepareSession({
        prompt: 'Test prompt',
        mode: 'code',
        model: 'kilo/test-model',
        githubRepo: 'acme/repo',
        autoInitiate: true,
        devcontainer: true,
      })
    ).rejects.toThrow('Dev container sessions are not available');
    expect(mockIsFeatureFlagEnabledOrDevelopment).toHaveBeenCalledWith(
      'cloud-agent-devcontainer',
      'user-1'
    );
    expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
  });

  it('normalizes legacy initial images to canonical Worker attachments', async () => {
    const caller = createCaller({
      user: { id: 'user-1', is_admin: false } as User,
    });
    const images = {
      path: '12345678-1234-4234-9234-123456789abc',
      files: ['87654321-4321-4321-8321-cba987654321.png'],
    };

    await caller.prepareSession({
      prompt: 'Read image',
      mode: 'code',
      model: 'kilo/test-model',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      devcontainer: false,
      images,
    });

    expect(mockPrepareSession).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: images, createdOnPlatform: 'cloud-agent-web' })
    );
    expect(mockPrepareSession).not.toHaveBeenCalledWith(expect.objectContaining({ images }));
  });

  it('rejects personal Bitbucket sessions before constructing a Cloud Agent client', async () => {
    const caller = createCaller({
      user: { id: 'user-1', is_admin: false } as User,
    });

    await expect(
      caller.prepareSession({
        prompt: 'Inspect the repository',
        mode: 'code',
        model: 'kilo/test-model',
        bitbucketRepo: {
          fullName: 'acme/api',
          workspaceUuid: '11111111-1111-4111-8111-111111111111',
          repositoryUuid: '22222222-2222-4222-8222-222222222222',
        },
        autoInitiate: true,
        devcontainer: false,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
    expect(mockPrepareSession).not.toHaveBeenCalled();
  });

  it('forwards devcontainer sessions when the feature flag is enabled', async () => {
    mockIsFeatureFlagEnabledOrDevelopment.mockResolvedValue(true);
    const caller = createCaller({
      user: { id: 'user-2', is_admin: false } as User,
    });

    await expect(
      caller.prepareSession({
        prompt: 'Test prompt',
        mode: 'code',
        model: 'kilo/test-model',
        githubRepo: 'acme/repo',
        autoInitiate: true,
        devcontainer: true,
      })
    ).resolves.toEqual({
      cloudAgentSessionId: 'agent_123',
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    expect(mockIsFeatureFlagEnabledOrDevelopment).toHaveBeenCalledWith(
      'cloud-agent-devcontainer',
      'user-2'
    );
    expect(mockPrepareSession).toHaveBeenCalledWith(
      expect.objectContaining({
        githubRepo: 'acme/repo',
        devcontainer: true,
      })
    );
  });

  it('routes free models through the AppBuilder client so the worker skips the balance minimum', async () => {
    mockComputeCloudAgentNextBalanceCheckEligibility.mockResolvedValueOnce({
      isFree: true,
      hasUserByokAvailable: false,
    });
    const caller = createCaller({
      user: { id: 'user-free', is_admin: false } as User,
    });

    await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'code',
      model: 'kilo/test-model',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      devcontainer: false,
    });

    expect(mockComputeCloudAgentNextBalanceCheckEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'kilo/test-model' })
    );
    expect(mockCreateCloudAgentNextClientForModel).toHaveBeenCalledWith('cloud-agent-token', {
      isFree: true,
      hasUserByokAvailable: false,
    });
    expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
  });

  it('routes BYOK-capable paid models through the AppBuilder client so the worker skips the balance minimum', async () => {
    mockComputeCloudAgentNextBalanceCheckEligibility.mockResolvedValueOnce({
      isFree: false,
      hasUserByokAvailable: true,
    });
    const caller = createCaller({
      user: { id: 'user-byok', is_admin: false } as User,
    });

    await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'code',
      model: 'kilo/paid-byok-model',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      devcontainer: false,
    });

    expect(mockCreateCloudAgentNextClientForModel).toHaveBeenCalledWith('cloud-agent-token', {
      isFree: false,
      hasUserByokAvailable: true,
    });
    expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
  });

  it('routes paid models the user has no BYOK key for through the model-aware helper with a paid eligibility', async () => {
    const caller = createCaller({
      user: { id: 'user-paid', is_admin: false } as User,
    });

    await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'code',
      model: 'kilo/paid-model',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      devcontainer: false,
    });

    expect(mockCreateCloudAgentNextClientForModel).toHaveBeenCalledWith('cloud-agent-token', {
      isFree: false,
      hasUserByokAvailable: false,
    });
  });

  it('forwards cloneFromKiloSessionId to the Worker', async () => {
    const caller = createCaller({
      user: { id: 'user-1', is_admin: false } as User,
    });
    const cloneFromKiloSessionId = 'ses_12345678901234567890123456';

    await caller.prepareSession({
      cloneFromKiloSessionId,
      autoInitiate: true,
      operationKey: '12345678-1234-4234-9234-123456789abc',
      mode: 'code',
      model: 'kilo/test-model',
      githubRepo: 'acme/repo',
      devcontainer: false,
    });

    expect(mockPrepareSession).toHaveBeenCalledWith(
      expect.objectContaining({ cloneFromKiloSessionId })
    );
  });
});

describe('cloudAgentNextRouter.createWorktreeChat', () => {
  const uuid = '12345678-1234-4234-9234-123456789abc';
  const sourceKiloSessionId = 'ses_12345678901234567890123456';
  const result = {
    kiloSessionId: 'ses_abcdefghijklmnopqrstuvwxyz',
    cloudAgentSessionId: `workspace_${uuid}` as const,
    worktreeId: `worktree_${uuid}` as const,
    replayed: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateWorktreeChat.mockResolvedValue(result);
  });

  it('forwards only the authenticated owner and canonical sibling action to the shared operation', async () => {
    const user = { id: 'oauth/github|owner', is_admin: false } as User;
    const headersList = new Headers({ 'x-kilo-client': 'web' });
    const caller = createCaller({ user, headersList });

    await expect(
      caller.createWorktreeChat({ sourceKiloSessionId, operationKey: uuid })
    ).resolves.toEqual(result);

    expect(mockCreateWorktreeChat).toHaveBeenCalledWith({
      user,
      headersList,
      sourceKiloSessionId,
      operationKey: uuid,
    });
  });

  it.each([
    { sourceKiloSessionId: 'ses_invalid', operationKey: uuid },
    { sourceKiloSessionId, operationKey: 'invalid-uuid' },
    { sourceKiloSessionId, operationKey: uuid, clientProvenance: 'browser' },
  ])('rejects malformed or untrusted public input %j', async input => {
    const caller = createCaller({ user: { id: 'owner', is_admin: false } as User });

    await expect(caller.createWorktreeChat(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockCreateWorktreeChat).not.toHaveBeenCalled();
  });
});
