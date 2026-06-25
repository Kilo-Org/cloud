import { describe, expect, it, jest, beforeAll, beforeEach } from '@jest/globals';
import { createCallerFactory } from '@/lib/trpc/init';
import type * as TrpcInitModule from '@/lib/trpc/init';
import type { User } from '@kilocode/db/schema';
import type * as BitbucketIntegrationHelpers from '@/lib/cloud-agent/bitbucket-integration-helpers';
import type { BitbucketOrganizationRepositoryListResult } from '@/lib/cloud-agent/bitbucket-integration-helpers';

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

const mockCreateCloudAgentNextClient = jest.fn(() => ({
  prepareSession: mockPrepareSession,
  sendMessage: mockSendMessage,
}));

const mockIsFeatureFlagEnabledOrDevelopment =
  jest.fn<(flagName: string, distinctId: string) => Promise<boolean>>();
const mockVerifyOrgOwnsSessionV2ByCloudAgentId =
  jest.fn<() => Promise<{ kiloSessionId: string } | null>>();
const mockFetchBitbucketRepositoriesForOrganization =
  jest.fn<
    (
      organizationId: string,
      kiloUserId: string
    ) => Promise<BitbucketOrganizationRepositoryListResult>
  >();

jest.mock('@/lib/tokens', () => ({
  generateCloudAgentToken: jest.fn(() => 'cloud-agent-token'),
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: mockCreateCloudAgentNextClient,
  rethrowAsPaymentRequired: jest.fn(),
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

jest.mock('@/lib/r2/cloud-agent-attachments', () => ({
  generateImageUploadUrl: jest.fn(),
  generateCloudAgentAttachmentUploadUrl: mockGenerateCloudAgentAttachmentUploadUrl,
}));

jest.mock('@/lib/cloud-agent/session-ownership', () => ({
  verifyOrgOwnsSessionV2ByCloudAgentId: mockVerifyOrgOwnsSessionV2ByCloudAgentId,
}));

jest.mock('@/routers/organizations/utils', () => {
  const trpcInit = jest.requireActual<typeof TrpcInitModule>('@/lib/trpc/init');

  return {
    organizationMemberProcedure: trpcInit.baseProcedure,
    organizationMemberMutationProcedure: trpcInit.baseProcedure,
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
    payload: { type: 'prompt'; prompt: string; mode: string; model: string };
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
  }) => Promise<BitbucketOrganizationRepositoryListResult>;
};

beforeAll(async () => {
  const mod = await import('./organization-cloud-agent-next-router');
  createCaller = createCallerFactory(mod.organizationCloudAgentNextRouter);
});

describe('organizationCloudAgentNextRouter attachment forwarding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyOrgOwnsSessionV2ByCloudAgentId.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
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

describe('organizationCloudAgentNextRouter.prepareSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrepareSession.mockResolvedValue({
      cloudAgentSessionId: 'agent_123',
      kiloSessionId: 'ses_12345678901234567890123456',
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
});

describe('organizationCloudAgentNextRouter Bitbucket repository listing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards exact organization ownership without a provider-refresh control', async () => {
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
      'member-1'
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
