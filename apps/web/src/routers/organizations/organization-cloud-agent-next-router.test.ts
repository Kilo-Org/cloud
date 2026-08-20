import { describe, expect, it, jest, beforeAll, beforeEach } from '@jest/globals';
import { createCallerFactory } from '@/lib/trpc/init';
import type * as TrpcInitModule from '@/lib/trpc/init';
import type * as ZodModule from 'zod';
import type { User } from '@kilocode/db/schema';
import type * as BitbucketIntegrationHelpers from '@/lib/cloud-agent/bitbucket-integration-helpers';
import type { BitbucketOrganizationRepositoryListResult } from '@/lib/cloud-agent/bitbucket-integration-helpers';
import { TRPCError } from '@trpc/server';

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

const mockCreateCloudAgentNextClient = jest.fn(() => ({
  prepareSession: mockPrepareSession,
  sendMessage: mockSendMessage,
  getSession: mockGetSession,
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
  jest.fn<() => Promise<{ kiloSessionId: string } | null>>();
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
  }>
>();
const mockEnsureOrganizationAccess = jest.fn<(userId: string, organizationId: string) => void>();

jest.mock('@/lib/tokens', () => ({
  generateCloudAgentToken: jest.fn(() => 'cloud-agent-token'),
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: mockCreateCloudAgentNextClient,
  createCloudAgentNextClientForModel: mockCreateCloudAgentNextClientForModel,
  rethrowAsPaymentRequired: jest.fn(),
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
}));

jest.mock('@/lib/cloud-agent/gitlab-integration-helpers', () => ({
  buildGitLabCloneUrl: jest.fn(),
  fetchGitLabRepositoriesForOrganization: mockFetchGitLabRepositoriesForOrganization,
  getGitLabInstanceUrlForOrganization: jest.fn(),
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
      mockEnsureOrganizationAccess(ctx.user.id, input.organizationId);
      return next();
    });

  return {
    organizationMemberProcedure: organizationProcedure,
    organizationMemberMutationProcedure: organizationProcedure,
  };
});

let createCaller: (ctx: { user: User }) => {
  prepareSession: (input: {
    organizationId: string;
    prompt: string;
    mode: string;
    model: string;
    githubRepo?: string;
    bitbucketRepo?: {
      fullName: string;
      workspaceUuid: string;
      repositoryUuid: string;
    };
    autoInitiate: boolean;
    devcontainer: boolean;
    images?: { path: string; files: string[] };
  }) => Promise<{
    cloudAgentSessionId: string;
    kiloSessionId: string;
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
  listBitbucketRepositories: (input: {
    organizationId: string;
    forceRefresh?: boolean;
  }) => Promise<BitbucketOrganizationRepositoryListResult>;
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
  const mod = await import('./organization-cloud-agent-next-router');
  createCaller = createCallerFactory(mod.organizationCloudAgentNextRouter);
});

beforeEach(() => {
  mockEnsureOrganizationAccess.mockImplementation(() => undefined);
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

describe('organizationCloudAgentNextRouter helper procedures', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureOrganizationAccess.mockImplementation(() => undefined);
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
      expect(mockEnsureOrganizationAccess).toHaveBeenCalledWith('member-user', ORGANIZATION_ID);
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
    ['GitHub', 'listGitHubRepositories', mockFetchGitHubRepositoriesForOrganization],
    ['GitLab', 'listGitLabRepositories', mockFetchGitLabRepositoriesForOrganization],
  ] as const)(
    'lists organization %s repositories without creating a runtime client',
    async (platform, method, fetchRepositories) => {
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
      expect(mockEnsureOrganizationAccess).toHaveBeenCalledWith('member-user', ORGANIZATION_ID);
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
      expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
    }
  );
});

describe('organizationCloudAgentNextRouter terminal ownership', () => {
  const organizationCloudAgentSessionId = 'agent_terminal_ticket_org_owned';
  const personalCloudAgentSessionId = 'agent_terminal_ticket_org_personal';

  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureOrganizationAccess.mockImplementation(() => undefined);
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
});

describe('organizationCloudAgentNextRouter Bitbucket repository listing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
  });
});
