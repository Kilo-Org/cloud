import { describe, expect, it, jest, beforeAll, beforeEach } from '@jest/globals';
import { inspect } from 'node:util';
import { DrizzleQueryError } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import type * as TrpcInitModule from '@/lib/trpc/init';
import type { createWorktreeChat as CreateWorktreeChat } from '@/lib/cloud-agent-next/worktree-chat';
import type * as MinimumVersionModule from '@/lib/trpc/min-version';
import type * as OrganizationUtilsModule from '@/routers/organizations/utils';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import type * as ZodModule from 'zod';
import type { z } from 'zod';
import type { User } from '@kilocode/db/schema';
import type * as BitbucketIntegrationHelpers from '@/lib/cloud-agent/bitbucket-integration-helpers';
import type { BitbucketOrganizationRepositoryListResult } from '@/lib/cloud-agent/bitbucket-integration-helpers';
import { TRPCError } from '@trpc/server';
import type { verifyOrgOwnsSessionV2ByCloudAgentId } from '@/lib/cloud-agent/session-ownership';
import type {
  basePrepareSessionNextSchema,
  SandboxStatusSnapshot,
} from '@/routers/cloud-agent-next-schemas';

const ORGANIZATION_ID = '9a283301-b75d-4375-a1ba-e319a02e18b7';

type AttachmentReference = { path: string; files: string[] };

const mockPrepareSession = jest.fn<
  (input: {
    githubRepo?: string;
    gitUrl?: string;
    platform?: 'github' | 'gitlab' | 'bitbucket';
    bitbucketWorkspaceUuid?: string;
    bitbucketRepositoryUuid?: string;
    devcontainer?: boolean;
    kilocodeOrganizationId?: string;
    attachments?: AttachmentReference;
  }) => Promise<{
    cloudAgentSessionId: string;
    kiloSessionId: string;
  }>
>();

const mockSendMessage = jest.fn<
  (input: { attachments?: AttachmentReference; organizationId?: string }) => Promise<{
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

const mockGetSession = jest.fn<(cloudAgentSessionId: string) => Promise<{ model?: string }>>();
const mockCreateWorktreeChat = jest.fn<typeof CreateWorktreeChat>();

const mockCancelQueuedMessage =
  jest.fn<(input: { sessionId: string; messageId: string }) => Promise<{ dropped: boolean }>>();
const mockGetSandboxStatus =
  jest.fn<(cloudAgentSessionId: string) => Promise<SandboxStatusSnapshot>>();

const mockCreateCloudAgentNextClient = jest.fn((_authToken: string) => ({
  prepareSession: mockPrepareSession,
  sendMessage: mockSendMessage,
  getSession: mockGetSession,
  cancelQueuedMessage: mockCancelQueuedMessage,
  getSandboxStatus: mockGetSandboxStatus,
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
const mockVerifyOrgOwnsSessionV2ByCloudAgentId =
  jest.fn<typeof verifyOrgOwnsSessionV2ByCloudAgentId>();
const mockFetchBitbucketRepositoriesForOrganization =
  jest.fn<
    (
      organizationId: string,
      kiloUserId: string,
      forceRefresh?: boolean
    ) => Promise<BitbucketOrganizationRepositoryListResult>
  >();
const mockGetBalanceForOrganizationUser =
  jest.fn<(organizationId: string, userId: string) => Promise<{ balance: number }>>();
const mockFetchGitHubRepositoriesForOrganization = jest.fn<
  (
    organizationId: string,
    forceRefresh: boolean
  ) => Promise<{
    repositories: unknown[];
    integrationInstalled: boolean;
    syncedAt: null;
  }>
>();
const mockFetchGitLabRepositoriesForOrganization = jest.fn<
  (
    organizationId: string,
    actorUserId: string,
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
const mockEnsureOrganizationAccess =
  jest.fn<typeof OrganizationUtilsModule.ensureOrganizationAccess>();

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

jest.mock('@/lib/cloud-agent/bitbucket-integration-helpers', () => ({
  ...jest.requireActual<typeof BitbucketIntegrationHelpers>(
    '@/lib/cloud-agent/bitbucket-integration-helpers'
  ),
  fetchBitbucketRepositoriesForOrganization: mockFetchBitbucketRepositoriesForOrganization,
}));

jest.mock('@/lib/organizations/organization-usage', () => ({
  getBalanceForOrganizationUser: mockGetBalanceForOrganizationUser,
}));

jest.mock('@/lib/cloud-agent/github-integration-helpers', () => ({
  fetchGitHubRepositoriesForOrganization: mockFetchGitHubRepositoriesForOrganization,
  fetchAllGitHubRepositoriesForOrganization: mockFetchGitHubRepositoriesForOrganization,
}));

jest.mock('@/lib/cloud-agent/gitlab-integration-helpers', () => ({
  buildGitLabCloneUrl: jest.fn(),
  fetchGitLabRepositoriesForOrganization: mockFetchGitLabRepositoriesForOrganization,
  getGitLabInstanceUrlForOrganization: jest.fn(),
}));

jest.mock('@/lib/cloud-agent/order-repositories', () => ({
  orderRepositoriesByUsage: mockOrderRepositoriesByUsage,
}));

jest.mock('@/lib/cloud-agent/session-ownership', () => ({
  verifyOrgOwnsSessionV2ByCloudAgentId: mockVerifyOrgOwnsSessionV2ByCloudAgentId,
}));

jest.mock('@/lib/r2/cloud-agent-attachments', () => ({
  generateImageUploadUrl: jest.fn(),
  generateCloudAgentAttachmentUploadUrl: mockGenerateCloudAgentAttachmentUploadUrl,
}));

jest.mock('@/routers/organizations/utils', () => {
  const trpcInit = jest.requireActual<typeof TrpcInitModule>('@/lib/trpc/init');
  const zod = jest.requireActual<typeof ZodModule>('zod');
  const organizationProcedure = trpcInit.baseProcedure
    .input(zod.object({ organizationId: zod.uuid() }))
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

let createCaller: (ctx: { user: User; headersList?: Headers }) => {
  prepareSession: (
    input: z.infer<typeof basePrepareSessionNextSchema> & { organizationId: string }
  ) => Promise<{
    cloudAgentSessionId: string;
    kiloSessionId: string;
  }>;
  createWorktreeChat: (input: {
    organizationId: string;
    sourceKiloSessionId: string;
    operationKey: string;
  }) => Promise<{
    kiloSessionId: string;
    cloudAgentSessionId: string;
    worktreeId: string;
    replayed?: boolean;
  }>;
  sendMessage: (input: {
    organizationId: string;
    cloudAgentSessionId: string;
    payload:
      | { type: 'prompt'; prompt: string; mode: string; model: string }
      | { type: 'command'; command: string; arguments: string };
    attachments?: { path: string; files: string[] };
    images?: { path: string; files: string[] };
  }) => Promise<unknown>;
  getAttachmentUploadUrl: (input: {
    organizationId: string;
    messageUuid: string;
    attachmentId: string;
    contentType: 'text/markdown';
    contentLength: number;
  }) => Promise<unknown>;
  cancelQueuedMessage: (input: {
    organizationId: string;
    sessionId: string;
    messageId: string;
  }) => Promise<unknown>;
  listBitbucketRepositories: (input: {
    organizationId: string;
    forceRefresh?: boolean;
  }) => Promise<BitbucketOrganizationRepositoryListResult>;
  getSandboxStatus: (input: {
    organizationId: string;
    cloudAgentSessionId: string;
  }) => Promise<SandboxStatusSnapshot>;
  checkEligibility: (input: { organizationId: string }) => Promise<{
    balance: number;
    minBalance: number;
    isEligible: boolean;
    accessLevel: 'full' | 'limited' | 'blocked';
  }>;
  listGitHubRepositories: (input: {
    organizationId: string;
    forceRefresh: boolean;
  }) => Promise<unknown>;
  listGitLabRepositories: (input: {
    organizationId: string;
    forceRefresh: boolean;
  }) => Promise<unknown>;
  refreshTerminalTicket: (input: {
    organizationId: string;
    cloudAgentSessionId: string;
    ptyId: string;
  }) => Promise<{ ticket: string; wsUrl: string }>;
  createTerminal: (input: {
    organizationId: string;
    cloudAgentSessionId: string;
  }) => Promise<unknown>;
  resizeTerminal: (input: {
    organizationId: string;
    cloudAgentSessionId: string;
    ptyId: string;
    cols: number;
    rows: number;
  }) => Promise<unknown>;
  closeTerminal: (input: {
    organizationId: string;
    cloudAgentSessionId: string;
    ptyId: string;
  }) => Promise<unknown>;
};

beforeAll(async () => {
  const { createCallerFactory } = await import('@/lib/trpc/init');
  const mod = await import('./organization-cloud-agent-next-router');
  createCaller = createCallerFactory(mod.organizationCloudAgentNextRouter);
});

beforeEach(() => {
  mockEnsureOrganizationAccess.mockReset().mockResolvedValue('member');
});

describe('organizationCloudAgentNextRouter.getSandboxStatus', () => {
  const cloudAgentSessionId = 'workspace_12345678-1234-4234-9234-123456789abc';
  const user = { id: 'oauth/provider:status-owner', is_admin: false } as User;
  const input = { organizationId: ORGANIZATION_ID, cloudAgentSessionId };
  const snapshot = {
    status: 'active',
    provider: 'Cloudflare',
    observedAt: 1_800_000_000_000,
    detailCode: 'sandbox_ready',
    inactivityTimeoutMs: 300_000,
    estimatedSleepAt: 1_800_000_060_000,
  } satisfies SandboxStatusSnapshot;

  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyOrgOwnsSessionV2ByCloudAgentId.mockReset().mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    mockGetSandboxStatus.mockReset().mockResolvedValue(snapshot);
  });

  it('requires exact organization creator access before observation without paid execution checks', async () => {
    mockVerifyOrgOwnsSessionV2ByCloudAgentId.mockImplementationOnce(async () => {
      expect(mockGetSandboxStatus).not.toHaveBeenCalled();
      expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
      return { kiloSessionId: 'ses_12345678901234567890123456' };
    });
    await expect(createCaller({ user }).getSandboxStatus(input)).resolves.toEqual(snapshot);
    expect(mockEnsureOrganizationAccess).toHaveBeenCalledWith(
      expect.objectContaining({ user }),
      ORGANIZATION_ID
    );
    expect(mockVerifyOrgOwnsSessionV2ByCloudAgentId).toHaveBeenCalledWith(
      expect.anything(),
      ORGANIZATION_ID,
      user.id,
      cloudAgentSessionId
    );
    expect(mockGetSandboxStatus).toHaveBeenCalledWith(cloudAgentSessionId);
    expect(mockCreateCloudAgentNextClient).toHaveBeenCalledWith('cloud-agent-token');
    expect(mockCreateCloudAgentNextClientForModel).not.toHaveBeenCalled();
    expect(mockComputeCloudAgentNextBalanceCheckEligibility).not.toHaveBeenCalled();
    expect(mockGetBalanceForOrganizationUser).not.toHaveBeenCalled();
  });

  it.each([
    'agent_12345678-1234-4234-9234-123456789abc',
    'ses_12345678901234567890123456',
    'workspace_',
    'workspace_pending',
    'workspace_../../private',
    `${cloudAgentSessionId} `,
    '',
  ])('rejects invalid reference %s before session or Worker lookup', async invalidId => {
    await expect(
      createCaller({ user }).getSandboxStatus({ ...input, cloudAgentSessionId: invalidId })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockVerifyOrgOwnsSessionV2ByCloudAgentId).not.toHaveBeenCalled();
    expect(mockGetSandboxStatus).not.toHaveBeenCalled();
    expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
  });

  it.each([
    'provider',
    'ownerId',
    'userId',
    'orgId',
    'sandboxId',
    'providerInstanceId',
    'observedAt',
    'inactivityTimeoutMs',
    'estimatedSleepAt',
  ])('rejects caller override %s', async field => {
    await expect(
      createCaller({ user }).getSandboxStatus({ ...input, [field]: 'private-override' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockVerifyOrgOwnsSessionV2ByCloudAgentId).not.toHaveBeenCalled();
    expect(mockGetSandboxStatus).not.toHaveBeenCalled();
  });

  it('denies removed members before querying session status', async () => {
    mockEnsureOrganizationAccess.mockImplementationOnce(() => {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Organization access denied' });
    });
    await expect(createCaller({ user }).getSandboxStatus(input)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockVerifyOrgOwnsSessionV2ByCloudAgentId).not.toHaveBeenCalled();
    expect(mockGetSandboxStatus).not.toHaveBeenCalled();
  });

  it('requires session ownership even when organization membership succeeds', async () => {
    mockVerifyOrgOwnsSessionV2ByCloudAgentId.mockResolvedValueOnce(null);
    await expect(createCaller({ user }).getSandboxStatus(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Session not found or access denied',
    });
    expect(mockEnsureOrganizationAccess).toHaveBeenCalledTimes(1);
    expect(mockGetSandboxStatus).not.toHaveBeenCalled();
    expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
  });

  it.each(['development', 'production'] as const)(
    'sanitizes early membership failures in %s responses and error reporting',
    async nodeEnv => {
      const { ensureOrganizationAccess } = jest.requireActual<typeof OrganizationUtilsModule>(
        '@/routers/organizations/utils'
      );
      const { organizationCloudAgentNextRouter } =
        await import('./organization-cloud-agent-next-router');
      const env = jest.replaceProperty(process.env, 'NODE_ENV', nodeEnv);
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const select = jest.spyOn(db, 'select').mockImplementationOnce(() => {
        throw new DrizzleQueryError(
          'select private-membership-query from organization_memberships',
          ['private-membership-parameter'],
          new Error('private-membership-database-cause')
        );
      });
      mockEnsureOrganizationAccess.mockImplementationOnce(ensureOrganizationAccess);
      const onError = jest.fn<({ error }: { error: TRPCError }) => void>();

      try {
        const url = new URL('http://localhost/api/trpc/getSandboxStatus');
        url.searchParams.set('input', JSON.stringify(input));
        const response = await fetchRequestHandler({
          endpoint: '/api/trpc',
          req: new Request(url),
          router: organizationCloudAgentNextRouter,
          createContext: async () => ({ user }),
          onError,
        });
        const body = await response.text();

        expect(response.status).toBe(403);
        expect(JSON.parse(body)).toMatchObject({
          error: {
            message: 'Session not found or access denied',
            data: { code: 'FORBIDDEN' },
          },
        });
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({
            error: expect.objectContaining({
              code: 'FORBIDDEN',
              message: 'Session not found or access denied',
              cause: undefined,
            }),
          })
        );
        expect(
          inspect(
            [body, onError.mock.calls, log.mock.calls, warn.mock.calls, errorLog.mock.calls],
            {
              depth: null,
            }
          )
        ).not.toContain('private-membership');
        expect(select).toHaveBeenCalledTimes(1);
        expect(mockVerifyOrgOwnsSessionV2ByCloudAgentId).not.toHaveBeenCalled();
        expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
        expect(mockGetSandboxStatus).not.toHaveBeenCalled();
      } finally {
        select.mockRestore();
        errorLog.mockRestore();
        warn.mockRestore();
        log.mockRestore();
        env.restore();
      }
    }
  );

  it('fails closed without leaking unavailable authorization storage diagnostics', async () => {
    mockVerifyOrgOwnsSessionV2ByCloudAgentId.mockRejectedValueOnce(
      new Error('private-database-diagnostics')
    );
    await expect(createCaller({ user }).getSandboxStatus(input)).rejects.toMatchObject({
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
    await expect(createCaller({ user }).getSandboxStatus(input)).rejects.toMatchObject({ code });
  });

  it('strips unexpected client fields at the organization output boundary', async () => {
    mockGetSandboxStatus.mockResolvedValueOnce({
      ...snapshot,
      credentials: 'private-token',
      sandboxId: 'private-runtime',
    } as SandboxStatusSnapshot);
    const response = await createCaller({ user }).getSandboxStatus(input);
    expect(response).toEqual(snapshot);
    expect(JSON.stringify(response)).not.toContain('private');
  });
});

describe('organizationCloudAgentNextRouter attachment forwarding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyOrgOwnsSessionV2ByCloudAgentId.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    mockComputeCloudAgentNextBalanceCheckEligibility.mockResolvedValue({
      isFree: false,
      hasUserByokAvailable: false,
    });
    mockGetSession.mockResolvedValue({ model: 'kilo/paid-model' });
  });

  it('denies an inaccessible organization session before calling the Worker', async () => {
    mockVerifyOrgOwnsSessionV2ByCloudAgentId.mockResolvedValueOnce(null);
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    await expect(
      caller.sendMessage({
        organizationId: ORGANIZATION_ID,
        cloudAgentSessionId: 'agent_123',
        payload: { type: 'prompt', prompt: 'Read notes', mode: 'code', model: 'test' },
      })
    ).rejects.toThrow('Organization does not own this session');

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('forwards canonical document attachments without organization middleware fields', async () => {
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });
    const attachments = {
      path: '12345678-1234-4234-9234-123456789abc',
      files: ['87654321-4321-4321-8321-cba987654321.md'],
    };

    await caller.sendMessage({
      organizationId: ORGANIZATION_ID,
      cloudAgentSessionId: 'agent_123',
      payload: { type: 'prompt', prompt: 'Read notes', mode: 'code', model: 'test' },
      attachments,
    });

    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({ attachments }));
    expect(mockSendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORGANIZATION_ID })
    );
  });

  it('normalizes legacy image requests to canonical Worker attachments', async () => {
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });
    const images = {
      path: '12345678-1234-4234-9234-123456789abc',
      files: ['87654321-4321-4321-8321-cba987654321.png'],
    };

    await caller.sendMessage({
      organizationId: ORGANIZATION_ID,
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
      organizationId: ORGANIZATION_ID,
      cloudAgentSessionId: 'agent_123',
      payload: {
        type: 'prompt',
        prompt: 'Follow up on this',
        mode: 'code',
        model: 'kilo/free-model',
      },
    });

    expect(mockComputeCloudAgentNextBalanceCheckEligibility).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'kilo/free-model',
        organizationId: ORGANIZATION_ID,
      })
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
      organizationId: ORGANIZATION_ID,
      cloudAgentSessionId: 'agent_123',
      payload: { type: 'command', command: 'review', arguments: '' },
    });

    expect(mockGetSession).toHaveBeenCalledWith('agent_123');
    expect(mockComputeCloudAgentNextBalanceCheckEligibility).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'kilo/free-model',
        organizationId: ORGANIZATION_ID,
      })
    );
    expect(mockCreateCloudAgentNextClientForModel).toHaveBeenCalledWith('cloud-agent-token', {
      isFree: true,
      hasUserByokAvailable: false,
    });
  });

  it('keeps the balance check for command turns on paid organization sessions', async () => {
    mockGetSession.mockResolvedValueOnce({ model: 'kilo/paid-model' });
    const caller = createCaller({ user: { id: 'user-paid', is_admin: false } as User });

    await caller.sendMessage({
      organizationId: ORGANIZATION_ID,
      cloudAgentSessionId: 'agent_123',
      payload: { type: 'command', command: 'review', arguments: '' },
    });

    expect(mockGetSession).toHaveBeenCalledWith('agent_123');
    expect(mockComputeCloudAgentNextBalanceCheckEligibility).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'kilo/paid-model',
        organizationId: ORGANIZATION_ID,
      })
    );
    expect(mockCreateCloudAgentNextClientForModel).toHaveBeenCalledWith('cloud-agent-token', {
      isFree: false,
      hasUserByokAvailable: false,
    });
  });

  it('falls back to the balance-checked client when the organization session model is unavailable', async () => {
    mockGetSession.mockResolvedValueOnce({ model: undefined });
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    await caller.sendMessage({
      organizationId: ORGANIZATION_ID,
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
      organizationId: ORGANIZATION_ID,
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

  it('signs Cloud Agent document uploads within authenticated organization access', async () => {
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });
    await caller.getAttachmentUploadUrl({
      organizationId: ORGANIZATION_ID,
      messageUuid: '12345678-1234-4234-9234-123456789abc',
      attachmentId: '87654321-4321-4321-8321-cba987654321',
      contentType: 'text/markdown',
      contentLength: 42,
    });

    expect(mockGenerateCloudAgentAttachmentUploadUrl).toHaveBeenCalledWith({
      userId: 'user-1',
      messageUuid: '12345678-1234-4234-9234-123456789abc',
      attachmentId: '87654321-4321-4321-8321-cba987654321',
      contentType: 'text/markdown',
      contentLength: 42,
    });
  });
});

describe('organizationCloudAgentNextRouter.cancelQueuedMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureOrganizationAccess.mockResolvedValue('member');
    mockVerifyOrgOwnsSessionV2ByCloudAgentId.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    mockCancelQueuedMessage.mockResolvedValue({ dropped: true });
  });

  it('denies canceling a queued message on a session outside the organization', async () => {
    mockVerifyOrgOwnsSessionV2ByCloudAgentId.mockResolvedValueOnce(null);
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });

    await expect(
      caller.cancelQueuedMessage({
        organizationId: ORGANIZATION_ID,
        sessionId: 'agent_123',
        messageId: 'msg_123456789abc123456789ABCDE',
      })
    ).rejects.toThrow('Organization does not own this session');

    expect(mockCancelQueuedMessage).not.toHaveBeenCalled();
  });
});

describe('organizationCloudAgentNextRouter helper procedures', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureOrganizationAccess.mockResolvedValue('member');
    mockOrderRepositoriesByUsage.mockImplementation(async ({ repositories }) => repositories);
  });

  it.each([
    { balance: 1, isEligible: true, accessLevel: 'full' as const },
    { balance: 0.99, isEligible: false, accessLevel: 'limited' as const },
  ])(
    'reports organization eligibility for a $balance balance',
    async ({ balance, isEligible, accessLevel }) => {
      mockGetBalanceForOrganizationUser.mockResolvedValue({ balance });
      const caller = createCaller({ user: { id: 'member-user', is_admin: false } as User });

      await expect(caller.checkEligibility({ organizationId: ORGANIZATION_ID })).resolves.toEqual({
        balance,
        minBalance: 1,
        isEligible,
        accessLevel,
      });
      expect(mockEnsureOrganizationAccess).toHaveBeenCalledWith(
        expect.objectContaining({ user: { id: 'member-user', is_admin: false } }),
        ORGANIZATION_ID
      );
      expect(mockGetBalanceForOrganizationUser).toHaveBeenCalledWith(
        ORGANIZATION_ID,
        'member-user'
      );
      expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
    }
  );

  it('rejects eligibility checks before reading balance when membership is denied', async () => {
    mockEnsureOrganizationAccess.mockImplementation(() => {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You do not have access to this organization',
      });
    });
    const caller = createCaller({ user: { id: 'non-member', is_admin: false } as User });

    await expect(caller.checkEligibility({ organizationId: ORGANIZATION_ID })).rejects.toThrow(
      'You do not have access to this organization'
    );
    expect(mockGetBalanceForOrganizationUser).not.toHaveBeenCalled();
  });

  it.each([
    ['GitHub', 'listGitHubRepositories', mockFetchGitHubRepositoriesForOrganization, 'github'],
    ['GitLab', 'listGitLabRepositories', mockFetchGitLabRepositoriesForOrganization, 'gitlab'],
  ] as const)(
    'lists organization %s repositories without creating a runtime client',
    async (platform, method, fetchRepositories, platformKey) => {
      const repositories = {
        repositories: [],
        integrationInstalled: true,
        syncedAt: null,
      };
      fetchRepositories.mockResolvedValue(repositories);
      const caller = createCaller({ user: { id: 'member-user', is_admin: false } as User });

      await expect(
        caller[method]({ organizationId: ORGANIZATION_ID, forceRefresh: true })
      ).resolves.toEqual(repositories);
      expect(mockEnsureOrganizationAccess).toHaveBeenCalledWith(
        expect.objectContaining({ user: { id: 'member-user', is_admin: false } }),
        ORGANIZATION_ID
      );
      if (platform === 'GitLab') {
        expect(mockFetchGitLabRepositoriesForOrganization).toHaveBeenCalledWith(
          ORGANIZATION_ID,
          'member-user',
          true
        );
      } else {
        expect(mockFetchGitHubRepositoriesForOrganization).toHaveBeenCalledWith(
          ORGANIZATION_ID,
          true
        );
      }
      expect(mockOrderRepositoriesByUsage).toHaveBeenCalledWith({
        userId: 'member-user',
        organizationId: ORGANIZATION_ID,
        platform: platformKey,
        repositories: [],
      });
      expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
    }
  );

  it('rejects organization repository listing before ranking when membership is denied', async () => {
    mockEnsureOrganizationAccess.mockImplementation(() => {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You do not have access to this organization',
      });
    });
    const caller = createCaller({ user: { id: 'non-member', is_admin: false } as User });

    await expect(
      caller.listGitHubRepositories({ organizationId: ORGANIZATION_ID, forceRefresh: false })
    ).rejects.toThrow('You do not have access to this organization');
    expect(mockFetchGitHubRepositoriesForOrganization).not.toHaveBeenCalled();
    expect(mockOrderRepositoriesByUsage).not.toHaveBeenCalled();
  });

  it('passes the organization GitLab instance URL to repository ranking', async () => {
    const repositories = [{ id: 1, name: 'repo', fullName: 'acme/repo', private: false }];
    mockFetchGitLabRepositoriesForOrganization.mockResolvedValue({
      repositories,
      integrationInstalled: true,
      syncedAt: null,
      instanceUrl: 'https://gitlab.example.com',
    });
    const caller = createCaller({ user: { id: 'member-user', is_admin: false } as User });

    await caller.listGitLabRepositories({ organizationId: ORGANIZATION_ID, forceRefresh: false });

    expect(mockOrderRepositoriesByUsage).toHaveBeenCalledWith({
      userId: 'member-user',
      organizationId: ORGANIZATION_ID,
      platform: 'gitlab',
      repositories,
      gitlabInstanceUrl: 'https://gitlab.example.com',
    });
  });

  it('does not expose the organization GitLab instance URL in the output shape', async () => {
    mockFetchGitLabRepositoriesForOrganization.mockResolvedValue({
      repositories: [],
      integrationInstalled: true,
      syncedAt: null,
      instanceUrl: 'https://gitlab.example.com',
    });
    const caller = createCaller({ user: { id: 'member-user', is_admin: false } as User });

    const result = await caller.listGitLabRepositories({
      organizationId: ORGANIZATION_ID,
      forceRefresh: false,
    });

    expect(result).toEqual({ repositories: [], integrationInstalled: true, syncedAt: null });
    expect(result).not.toHaveProperty('instanceUrl');
  });

  it('propagates organization provider fetch errors without swallowing them', async () => {
    mockFetchGitHubRepositoriesForOrganization.mockRejectedValueOnce(new Error('provider down'));
    const caller = createCaller({ user: { id: 'member-user', is_admin: false } as User });

    await expect(
      caller.listGitHubRepositories({ organizationId: ORGANIZATION_ID, forceRefresh: false })
    ).rejects.toThrow('provider down');
    expect(mockOrderRepositoriesByUsage).not.toHaveBeenCalled();
  });
});

describe('organizationCloudAgentNextRouter terminal ownership', () => {
  const organizationCloudAgentSessionId = 'agent_terminal_ticket_org_owned';
  const personalCloudAgentSessionId = 'agent_terminal_ticket_org_personal';

  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureOrganizationAccess.mockResolvedValue('member');
  });

  it('issues a terminal ticket for a session owned by the organization', async () => {
    mockVerifyOrgOwnsSessionV2ByCloudAgentId.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    const caller = createCaller({ user: { id: 'member-user', is_admin: false } as User });

    const result = await caller.refreshTerminalTicket({
      organizationId: ORGANIZATION_ID,
      cloudAgentSessionId: organizationCloudAgentSessionId,
      ptyId: 'pty_org_owned',
    });

    expect(result.ticket).toEqual(expect.any(String));
    expect(result.wsUrl).toContain(`cloudAgentSessionId=${organizationCloudAgentSessionId}`);
  });

  it.each([
    ['refreshing a ticket', 'refreshTerminalTicket'],
    ['creating a terminal', 'createTerminal'],
    ['resizing a terminal', 'resizeTerminal'],
    ['closing a terminal', 'closeTerminal'],
  ] as const)('rejects %s for a session outside the organization', async (_, method) => {
    mockVerifyOrgOwnsSessionV2ByCloudAgentId.mockResolvedValue(null);
    const caller = createCaller({ user: { id: 'member-user', is_admin: false } as User });
    const baseInput = {
      organizationId: ORGANIZATION_ID,
      cloudAgentSessionId: personalCloudAgentSessionId,
    };

    const call =
      method === 'refreshTerminalTicket'
        ? caller.refreshTerminalTicket({ ...baseInput, ptyId: 'pty_org_other' })
        : method === 'createTerminal'
          ? caller.createTerminal(baseInput)
          : method === 'resizeTerminal'
            ? caller.resizeTerminal({
                ...baseInput,
                ptyId: 'pty_org_other',
                cols: 120,
                rows: 32,
              })
            : caller.closeTerminal({ ...baseInput, ptyId: 'pty_org_other' });

    await expect(call).rejects.toThrow('Organization does not own this session');
  });
});

describe('organizationCloudAgentNextRouter.prepareSession', () => {
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

  it('derives browser provenance from the authenticated organization request', async () => {
    const caller = createCaller({
      user: { id: 'organization-browser', is_admin: false } as User,
      headersList: new Headers({ 'x-kilo-client': 'web' }),
    });

    await caller.prepareSession({
      organizationId: ORGANIZATION_ID,
      prompt: 'Test prompt',
      mode: 'code',
      model: 'kilo/test-model',
      githubRepo: 'acme/repo',
      autoInitiate: true,
    });

    expect(mockPrepareSession).toHaveBeenCalledWith(
      expect.objectContaining({
        kilocodeOrganizationId: ORGANIZATION_ID,
        createdOnPlatform: 'cloud-agent-web',
        clientProvenance: 'browser',
      })
    );
  });

  it('derives mobile provenance even when organization input attempts to forge browser provenance', async () => {
    const caller = createCaller({
      user: { id: 'organization-mobile', is_admin: false } as User,
      headersList: new Headers({
        'x-kilo-client': 'mobile',
        'x-kilo-app-platform': 'android',
        'x-kilo-app-version': '1.0.0',
      }),
    });

    await caller.prepareSession({
      organizationId: ORGANIZATION_ID,
      prompt: 'Test prompt',
      mode: 'code',
      model: 'kilo/test-model',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      clientProvenance: 'browser',
    } as z.infer<typeof basePrepareSessionNextSchema> & { organizationId: string });

    expect(mockPrepareSession).toHaveBeenCalledWith(
      expect.objectContaining({
        kilocodeOrganizationId: ORGANIZATION_ID,
        createdOnPlatform: 'cloud-agent-web',
        clientProvenance: 'mobile',
      })
    );
  });

  it('rejects devcontainer sessions when the feature flag is disabled', async () => {
    mockIsFeatureFlagEnabledOrDevelopment.mockResolvedValue(false);
    const caller = createCaller({
      user: { id: 'user-1', is_admin: true } as User,
    });

    await expect(
      caller.prepareSession({
        organizationId: ORGANIZATION_ID,
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
      ORGANIZATION_ID
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
      organizationId: ORGANIZATION_ID,
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

  it('forwards stable Bitbucket identity for organization sessions', async () => {
    mockIsFeatureFlagEnabledOrDevelopment.mockResolvedValue(true);
    const caller = createCaller({ user: { id: 'user-2', is_admin: false } as User });

    await caller.prepareSession({
      organizationId: ORGANIZATION_ID,
      prompt: 'Test prompt',
      mode: 'code',
      model: 'kilo/test-model',
      bitbucketRepo: {
        fullName: 'acme/repo',
        workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
        repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
      },
      autoInitiate: true,
      devcontainer: false,
    });

    expect(mockPrepareSession).toHaveBeenCalledWith(
      expect.objectContaining({
        gitUrl: 'https://bitbucket.org/acme/repo.git',
        platform: 'bitbucket',
        bitbucketWorkspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
        bitbucketRepositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
        kilocodeOrganizationId: ORGANIZATION_ID,
      })
    );
    expect(mockPrepareSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ bitbucketRepo: expect.anything() })
    );
  });

  it('forwards devcontainer sessions when the feature flag is enabled', async () => {
    mockIsFeatureFlagEnabledOrDevelopment.mockResolvedValue(true);
    const caller = createCaller({
      user: { id: 'user-2', is_admin: false } as User,
    });

    await expect(
      caller.prepareSession({
        organizationId: ORGANIZATION_ID,
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
      ORGANIZATION_ID
    );
    expect(mockPrepareSession).toHaveBeenCalledWith(
      expect.objectContaining({
        githubRepo: 'acme/repo',
        devcontainer: true,
        kilocodeOrganizationId: ORGANIZATION_ID,
      })
    );
  });

  it('routes free models through the AppBuilder client so the worker skips the balance minimum', async () => {
    mockComputeCloudAgentNextBalanceCheckEligibility.mockResolvedValueOnce({
      isFree: true,
      hasUserByokAvailable: false,
    });
    const caller = createCaller({ user: { id: 'user-free', is_admin: false } as User });

    await caller.prepareSession({
      organizationId: ORGANIZATION_ID,
      prompt: 'Test prompt',
      mode: 'code',
      model: 'kilo/test-model',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      devcontainer: false,
    });

    expect(mockComputeCloudAgentNextBalanceCheckEligibility).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'kilo/test-model',
        organizationId: ORGANIZATION_ID,
      })
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
    const caller = createCaller({ user: { id: 'user-byok', is_admin: false } as User });

    await caller.prepareSession({
      organizationId: ORGANIZATION_ID,
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

  it('routes paid models the org has no BYOK key for through the model-aware helper with a paid eligibility', async () => {
    const caller = createCaller({ user: { id: 'user-paid', is_admin: false } as User });

    await caller.prepareSession({
      organizationId: ORGANIZATION_ID,
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
    const caller = createCaller({ user: { id: 'user-1', is_admin: false } as User });
    const cloneFromKiloSessionId = 'ses_12345678901234567890123456';

    await caller.prepareSession({
      organizationId: ORGANIZATION_ID,
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

describe('organizationCloudAgentNextRouter.createWorktreeChat', () => {
  const uuid = '12345678-1234-4234-9234-123456789abc';
  const sourceKiloSessionId = 'ses_12345678901234567890123456';
  const result = {
    kiloSessionId: 'ses_abcdefghijklmnopqrstuvwxyz',
    cloudAgentSessionId: `workspace_${uuid}` as const,
    worktreeId: `worktree_${uuid}` as const,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureOrganizationAccess.mockResolvedValue('member');
    mockCreateWorktreeChat.mockResolvedValue(result);
  });

  it('requires current membership and forwards the exact organization and authenticated owner', async () => {
    const user = { id: 'organization-owner', is_admin: false } as User;
    const headersList = new Headers({ 'x-kilo-client': 'web' });
    const caller = createCaller({ user, headersList });

    await expect(
      caller.createWorktreeChat({
        organizationId: ORGANIZATION_ID,
        sourceKiloSessionId,
        operationKey: uuid,
      })
    ).resolves.toEqual(result);

    expect(mockEnsureOrganizationAccess).toHaveBeenCalledWith(
      expect.objectContaining({ user }),
      ORGANIZATION_ID
    );
    expect(mockCreateWorktreeChat).toHaveBeenCalledWith({
      user,
      headersList,
      sourceKiloSessionId,
      operationKey: uuid,
      organizationId: ORGANIZATION_ID,
    });
  });

  it('rejects a revoked organization member before resolving the source session', async () => {
    mockEnsureOrganizationAccess.mockImplementation(() => {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You do not have access to this organization',
      });
    });
    const caller = createCaller({ user: { id: 'revoked-member', is_admin: false } as User });

    await expect(
      caller.createWorktreeChat({
        organizationId: ORGANIZATION_ID,
        sourceKiloSessionId,
        operationKey: uuid,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(mockCreateWorktreeChat).not.toHaveBeenCalled();
  });

  it('rejects untrusted provenance and organization identifiers before invoking the operation', async () => {
    const caller = createCaller({ user: { id: 'organization-owner', is_admin: false } as User });

    for (const input of [
      { organizationId: 'invalid-organization', sourceKiloSessionId, operationKey: uuid },
      {
        organizationId: ORGANIZATION_ID,
        sourceKiloSessionId,
        operationKey: uuid,
        clientProvenance: 'browser',
      },
    ]) {
      await expect(caller.createWorktreeChat(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }

    expect(mockCreateWorktreeChat).not.toHaveBeenCalled();
  });
});

describe('organizationCloudAgentNextRouter Bitbucket repository listing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureOrganizationAccess.mockResolvedValue('member');
    mockOrderRepositoriesByUsage.mockImplementation(async ({ repositories }) => repositories);
  });

  it('forwards exact organization ownership without forcing provider refresh by default', async () => {
    const result = {
      status: 'available' as const,
      repositories: [],
      syncedAt: '2026-06-23T08:00:00.000Z',
    };
    mockFetchBitbucketRepositoriesForOrganization.mockResolvedValue(result);
    const caller = createCaller({ user: { id: 'member-1', is_admin: false } as User });

    await expect(
      caller.listBitbucketRepositories({
        organizationId: ORGANIZATION_ID,
      })
    ).resolves.toEqual(result);
    expect(mockFetchBitbucketRepositoriesForOrganization).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      'member-1',
      false
    );
    expect(mockOrderRepositoriesByUsage).toHaveBeenCalledWith({
      userId: 'member-1',
      organizationId: ORGANIZATION_ID,
      platform: 'bitbucket',
      repositories: [],
    });
  });

  it('lets organization members force-refresh Bitbucket repositories through listing', async () => {
    const result = {
      status: 'available' as const,
      repositories: [],
      syncedAt: '2026-06-23T08:00:00.000Z',
    };
    mockFetchBitbucketRepositoriesForOrganization.mockResolvedValue(result);
    const caller = createCaller({ user: { id: 'member-1', is_admin: false } as User });

    await expect(
      caller.listBitbucketRepositories({
        organizationId: ORGANIZATION_ID,
        forceRefresh: true,
      })
    ).resolves.toEqual(result);
    expect(mockFetchBitbucketRepositoriesForOrganization).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      'member-1',
      true
    );
  });

  it('propagates temporary cache initialization failure distinctly', async () => {
    const result = { status: 'temporarily_unavailable' as const };
    mockFetchBitbucketRepositoriesForOrganization.mockResolvedValue(result);
    const caller = createCaller({ user: { id: 'member-1', is_admin: false } as User });

    await expect(
      caller.listBitbucketRepositories({
        organizationId: ORGANIZATION_ID,
      })
    ).resolves.toEqual(result);
    expect(mockOrderRepositoriesByUsage).not.toHaveBeenCalled();
  });

  it('keeps non-available Bitbucket results exact without ranking', async () => {
    const result = { status: 'not_connected' as const };
    mockFetchBitbucketRepositoriesForOrganization.mockResolvedValue(result);
    const caller = createCaller({ user: { id: 'member-1', is_admin: false } as User });

    await expect(
      caller.listBitbucketRepositories({
        organizationId: ORGANIZATION_ID,
      })
    ).resolves.toEqual(result);
    expect(mockOrderRepositoriesByUsage).not.toHaveBeenCalled();
  });
});
