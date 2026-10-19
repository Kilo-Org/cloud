import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PlatformIntegration } from '@kilocode/db';
import type { CloudAgentAttachments } from '@/lib/cloud-agent/constants';
import type {
  buildGitLabCloneUrl as BuildGitLabCloneUrl,
  getGitLabInstanceUrlForUser as GetGitLabInstanceUrlForUser,
  getGitLabTokenForUser as GetGitLabTokenForUser,
} from '@/lib/cloud-agent/gitlab-integration-helpers';
import type { resolveGitHubRepositoryForOwner as ResolveGitHubRepositoryForOwner } from '@/lib/slack-bot/github-repository-context';
import type SpawnCloudAgentSession from './spawn-cloud-agent-session';
import { INSUFFICIENT_CREDITS_RESPONSE } from '@/lib/cloud-agent-next/run-session';

const mockGetGitHubIntegrationById =
  jest.fn<(...args: unknown[]) => Promise<PlatformIntegration | null>>();

// Hoisted jest fns referenced from the jest.mock factories below; typed
// loosely to avoid re-instantiating the factories' drizzle generics.
const mockCreateCloudAgentNextClient = jest.fn<(...args: unknown[]) => unknown>();
const mockCreateCloudAgentNextClientForModel = jest.fn<(...args: unknown[]) => unknown>();
const mockComputeCloudAgentNextBalanceCheckEligibility =
  jest.fn<(...args: unknown[]) => Promise<{ isFree: boolean; hasUserByokAvailable: boolean }>>();

jest.mock('@/lib/web-config.server', () => ({
  CALLBACK_TOKEN_SECRET: 'callback-secret',
}));

jest.mock('@kilocode/web-shared/lib/constants', () => ({
  APP_URL: 'https://app.example.test',
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: mockCreateCloudAgentNextClient,
  createCloudAgentNextClientForModel: mockCreateCloudAgentNextClientForModel,
  InsufficientCreditsError: class InsufficientCreditsError extends Error {
    readonly httpStatus = 402;
    readonly code = 'PAYMENT_REQUIRED';
    constructor(message = 'Insufficient credits: $1 minimum required') {
      super(message);
      this.name = 'InsufficientCreditsError';
    }
  },
}));

jest.mock('@/lib/cloud-agent-next/balance-check-eligibility', () => ({
  computeCloudAgentNextBalanceCheckEligibility: mockComputeCloudAgentNextBalanceCheckEligibility,
}));

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {},
}));

jest.mock('@/lib/slack-bot/github-repository-context', () => ({
  resolveGitHubRepositoryForOwner: jest.fn(),
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getGitHubIntegrationById: (...args: unknown[]) => mockGetGitHubIntegrationById(...args),
}));

jest.mock('@/lib/cloud-agent/gitlab-integration-helpers', () => ({
  getGitLabTokenForOrganization: jest.fn(),
  getGitLabTokenForUser: jest.fn(),
  getGitLabInstanceUrlForOrganization: jest.fn(),
  getGitLabInstanceUrlForUser: jest.fn(),
  buildGitLabCloneUrl: jest.fn(),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

const userIntegration = {
  owned_by_organization_id: null,
  owned_by_user_id: 'owner-1',
} as PlatformIntegration;
const organizationIntegration = {
  owned_by_organization_id: 'organization-1',
  owned_by_user_id: null,
} as PlatformIntegration;
const attachments: CloudAgentAttachments = {
  path: 'message-attachments',
  files: ['image.png', 'requirements.md'],
};
const profileDerivedInlineFields = [
  'envVars',
  'encryptedSecrets',
  'setupCommands',
  'mcpServers',
  'runtimeSkills',
  'runtimeAgents',
] as const;

const mockPrepareSession =
  jest.fn<(input: unknown) => Promise<{ cloudAgentSessionId: string; kiloSessionId: string }>>();
const mockInitiateFromPreparedSession = jest.fn<(input: unknown) => Promise<unknown>>();
const mockCleanupSession = jest.fn<(sessionId: string) => Promise<{ success: boolean }>>();
let spawnCloudAgentSession: typeof SpawnCloudAgentSession;
let mockResolveGitHubRepositoryForOwner: jest.MockedFunction<
  typeof ResolveGitHubRepositoryForOwner
>;
let mockGetGitLabTokenForUser: jest.MockedFunction<typeof GetGitLabTokenForUser>;
let mockGetGitLabInstanceUrlForUser: jest.MockedFunction<typeof GetGitLabInstanceUrlForUser>;
let mockBuildGitLabCloneUrl: jest.MockedFunction<typeof BuildGitLabCloneUrl>;

describe('spawnCloudAgentSession delegation', () => {
  // Dynamic imports keep the mocked modules' lazy `server-only` / config
  // side effects from running before jest.mock factories are registered.
  beforeAll(async () => {
    const githubRepositoryContext = await import('@/lib/slack-bot/github-repository-context');
    const gitlab = await import('@/lib/cloud-agent/gitlab-integration-helpers');
    const spawn = await import('./spawn-cloud-agent-session');

    mockResolveGitHubRepositoryForOwner = jest.mocked(
      githubRepositoryContext.resolveGitHubRepositoryForOwner
    );
    mockGetGitLabTokenForUser = jest.mocked(gitlab.getGitLabTokenForUser);
    mockGetGitLabInstanceUrlForUser = jest.mocked(gitlab.getGitLabInstanceUrlForUser);
    mockBuildGitLabCloneUrl = jest.mocked(gitlab.buildGitLabCloneUrl);
    spawnCloudAgentSession = spawn.default;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockComputeCloudAgentNextBalanceCheckEligibility.mockResolvedValue({
      isFree: false,
      hasUserByokAvailable: false,
    });
    mockCreateCloudAgentNextClientForModel.mockImplementation(
      token => mockCreateCloudAgentNextClient(token) as never
    );
    mockCreateCloudAgentNextClient.mockReturnValue({
      prepareSession: mockPrepareSession,
      initiateFromPreparedSession: mockInitiateFromPreparedSession,
      cleanupSession: mockCleanupSession,
    } as never);
    mockPrepareSession.mockResolvedValue({
      cloudAgentSessionId: 'cloud-session-1',
      kiloSessionId: 'kilo-session-1',
    });
    mockInitiateFromPreparedSession.mockResolvedValue({});
    mockResolveGitHubRepositoryForOwner.mockResolvedValue({
      id: 1,
      name: 'repo',
      full_name: 'owner/repo',
      private: true,
      githubIntegrationId: 'github-association-1',
      githubAppType: 'standard',
    });
    mockGetGitHubIntegrationById.mockResolvedValue({
      ...userIntegration,
      id: 'github-association-1',
      repositories: [{ id: 1, name: 'repo', full_name: 'owner/repo', private: true }],
    });
    mockGetGitLabTokenForUser.mockResolvedValue('gitlab-token');
    mockGetGitLabInstanceUrlForUser.mockResolvedValue('https://gitlab.com');
    mockBuildGitLabCloneUrl.mockReturnValue('https://gitlab.com/group/repo.git');
  });

  it('delegates GitHub profile resolution while preserving repository and organization context', async () => {
    const onSessionReady = jest.fn();

    await spawnCloudAgentSession(
      { githubRepo: 'owner/repo', prompt: 'Use the files', mode: 'code' },
      'model',
      organizationIntegration,
      'auth-token',
      'request-1',
      onSessionReady,
      { attachments, chatPlatform: 'slack' }
    );

    const prepareInput = mockPrepareSession.mock.calls[0]?.[0];
    expect(prepareInput).toEqual(
      expect.objectContaining({
        githubRepo: 'owner/repo',
        githubIntegrationId: 'github-association-1',
        kilocodeOrganizationId: 'organization-1',
        createdOnPlatform: 'slack',
        attachments,
        callbackTarget: expect.objectContaining({
          url: expect.stringContaining('/api/internal/bot-session-callback/request-1'),
          headers: { 'X-Bot-Callback-Token': expect.any(String) },
        }),
      })
    );
    expect(prepareInput).not.toHaveProperty('images');
    expect(prepareInput).not.toHaveProperty('githubToken');
    for (const field of profileDerivedInlineFields) {
      expect(prepareInput).not.toHaveProperty(field);
    }
    expect(mockCreateCloudAgentNextClient).toHaveBeenCalledWith('auth-token');
    expect(mockGetGitHubIntegrationById).toHaveBeenCalledWith(
      { type: 'org', id: 'organization-1' },
      'github-association-1'
    );
    expect(mockInitiateFromPreparedSession).toHaveBeenCalledWith({
      cloudAgentSessionId: 'cloud-session-1',
    });
    expect(onSessionReady).toHaveBeenCalledWith({
      cloudAgentSessionId: 'cloud-session-1',
      kiloSessionId: 'kilo-session-1',
    });
  });

  it('rejects GitHub repositories outside the owner inventory', async () => {
    mockResolveGitHubRepositoryForOwner.mockResolvedValue(null);

    await expect(
      spawnCloudAgentSession(
        { githubRepo: 'other/repo', prompt: 'Use the files', mode: 'code' },
        'model',
        organizationIntegration,
        'auth-token',
        'request-unknown'
      )
    ).resolves.toEqual(
      expect.objectContaining({ response: expect.stringContaining('not uniquely available') })
    );
    expect(mockPrepareSession).not.toHaveBeenCalled();
  });

  it('rejects a repository when its selected association is foreign to the owner', async () => {
    mockGetGitHubIntegrationById.mockResolvedValue(null);

    await expect(
      spawnCloudAgentSession(
        { githubRepo: 'owner/repo', prompt: 'Inspect it', mode: 'code' },
        'model',
        organizationIntegration,
        'auth-token',
        'request-foreign'
      )
    ).resolves.toEqual(
      expect.objectContaining({ response: expect.stringContaining('no longer available') })
    );
    expect(mockPrepareSession).not.toHaveBeenCalled();
  });

  it('delegates GitLab profile resolution while preserving canonical repository context', async () => {
    await spawnCloudAgentSession(
      { gitlabProject: 'group/repo', prompt: 'Use the files', mode: 'ask' },
      'model',
      userIntegration,
      'auth-token',
      'request-2',
      undefined,
      { attachments, chatPlatform: 'linear' }
    );

    const prepareInput = mockPrepareSession.mock.calls[0]?.[0];
    expect(prepareInput).toEqual(
      expect.objectContaining({
        gitUrl: 'https://gitlab.com/group/repo.git',
        gitToken: 'gitlab-token',
        platform: 'gitlab',
        kilocodeOrganizationId: undefined,
        createdOnPlatform: 'linear',
        attachments,
      })
    );
    expect(prepareInput).not.toHaveProperty('images');
    for (const field of profileDerivedInlineFields) {
      expect(prepareInput).not.toHaveProperty(field);
    }
  });

  it.each(['slack', 'github', 'linear'])(
    'forwards the %s adapter origin unchanged',
    async origin => {
      await spawnCloudAgentSession(
        { githubRepo: 'owner/repo', prompt: 'Inspect the repository', mode: 'ask' },
        'model',
        userIntegration,
        'auth-token',
        `request-${origin}`,
        undefined,
        { chatPlatform: origin }
      );

      expect(mockPrepareSession).toHaveBeenCalledWith(
        expect.objectContaining({ createdOnPlatform: origin })
      );
      expect(mockGetGitHubIntegrationById).toHaveBeenCalledWith(
        { type: 'user', id: 'owner-1' },
        'github-association-1'
      );
    }
  );

  it('selects the client through model eligibility with the payer user and organization', async () => {
    mockComputeCloudAgentNextBalanceCheckEligibility.mockResolvedValueOnce({
      isFree: true,
      hasUserByokAvailable: false,
    });

    await spawnCloudAgentSession(
      { githubRepo: 'owner/repo', prompt: 'Use the files', mode: 'code' },
      'kilo-auto/free',
      organizationIntegration,
      'auth-token',
      'request-eligible',
      undefined,
      { chatPlatform: 'slack', payerUserId: 'user-9' }
    );

    expect(mockComputeCloudAgentNextBalanceCheckEligibility).toHaveBeenCalledWith(
      expect.objectContaining({
        user: { id: 'user-9' },
        modelId: 'kilo-auto/free',
        organizationId: 'organization-1',
      })
    );
    expect(mockCreateCloudAgentNextClientForModel).toHaveBeenCalledWith('auth-token', {
      isFree: true,
      hasUserByokAvailable: false,
    });
  });

  it('falls back to the balance-checked client when eligibility resolution fails', async () => {
    mockComputeCloudAgentNextBalanceCheckEligibility.mockRejectedValueOnce(new Error('db down'));

    await spawnCloudAgentSession(
      { githubRepo: 'owner/repo', prompt: 'Use the files', mode: 'code' },
      'model',
      userIntegration,
      'auth-token',
      'request-fallback',
      undefined,
      { chatPlatform: 'slack' }
    );

    expect(mockCreateCloudAgentNextClient).toHaveBeenCalledWith('auth-token');
    expect(mockPrepareSession).toHaveBeenCalled();
  });

  it('returns the credits response and starts no session when prepare is rejected for insufficient credits', async () => {
    const { InsufficientCreditsError } = await import('@/lib/cloud-agent-next/cloud-agent-client');
    mockPrepareSession.mockRejectedValueOnce(new InsufficientCreditsError());

    const result = await spawnCloudAgentSession(
      { githubRepo: 'owner/repo', prompt: 'Use the files', mode: 'code' },
      'model',
      userIntegration,
      'auth-token',
      'request-credits',
      undefined,
      { chatPlatform: 'slack' }
    );

    expect(result.response).toBe(INSUFFICIENT_CREDITS_RESPONSE);
    expect(result).not.toHaveProperty('cloudAgentSessionId');
    expect(mockInitiateFromPreparedSession).not.toHaveBeenCalled();
  });

  it('returns the credits response and starts no session when initiate is rejected for insufficient credits', async () => {
    const { InsufficientCreditsError } = await import('@/lib/cloud-agent-next/cloud-agent-client');
    mockInitiateFromPreparedSession.mockRejectedValueOnce(new InsufficientCreditsError());

    const result = await spawnCloudAgentSession(
      { githubRepo: 'owner/repo', prompt: 'Use the files', mode: 'code' },
      'model',
      userIntegration,
      'auth-token',
      'request-credits-initiate',
      undefined,
      { chatPlatform: 'slack' }
    );

    expect(result.response).toBe(INSUFFICIENT_CREDITS_RESPONSE);
    expect(result).not.toHaveProperty('cloudAgentSessionId');
    expect(mockCleanupSession).toHaveBeenCalledWith('cloud-session-1');
  });

  it('falls back to the integration owner for the payer user when none is supplied', async () => {
    mockComputeCloudAgentNextBalanceCheckEligibility.mockResolvedValueOnce({
      isFree: true,
      hasUserByokAvailable: false,
    });

    await spawnCloudAgentSession(
      { githubRepo: 'owner/repo', prompt: 'Use the files', mode: 'code' },
      'kilo-auto/free',
      userIntegration,
      'auth-token',
      'request-owner-payer',
      undefined,
      { chatPlatform: 'slack' }
    );

    expect(mockComputeCloudAgentNextBalanceCheckEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ user: { id: 'owner-1' } })
    );
  });
});
