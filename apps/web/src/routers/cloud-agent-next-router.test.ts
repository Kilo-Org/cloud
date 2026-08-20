import { describe, expect, it, jest, beforeAll, beforeEach } from '@jest/globals';
import { createCallerFactory } from '@/lib/trpc/init';
import type { User } from '@kilocode/db/schema';

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
const mockVerifyUserOwnsSessionV2ByCloudAgentId =
  jest.fn<() => Promise<{ kiloSessionId: string } | null>>();
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
  }>
>();

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

jest.mock('@/lib/r2/cloud-agent-attachments', () => ({
  generateImageUploadUrl: jest.fn(),
  generateCloudAgentAttachmentUploadUrl: mockGenerateCloudAgentAttachmentUploadUrl,
  generateCloudAgentAttachmentDownloadUrl: mockGenerateCloudAgentAttachmentDownloadUrl,
}));

jest.mock('@/lib/cloud-agent/session-ownership', () => ({
  verifyUserOwnsSessionV2ByCloudAgentId: mockVerifyUserOwnsSessionV2ByCloudAgentId,
}));

let createCaller: (ctx: { user: User }) => {
  prepareSession: (input: {
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
    cloudAgentSessionId: string;
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
  const mod = await import('./cloud-agent-next-router');
  createCaller = createCallerFactory(mod.cloudAgentNextRouter);
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

describe('cloudAgentNextRouter helper procedures', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
    ['GitHub', 'listGitHubRepositories', mockFetchGitHubRepositoriesForUser],
    ['GitLab', 'listGitLabRepositories', mockFetchGitLabRepositoriesForUser],
  ] as const)(
    'lists %s repositories without creating a runtime client',
    async (_, method, fetchRepositories) => {
      const repositories = {
        repositories: [],
        integrationInstalled: true,
        syncedAt: null,
      };
      fetchRepositories.mockResolvedValue(repositories);
      const caller = createCaller({ user: { id: 'user-repositories', is_admin: false } as User });

      await expect(caller[method]({ forceRefresh: true })).resolves.toEqual(repositories);
      expect(fetchRepositories).toHaveBeenCalledWith('user-repositories', true);
      expect(mockCreateCloudAgentNextClient).not.toHaveBeenCalled();
    }
  );
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
});
