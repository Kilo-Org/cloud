import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PlatformIntegration } from '@kilocode/db';
import type { CloudAgentAttachments } from '@/lib/cloud-agent/constants';
import type { createCloudAgentNextClient as CreateCloudAgentNextClient } from '@/lib/cloud-agent-next/cloud-agent-client';
import type {
  buildGitLabCloneUrl as BuildGitLabCloneUrl,
  getGitLabInstanceUrlForOrganization as GetGitLabInstanceUrlForOrganization,
  getGitLabInstanceUrlForUser as GetGitLabInstanceUrlForUser,
  getGitLabTokenForOrganization as GetGitLabTokenForOrganization,
  getGitLabTokenForUser as GetGitLabTokenForUser,
  validateGitLabRepoAccessForOrganization as ValidateGitLabRepoAccessForOrganization,
  validateGitLabRepoAccessForUser as ValidateGitLabRepoAccessForUser,
} from '@/lib/cloud-agent/gitlab-integration-helpers';
import type { getBotUserId as GetBotUserId } from '@/lib/bot-users/bot-user-service';
import type { resolveGitHubRepositoryForOwner as ResolveGitHubRepositoryForOwner } from '@/lib/slack-bot/github-repository-context';
import type SpawnCloudAgentSession from './spawn-cloud-agent-session';

const mockGetGitHubIntegrationById =
  jest.fn<(...args: unknown[]) => Promise<PlatformIntegration | null>>();

jest.mock('@/lib/web-config.server', () => ({
  CALLBACK_TOKEN_SECRET: 'callback-secret',
}));

jest.mock('@kilocode/web-shared/lib/constants', () => ({
  APP_URL: 'https://app.example.test',
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: jest.fn(),
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
  validateGitLabRepoAccessForOrganization: jest.fn(),
  validateGitLabRepoAccessForUser: jest.fn(),
}));

jest.mock('@/lib/bot-users/bot-user-service', () => ({
  getBotUserId: jest.fn(),
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
let spawnCloudAgentSession: typeof SpawnCloudAgentSession;
let mockCreateCloudAgentNextClient: jest.MockedFunction<typeof CreateCloudAgentNextClient>;
let mockResolveGitHubRepositoryForOwner: jest.MockedFunction<
  typeof ResolveGitHubRepositoryForOwner
>;
let mockGetGitLabTokenForUser: jest.MockedFunction<typeof GetGitLabTokenForUser>;
let mockGetGitLabTokenForOrganization: jest.MockedFunction<typeof GetGitLabTokenForOrganization>;
let mockGetGitLabInstanceUrlForUser: jest.MockedFunction<typeof GetGitLabInstanceUrlForUser>;
let mockGetGitLabInstanceUrlForOrganization: jest.MockedFunction<
  typeof GetGitLabInstanceUrlForOrganization
>;
let mockBuildGitLabCloneUrl: jest.MockedFunction<typeof BuildGitLabCloneUrl>;
let mockValidateGitLabRepoAccessForUser: jest.MockedFunction<
  typeof ValidateGitLabRepoAccessForUser
>;
let mockValidateGitLabRepoAccessForOrganization: jest.MockedFunction<
  typeof ValidateGitLabRepoAccessForOrganization
>;
let mockGetBotUserId: jest.MockedFunction<typeof GetBotUserId>;

describe('spawnCloudAgentSession delegation', () => {
  beforeAll(async () => {
    // @swc/jest does not hoist `jest.mock` factories above static imports, so
    // the mocked modules are resolved here instead.
    const client = await import('@/lib/cloud-agent-next/cloud-agent-client');
    const githubRepositoryContext = await import('@/lib/slack-bot/github-repository-context');
    const gitlab = await import('@/lib/cloud-agent/gitlab-integration-helpers');
    const botUsers = await import('@/lib/bot-users/bot-user-service');
    const spawn = await import('./spawn-cloud-agent-session');

    mockCreateCloudAgentNextClient = jest.mocked(client.createCloudAgentNextClient);
    mockResolveGitHubRepositoryForOwner = jest.mocked(
      githubRepositoryContext.resolveGitHubRepositoryForOwner
    );
    mockGetGitLabTokenForUser = jest.mocked(gitlab.getGitLabTokenForUser);
    mockGetGitLabTokenForOrganization = jest.mocked(gitlab.getGitLabTokenForOrganization);
    mockGetGitLabInstanceUrlForUser = jest.mocked(gitlab.getGitLabInstanceUrlForUser);
    mockGetGitLabInstanceUrlForOrganization = jest.mocked(
      gitlab.getGitLabInstanceUrlForOrganization
    );
    mockBuildGitLabCloneUrl = jest.mocked(gitlab.buildGitLabCloneUrl);
    mockValidateGitLabRepoAccessForUser = jest.mocked(gitlab.validateGitLabRepoAccessForUser);
    mockValidateGitLabRepoAccessForOrganization = jest.mocked(
      gitlab.validateGitLabRepoAccessForOrganization
    );
    mockGetBotUserId = jest.mocked(botUsers.getBotUserId);
    spawnCloudAgentSession = spawn.default;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateCloudAgentNextClient.mockReturnValue({
      prepareSession: mockPrepareSession,
      initiateFromPreparedSession: mockInitiateFromPreparedSession,
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
    mockGetGitLabTokenForOrganization.mockResolvedValue('gitlab-org-token');
    mockGetGitLabInstanceUrlForUser.mockResolvedValue('https://gitlab.com');
    mockGetGitLabInstanceUrlForOrganization.mockResolvedValue('https://gitlab.com');
    mockBuildGitLabCloneUrl.mockReturnValue('https://gitlab.com/group/repo.git');
    mockValidateGitLabRepoAccessForUser.mockResolvedValue(true);
    mockValidateGitLabRepoAccessForOrganization.mockResolvedValue(true);
    mockGetBotUserId.mockResolvedValue('bot-user-1');
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
    expect(mockCreateCloudAgentNextClient).toHaveBeenCalledWith('auth-token', {
      skipBalanceCheck: true,
    });
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
    expect(mockValidateGitLabRepoAccessForUser).toHaveBeenCalledWith('owner-1', 'group/repo');
  });

  it('resolves a GitLab project through the account connection before preparing the session', async () => {
    mockValidateGitLabRepoAccessForUser.mockResolvedValue(false);

    await expect(
      spawnCloudAgentSession(
        { gitlabProject: 'outside/project', prompt: 'Use the files', mode: 'code' },
        'model',
        userIntegration,
        'auth-token',
        'request-gitlab-outside'
      )
    ).resolves.toEqual(
      expect.objectContaining({
        response: expect.stringContaining('not available through this account'),
      })
    );
    expect(mockValidateGitLabRepoAccessForUser).toHaveBeenCalledWith('owner-1', 'outside/project');
    expect(mockGetGitLabTokenForUser).not.toHaveBeenCalled();
    expect(mockBuildGitLabCloneUrl).not.toHaveBeenCalled();
    expect(mockPrepareSession).not.toHaveBeenCalled();
  });

  it('resolves an organization GitLab project through the acting bot user', async () => {
    await spawnCloudAgentSession(
      { gitlabProject: 'group/repo', prompt: 'Use the files', mode: 'code' },
      'model',
      organizationIntegration,
      'auth-token',
      'request-gitlab-org'
    );

    expect(mockValidateGitLabRepoAccessForOrganization).toHaveBeenCalledWith(
      'organization-1',
      'bot-user-1',
      'group/repo'
    );
    expect(mockValidateGitLabRepoAccessForUser).not.toHaveBeenCalled();
    expect(mockPrepareSession).toHaveBeenCalledWith(
      expect.objectContaining({
        gitUrl: 'https://gitlab.com/group/repo.git',
        gitToken: 'gitlab-org-token',
        platform: 'gitlab',
        kilocodeOrganizationId: 'organization-1',
      })
    );
  });

  it('prepares no session when the project lookup fails', async () => {
    mockValidateGitLabRepoAccessForUser.mockRejectedValue(new Error('gitlab unavailable'));

    await expect(
      spawnCloudAgentSession(
        { gitlabProject: 'group/repo', prompt: 'Use the files', mode: 'code' },
        'model',
        userIntegration,
        'auth-token',
        'request-gitlab-lookup-failed'
      )
    ).resolves.toEqual(
      expect.objectContaining({ response: expect.stringContaining('Could not verify access') })
    );
    expect(mockGetGitLabTokenForUser).not.toHaveBeenCalled();
    expect(mockPrepareSession).not.toHaveBeenCalled();
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
});
