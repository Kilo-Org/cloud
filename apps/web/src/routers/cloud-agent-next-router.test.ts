import { describe, expect, it, jest, beforeAll, beforeEach, afterAll } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import {
  cli_sessions_v2,
  cloud_agent_pending_uploads,
  organizations,
  type User,
} from '@kilocode/db/schema';
import type { createWorktreeChat as CreateWorktreeChat } from '@/lib/cloud-agent-next/worktree-chat';
import type * as CloudAgentClientModule from '@/lib/cloud-agent-next/cloud-agent-client';
import type { CloudAgentNextClient } from '@/lib/cloud-agent-next/cloud-agent-client';
import type * as MinimumVersionModule from '@kilocode/web-shared/lib/trpc/min-version';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
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
import {
  getSandboxAllocationRequest,
  SELECTABLE_SANDBOX_ALLOCATIONS,
  type SandboxAllocationInput,
  type SandboxSelectionCapabilities,
  type SelectableSandboxAllocation,
  type SelectableSandboxAllocationRequest,
} from '@kilocode/worker-utils/sandbox-allocation';
import type { GetSandboxSelectionOptionsInput } from '@/lib/cloud-agent-next/cloud-agent-client';
import { TRPCClientError } from '@trpc/client';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import type { verifyUserOwnsSessionV2ByCloudAgentId } from '@/lib/cloud-agent/session-ownership';
import type * as StreamTicketModule from '@/lib/cloud-agent/stream-ticket';

type AttachmentReference = { path: string; files: string[] };

/** A valid client message id; the send schema requires one. */
const SEND_MESSAGE_ID = 'msg_123456789abc123456789ABCDE';

const mockPrepareSession = jest.fn<
  (input: {
    githubRepo?: string;
    devcontainer?: boolean;
    sandboxAllocation?: SandboxAllocationInput;
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
const mockInitiateFromPreparedSession =
  jest.fn<(input: { cloudAgentSessionId: string }) => Promise<unknown>>();
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

const mockGetSandboxSelectionOptions =
  jest.fn<(input: GetSandboxSelectionOptionsInput) => Promise<SandboxSelectionCapabilities>>();
const mockGetPreviewOptions =
  jest.fn<
    (input: {
      cloudAgentSessionId: string;
      organizationId?: string;
    }) => Promise<{ enabled: false } | { enabled: true; hostTemplate: string }>
  >();

const mockCreateCloudAgentNextClient = jest.fn((_authToken: string) => ({
  getSandboxSelectionOptions: mockGetSandboxSelectionOptions,
  getPreviewOptions: mockGetPreviewOptions,
  prepareSession: mockPrepareSession,
  initiateFromPreparedSession: mockInitiateFromPreparedSession,
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
const mockSignPreviewTicket = jest.fn<typeof StreamTicketModule.signPreviewTicket>();
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

jest.mock('@/lib/auth/resource-delegation', () => ({
  createControlTokenForRequest: jest.fn(async () => ({ token: 'cloud-agent-token' })),
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: mockCreateCloudAgentNextClient,
  createCloudAgentNextClientForModel: mockCreateCloudAgentNextClientForModel,
  rethrowCloudAgentError: jest.requireActual<typeof CloudAgentClientModule>(
    '@/lib/cloud-agent-next/cloud-agent-client'
  ).rethrowCloudAgentError,
}));

jest.mock('@/lib/cloud-agent-next/worktree-chat', () => ({
  createWorktreeChat: mockCreateWorktreeChat,
}));

jest.mock('@kilocode/web-shared/lib/trpc/min-version', () => ({
  ...jest.requireActual<typeof MinimumVersionModule>('@kilocode/web-shared/lib/trpc/min-version'),
  getMinimumVersions: jest.fn(async () => ({ ios: '0.0.0', android: '0.0.0' })),
  enforceMinimumVersion: jest.fn(() => ({ pass: true })),
}));

jest.mock('@/lib/cloud-agent-next/balance-check-eligibility', () => ({
  computeCloudAgentNextBalanceCheckEligibility: mockComputeCloudAgentNextBalanceCheckEligibility,
}));

jest.mock('@kilocode/web-shared/lib/posthog-feature-flags', () => ({
  isFeatureFlagEnabledOrDevelopment: mockIsFeatureFlagEnabledOrDevelopment,
}));

jest.mock('@kilocode/web-shared/lib/user/balance', () => ({
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

jest.mock('@/lib/cloud-agent/stream-ticket', () => {
  const actual = jest.requireActual<typeof StreamTicketModule>('@/lib/cloud-agent/stream-ticket');
  mockSignPreviewTicket.mockImplementation(actual.signPreviewTicket);
  return { ...actual, signPreviewTicket: mockSignPreviewTicket };
});

let createCaller: (ctx: { user: User; headersList?: Headers }) => {
  getSandboxSelectionOptions: (input: {
    devcontainer?: boolean;
  }) => Promise<SandboxSelectionCapabilities>;
  prepareSession: (input: z.input<typeof personalPrepareSessionNextSchema>) => Promise<{
    cloudAgentSessionId: string;
    kiloSessionId: string;
  }>;
  initiateFromPreparedSession: (input: { cloudAgentSessionId: string }) => Promise<unknown>;
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
    messageId: string;
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
  createPreview: (input: {
    cloudAgentSessionId: `workspace_${string}`;
    port: number;
    path?: string;
  }) => Promise<{
    url: string;
    expiresAt: number;
  }>;
  getPreviewOptions: (input: {
    cloudAgentSessionId: `workspace_${string}`;
    organizationId?: string;
  }) => Promise<{ enabled: false } | { enabled: true; urlTemplate: string }>;
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
  const { createCallerFactory } = await import('@kilocode/web-shared/lib/trpc/init');
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
        messageId: SEND_MESSAGE_ID,
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
        messageId: SEND_MESSAGE_ID,
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
      messageId: SEND_MESSAGE_ID,
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
      messageId: SEND_MESSAGE_ID,
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
      messageId: SEND_MESSAGE_ID,
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
      messageId: SEND_MESSAGE_ID,
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
      messageId: SEND_MESSAGE_ID,
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
      messageId: SEND_MESSAGE_ID,
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
      messageId: SEND_MESSAGE_ID,
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

describe('cloudAgentNextRouter send attachment ledger', () => {
  const userId = `oauth/ledger-send-${crypto.randomUUID()}`;
  const messageUuid = '12345678-1234-4234-9234-123456789abc';
  const attachmentId = '87654321-4321-4321-8321-cba987654321';
  const file = `${attachmentId}.pdf`;
  const attachments = { path: messageUuid, files: [file] };
  const objectKey = `${userId}/cloud-agent/${messageUuid}/${file}`;
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();

  async function insertLedgerRow(
    status: 'pending' | 'linked' | 'reaped',
    expiresAt = future
  ): Promise<void> {
    await db.insert(cloud_agent_pending_uploads).values({
      id: crypto.randomUUID(),
      kilo_user_id: userId,
      object_key: objectKey,
      message_uuid: messageUuid,
      attachment_id: attachmentId,
      byte_size: 42,
      status,
      expires_at: expiresAt,
    });
  }

  async function readStatus(): Promise<string | undefined> {
    const rows = await db
      .select({ status: cloud_agent_pending_uploads.status })
      .from(cloud_agent_pending_uploads)
      .where(eq(cloud_agent_pending_uploads.object_key, objectKey));
    return rows[0]?.status;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSendMessage.mockReset();
    mockSendMessage.mockResolvedValue({
      cloudAgentSessionId: 'agent_123',
      status: 'started',
      streamUrl: '/stream',
      messageId: SEND_MESSAGE_ID,
      delivery: 'sent',
    });
    mockVerifyUserOwnsSessionV2ByCloudAgentId.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    mockComputeCloudAgentNextBalanceCheckEligibility.mockResolvedValue({
      isFree: false,
      hasUserByokAvailable: false,
    });
    mockGetSession.mockResolvedValue({ model: 'kilo/paid-model' });
    await db
      .delete(cloud_agent_pending_uploads)
      .where(eq(cloud_agent_pending_uploads.object_key, objectKey));
  });

  afterAll(async () => {
    await db
      .delete(cloud_agent_pending_uploads)
      .where(eq(cloud_agent_pending_uploads.object_key, objectKey));
  });

  it('refuses a send whose attachment object the ledger already released', async () => {
    await insertLedgerRow('reaped', past);
    const caller = createCaller({ user: { id: userId, is_admin: false } as User });

    await expect(
      caller.sendMessage({
        cloudAgentSessionId: 'agent_123',
        messageId: SEND_MESSAGE_ID,
        payload: { type: 'prompt', prompt: 'Read the attachment', mode: 'code', model: 'test' },
        attachments,
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Attachment upload expired. Add the file again to send it.',
    });

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('links the attachment rows before the worker accepts the send', async () => {
    await insertLedgerRow('pending');
    const caller = createCaller({ user: { id: userId, is_admin: false } as User });

    await expect(
      caller.sendMessage({
        cloudAgentSessionId: 'agent_123',
        messageId: SEND_MESSAGE_ID,
        payload: { type: 'prompt', prompt: 'Read the attachment', mode: 'code', model: 'test' },
        attachments,
      })
    ).resolves.toMatchObject({ messageId: SEND_MESSAGE_ID });

    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({ attachments }));
    expect(await readStatus()).toBe('linked');
  });

  it('keeps the attachment rows linked when the worker rejects the send', async () => {
    await insertLedgerRow('pending');
    mockSendMessage.mockRejectedValueOnce(new TRPCClientError('worker unavailable'));
    const caller = createCaller({ user: { id: userId, is_admin: false } as User });

    await expect(
      caller.sendMessage({
        cloudAgentSessionId: 'agent_123',
        messageId: SEND_MESSAGE_ID,
        payload: { type: 'prompt', prompt: 'Read the attachment', mode: 'code', model: 'test' },
        attachments,
      })
    ).rejects.toThrow('worker unavailable');

    expect(await readStatus()).toBe('linked');
  });

  it('requires a client message id before calling the worker', async () => {
    await insertLedgerRow('pending');
    const caller = createCaller({ user: { id: userId, is_admin: false } as User });

    await expect(
      caller.sendMessage(
        // Omit the required message id to prove the input schema rejects it.
        {
          cloudAgentSessionId: 'agent_123',
          payload: { type: 'prompt', prompt: 'No id', mode: 'code', model: 'test' },
        } as never
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(await readStatus()).toBe('pending');
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

  it('does not strip platformIntegrationId/githubAppType from GitHub repositories in the response', async () => {
    // Regression test: the tRPC .output() schema previously omitted these
    // fields, so Zod silently stripped them even though the picker (and its
    // "Select the GitHub repository again" guard) depends on them.
    const repositories = [
      {
        id: 1,
        name: 'repo',
        fullName: 'acme/repo',
        private: false,
        platformIntegrationId: '11111111-1111-4111-8111-111111111111',
        platformAccountLogin: 'acme',
        githubAppType: 'lite' as const,
      },
    ];
    mockFetchGitHubRepositoriesForUser.mockResolvedValue({
      repositories,
      integrationInstalled: true,
      syncedAt: null,
    });
    const caller = createCaller({ user: { id: 'user-repositories', is_admin: false } as User });

    await expect(caller.listGitHubRepositories({ forceRefresh: false })).resolves.toEqual({
      repositories,
      integrationInstalled: true,
      syncedAt: null,
    });
  });
});

describe('cloudAgentNextRouter.getSandboxSelectionOptions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards personal capability discovery with the caller token', async () => {
    const capabilities: SandboxSelectionCapabilities = {
      enabled: true,
      defaultDestination: getSandboxAllocationRequest('cloudflare-single'),
      options: [{ allocation: getSandboxAllocationRequest('cloudflare-single') }],
    };
    mockGetSandboxSelectionOptions.mockResolvedValueOnce(capabilities);
    const caller = createCaller({ user: { id: 'oauth/user', is_admin: false } as User });

    await expect(caller.getSandboxSelectionOptions({})).resolves.toEqual(capabilities);
    expect(mockCreateCloudAgentNextClient).toHaveBeenCalledWith('cloud-agent-token');
    expect(mockGetSandboxSelectionOptions).toHaveBeenCalledWith({});
  });

  it.each([false, true])('ignores retired personal devcontainer context %s', async devcontainer => {
    mockGetSandboxSelectionOptions.mockResolvedValueOnce({ enabled: false, options: [] });
    const caller = createCaller({ user: { id: 'oauth/user', is_admin: false } as User });

    await expect(caller.getSandboxSelectionOptions({ devcontainer })).resolves.toEqual({
      enabled: false,
      options: [],
    });
    expect(mockGetSandboxSelectionOptions).toHaveBeenCalledWith({});
  });

  it('propagates Worker-disabled selection without granting a capability', async () => {
    mockGetSandboxSelectionOptions.mockResolvedValueOnce({ enabled: false, options: [] });
    const caller = createCaller({ user: { id: 'admin-user', is_admin: true } as User });

    await expect(caller.getSandboxSelectionOptions({})).resolves.toEqual({
      enabled: false,
      options: [],
    });
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
    ).rejects.toThrow('Devcontainer support has been retired');
    expect(mockIsFeatureFlagEnabledOrDevelopment).not.toHaveBeenCalled();
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

  const sandboxInput = {
    prompt: 'Test prompt',
    mode: 'code',
    model: 'kilo/test-model',
    githubRepo: 'acme/repo',
  };

  it.each(SELECTABLE_SANDBOX_ALLOCATIONS)(
    'forwards the normalized legacy personal sandbox preset %s',
    async sandboxAllocation => {
      const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

      await caller.prepareSession({ ...sandboxInput, sandboxAllocation });

      expect(mockPrepareSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxAllocation: getSandboxAllocationRequest(sandboxAllocation),
        })
      );
    }
  );

  it.each([
    ...SELECTABLE_SANDBOX_ALLOCATIONS.map(allocation => getSandboxAllocationRequest(allocation)),
    { provider: { id: 'vercel', account: 'byoc' }, instanceType: 'small' },
    { provider: { id: 'vercel', account: 'byoc' }, instanceType: 'large' },
  ] satisfies SelectableSandboxAllocationRequest[])(
    'forwards a structured personal sandbox destination without changing its account: %j',
    async sandboxAllocation => {
      const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

      await caller.prepareSession({ ...sandboxInput, sandboxAllocation });

      expect(mockPrepareSession).toHaveBeenCalledWith(
        expect.objectContaining({ sandboxAllocation })
      );
      expect(mockGetSandboxSelectionOptions).not.toHaveBeenCalled();
    }
  );

  it('keeps Default omitted on personal prepares', async () => {
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    await caller.prepareSession(sandboxInput);

    expect(mockPrepareSession).toHaveBeenCalledTimes(1);
    expect(mockPrepareSession.mock.calls[0][0]).not.toHaveProperty('sandboxAllocation');
  });

  it('rejects an invalid personal preset before calling the Worker', async () => {
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    await expect(
      caller.prepareSession({
        ...sandboxInput,
        sandboxAllocation: 'vercel-medium' as SelectableSandboxAllocation,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockPrepareSession).not.toHaveBeenCalled();
  });

  it('rejects explicit personal presets with dev containers before calling the Worker', async () => {
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    await expect(
      caller.prepareSession({
        ...sandboxInput,
        sandboxAllocation: 'cloudflare-single',
        devcontainer: true,
      })
    ).rejects.toThrow('Sandbox selection is not available with dev containers');
    expect(mockPrepareSession).not.toHaveBeenCalled();
    expect(mockIsFeatureFlagEnabledOrDevelopment).not.toHaveBeenCalled();
  });

  it('rejects retired devcontainer sessions even when the feature flag is enabled', async () => {
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
    ).rejects.toThrow('Devcontainer support has been retired');
    expect(mockIsFeatureFlagEnabledOrDevelopment).not.toHaveBeenCalled();
    expect(mockPrepareSession).not.toHaveBeenCalled();
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

  it('forwards cloneUpToMessageId to the Worker', async () => {
    const caller = createCaller({
      user: { id: 'user-1', is_admin: false } as User,
    });
    const cloneUpToMessageId = 'msg_12345678901212345678901234';

    await caller.prepareSession({
      cloneFromKiloSessionId: 'ses_12345678901234567890123456',
      cloneUpToMessageId,
      autoInitiate: true,
      operationKey: '12345678-1234-4234-9234-123456789abc',
      mode: 'code',
      model: 'kilo/test-model',
      githubRepo: 'acme/repo',
      devcontainer: false,
    });

    expect(mockPrepareSession).toHaveBeenCalledWith(
      expect.objectContaining({ cloneUpToMessageId })
    );
  });
});

describe('cloudAgentNextRouter Worker error codes', () => {
  const procedures = ['prepareSession', 'initiateFromPreparedSession', 'sendMessage'] as const;

  function workerError(code: string, httpStatus: number, message: string) {
    return new TRPCClientError(message, {
      result: { error: { code: -32000, message, data: { code, httpStatus } } },
    });
  }

  async function callWithWorkerError(
    procedure: (typeof procedures)[number],
    error: Error
  ): Promise<unknown> {
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });
    switch (procedure) {
      case 'prepareSession':
        mockPrepareSession.mockRejectedValueOnce(error);
        return caller.prepareSession({
          prompt: 'Test prompt',
          mode: 'code',
          model: 'kilo/test-model',
          githubRepo: 'acme/repo',
          autoInitiate: true,
        });
      case 'initiateFromPreparedSession':
        mockInitiateFromPreparedSession.mockRejectedValueOnce(error);
        return caller.initiateFromPreparedSession({ cloudAgentSessionId: 'agent_123' });
      case 'sendMessage':
        mockSendMessage.mockRejectedValueOnce(error);
        return caller.sendMessage({
          cloudAgentSessionId: 'agent_123',
          messageId: SEND_MESSAGE_ID,
          payload: { type: 'prompt', prompt: 'Hello', mode: 'code', model: 'kilo/test-model' },
        });
    }
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyUserOwnsSessionV2ByCloudAgentId.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    mockComputeCloudAgentNextBalanceCheckEligibility.mockResolvedValue({
      isFree: false,
      hasUserByokAvailable: false,
    });
  });

  describe.each(procedures)('%s', procedure => {
    it.each([
      ['BAD_REQUEST', 400, 'Session sandbox cleanup is scheduled'],
      ['NOT_FOUND', 404, 'Session not found'],
      ['CONFLICT', 409, 'creation_in_progress'],
    ])('keeps Worker %s as HTTP %i', async (code, httpStatus, message) => {
      const error = workerError(code, httpStatus, message);

      const thrown = await callWithWorkerError(procedure, error).catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(TRPCError);
      expect(thrown).toMatchObject({ code, message, cause: error });
      expect(getHTTPStatusCodeFromError(thrown as TRPCError)).toBe(httpStatus);
    });

    it('keeps a Worker INTERNAL_SERVER_ERROR as HTTP 500', async () => {
      const error = workerError('INTERNAL_SERVER_ERROR', 500, 'Worker failed');

      const thrown = await callWithWorkerError(procedure, error).catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(TRPCError);
      expect(thrown).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', cause: error });
      expect(getHTTPStatusCodeFromError(thrown as TRPCError)).toBe(500);
    });
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

describe('cloudAgentNextRouter.createPreview', () => {
  const cloudAgentSessionId = 'workspace_12345678-1234-4234-9234-123456789abc';
  const user = { id: 'oauth/preview-owner', is_admin: false } as User;
  const previousWsUrl = process.env.NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL = 'wss://worker.example.com';
  });

  afterAll(() => {
    if (previousWsUrl === undefined) delete process.env.NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL;
    else process.env.NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL = previousWsUrl;
  });

  it('mints a 60s entry ticket for an owned session and links to the Worker open hop', async () => {
    mockVerifyUserOwnsSessionV2ByCloudAgentId.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    const caller = createCaller({ user });

    const result = await caller.createPreview({ cloudAgentSessionId, port: 5173 });

    expect(mockVerifyUserOwnsSessionV2ByCloudAgentId).toHaveBeenCalledWith(
      expect.anything(),
      user.id,
      cloudAgentSessionId
    );
    expect(mockSignPreviewTicket).toHaveBeenCalledWith({
      userId: user.id,
      cloudAgentSessionId,
      port: 5173,
    });

    const url = new URL(result.url);
    expect(url.origin).toBe('https://worker.example.com');
    expect(url.pathname).toBe('/preview/open');

    const ticket = url.searchParams.get('ticket') ?? '';
    const decoded = jwt.verify(ticket, NEXTAUTH_SECRET, {
      algorithms: ['HS256'],
      audience: 'cloud-agent-preview',
    }) as jwt.JwtPayload & {
      purpose?: string;
      userId?: string;
      cloudAgentSessionId?: string;
      organizationId?: string;
      port?: number;
    };
    expect(decoded.purpose).toBe('preview');
    expect(decoded.userId).toBe(user.id);
    expect(decoded.cloudAgentSessionId).toBe(cloudAgentSessionId);
    expect(decoded.port).toBe(5173);
    expect(decoded.organizationId).toBeUndefined();
    expect(decoded.exp! - decoded.iat!).toBe(60);
    expect(result.expiresAt).toBe(decoded.exp);
  });

  it('keeps a local ws worker origin and its port', async () => {
    process.env.NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL = 'ws://localhost:8794';
    mockVerifyUserOwnsSessionV2ByCloudAgentId.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    const caller = createCaller({ user });

    const result = await caller.createPreview({ cloudAgentSessionId, port: 5173 });

    expect(new URL(result.url).origin).toBe('http://localhost:8794');
  });

  it('passes the requested path to the Worker open hop', async () => {
    mockVerifyUserOwnsSessionV2ByCloudAgentId.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    const caller = createCaller({ user });

    const result = await caller.createPreview({
      cloudAgentSessionId,
      port: 5173,
      path: '/app page?q=a&b=c#top',
    });

    expect(new URL(result.url).searchParams.get('path')).toBe('/app page?q=a&b=c#top');
  });

  it('rejects a path that does not start with /', async () => {
    const caller = createCaller({ user });

    await expect(
      caller.createPreview({ cloudAgentSessionId, port: 5173, path: 'https://evil.example/' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockSignPreviewTicket).not.toHaveBeenCalled();
  });

  it('does not mint a ticket for a session the caller does not own', async () => {
    mockVerifyUserOwnsSessionV2ByCloudAgentId.mockResolvedValue(null);
    const caller = createCaller({ user });

    await expect(caller.createPreview({ cloudAgentSessionId, port: 5173 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockSignPreviewTicket).not.toHaveBeenCalled();
  });

  it('fails specifically when the Worker URL is unset', async () => {
    process.env.NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL = '';
    mockVerifyUserOwnsSessionV2ByCloudAgentId.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    const caller = createCaller({ user });

    await expect(caller.createPreview({ cloudAgentSessionId, port: 5173 })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Preview is not configured',
    });
  });

  it('rejects an out-of-range port before ownership or ticket minting', async () => {
    const caller = createCaller({ user });

    await expect(caller.createPreview({ cloudAgentSessionId, port: 80 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockVerifyUserOwnsSessionV2ByCloudAgentId).not.toHaveBeenCalled();
    expect(mockSignPreviewTicket).not.toHaveBeenCalled();
  });
});

describe('cloudAgentNextRouter.getPreviewOptions', () => {
  const cloudAgentSessionId = 'workspace_12345678-1234-4234-9234-123456789abc';
  const previousWsUrl = process.env.NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL = 'wss://worker.example.com';
  });

  afterAll(() => {
    if (previousWsUrl === undefined) delete process.env.NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL;
    else process.env.NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL = previousWsUrl;
  });

  it('returns disabled when the Worker does not serve preview', async () => {
    mockGetPreviewOptions.mockResolvedValueOnce({ enabled: false });
    const caller = createCaller({ user: { id: 'oauth/user', is_admin: false } as User });

    await expect(caller.getPreviewOptions({ cloudAgentSessionId })).resolves.toEqual({
      enabled: false,
    });
    expect(mockCreateCloudAgentNextClient).toHaveBeenCalledWith('cloud-agent-token');
    expect(mockGetPreviewOptions).toHaveBeenCalledWith({
      cloudAgentSessionId,
      organizationId: undefined,
    });
  });

  it('returns disabled when the Worker call fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetPreviewOptions.mockRejectedValueOnce(new Error('No procedure found on path'));
    const caller = createCaller({ user: { id: 'oauth/user', is_admin: false } as User });

    await expect(caller.getPreviewOptions({ cloudAgentSessionId })).resolves.toEqual({
      enabled: false,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('passes the route organization to the Worker gate', async () => {
    const organizationId = '11111111-1111-4111-8111-111111111111';
    mockGetPreviewOptions.mockResolvedValueOnce({ enabled: false });
    const caller = createCaller({ user: { id: 'oauth/user', is_admin: false } as User });

    await caller.getPreviewOptions({ cloudAgentSessionId, organizationId });
    expect(mockGetPreviewOptions).toHaveBeenCalledWith({ cloudAgentSessionId, organizationId });
  });

  it('puts the Worker host template on the browser-facing Worker scheme', async () => {
    mockGetPreviewOptions.mockResolvedValueOnce({
      enabled: true,
      hostTemplate: 'p{port}-abc.preview.example.com',
    });
    const caller = createCaller({ user: { id: 'oauth/user', is_admin: false } as User });

    await expect(caller.getPreviewOptions({ cloudAgentSessionId })).resolves.toEqual({
      enabled: true,
      urlTemplate: 'https://p{port}-abc.preview.example.com',
    });
  });

  it('keeps a local ws worker port in the template', async () => {
    process.env.NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL = 'ws://localhost:8794';
    mockGetPreviewOptions.mockResolvedValueOnce({
      enabled: true,
      hostTemplate: 'p{port}-abc.localhost',
    });
    const caller = createCaller({ user: { id: 'oauth/user', is_admin: false } as User });

    await expect(caller.getPreviewOptions({ cloudAgentSessionId })).resolves.toEqual({
      enabled: true,
      urlTemplate: 'http://p{port}-abc.localhost:8794',
    });
  });
});
