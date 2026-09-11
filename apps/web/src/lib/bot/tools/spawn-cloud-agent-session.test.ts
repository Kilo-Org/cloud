import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PlatformIntegration } from '@kilocode/db';
import type { CloudAgentAttachments } from '@/lib/cloud-agent/constants';
import type { createCloudAgentNextClient as CreateCloudAgentNextClient } from '@/lib/cloud-agent-next/cloud-agent-client';
import type {
  buildGitLabCloneUrl as BuildGitLabCloneUrl,
  getGitLabInstanceUrlForUser as GetGitLabInstanceUrlForUser,
  getGitLabTokenForUser as GetGitLabTokenForUser,
} from '@/lib/cloud-agent/gitlab-integration-helpers';
import type { resolveModelForGitHubRepository as ResolveModelForGitHubRepository } from '@/lib/integrations/github-repository-settings';
import type { resolveGitHubRepositoryForOwner as ResolveGitHubRepositoryForOwner } from '@/lib/slack-bot/github-repository-context';
import type SpawnCloudAgentSession from './spawn-cloud-agent-session';

jest.mock('@/lib/config.server', () => ({
  CALLBACK_TOKEN_SECRET: 'callback-secret',
}));

jest.mock('@/lib/constants', () => ({
  APP_URL: 'https://app.example.test',
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: jest.fn(),
}));

jest.mock('@/lib/slack-bot/github-repository-context', () => ({
  resolveGitHubRepositoryForOwner: jest.fn(),
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getGitHubIntegrationById: jest.fn(async (_owner: unknown, id: string) => ({
    ...userIntegration,
    id,
    repositories: [{ id: 1, name: 'repo', full_name: 'owner/repo', private: true }],
  })),
}));

jest.mock('@/lib/cloud-agent/gitlab-integration-helpers', () => ({
  getGitLabTokenForOrganization: jest.fn(),
  getGitLabTokenForUser: jest.fn(),
  getGitLabInstanceUrlForOrganization: jest.fn(),
  getGitLabInstanceUrlForUser: jest.fn(),
  buildGitLabCloneUrl: jest.fn(),
}));

jest.mock('@/lib/integrations/github-repository-settings', () => ({
  resolveModelForGitHubRepository: jest.fn(),
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
let mockGetGitLabInstanceUrlForUser: jest.MockedFunction<typeof GetGitLabInstanceUrlForUser>;
let mockBuildGitLabCloneUrl: jest.MockedFunction<typeof BuildGitLabCloneUrl>;
let mockResolveModelForGitHubRepository: jest.MockedFunction<
  typeof ResolveModelForGitHubRepository
>;

describe('spawnCloudAgentSession delegation', () => {
  beforeAll(async () => {
    const client = await import('@/lib/cloud-agent-next/cloud-agent-client');
    const githubRepositoryContext = await import('@/lib/slack-bot/github-repository-context');
    const gitlab = await import('@/lib/cloud-agent/gitlab-integration-helpers');
    const repositorySettings = await import('@/lib/integrations/github-repository-settings');
    const spawn = await import('./spawn-cloud-agent-session');

    mockCreateCloudAgentNextClient = jest.mocked(client.createCloudAgentNextClient);
    mockResolveGitHubRepositoryForOwner = jest.mocked(
      githubRepositoryContext.resolveGitHubRepositoryForOwner
    );
    mockGetGitLabTokenForUser = jest.mocked(gitlab.getGitLabTokenForUser);
    mockGetGitLabInstanceUrlForUser = jest.mocked(gitlab.getGitLabInstanceUrlForUser);
    mockBuildGitLabCloneUrl = jest.mocked(gitlab.buildGitLabCloneUrl);
    mockResolveModelForGitHubRepository = jest.mocked(
      repositorySettings.resolveModelForGitHubRepository
    );
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
    mockGetGitLabTokenForUser.mockResolvedValue('gitlab-token');
    mockGetGitLabInstanceUrlForUser.mockResolvedValue('https://gitlab.com');
    mockBuildGitLabCloneUrl.mockReturnValue('https://gitlab.com/group/repo.git');
    mockResolveModelForGitHubRepository.mockResolvedValue('model');
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
    for (const field of profileDerivedInlineFields) {
      expect(prepareInput).not.toHaveProperty(field);
    }
    expect(mockCreateCloudAgentNextClient).toHaveBeenCalledWith('auth-token', {
      skipBalanceCheck: true,
    });
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
    }
  );

  it('uses the per-repository model override resolved for the GitHub repo, not the raw model argument', async () => {
    mockResolveModelForGitHubRepository.mockResolvedValue('repo-override-model');

    await spawnCloudAgentSession(
      { githubRepo: 'owner/repo', prompt: 'Use the files', mode: 'code' },
      'installation-default-model',
      userIntegration,
      'auth-token',
      'request-github-override',
      undefined,
      { chatPlatform: 'slack' }
    );

    expect(mockResolveModelForGitHubRepository).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'github-association-1' }),
      'owner/repo'
    );
    expect(mockPrepareSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'repo-override-model' })
    );
  });

  it('falls back to the incoming model when the per-repository model lookup rejects', async () => {
    mockResolveModelForGitHubRepository.mockRejectedValue(new Error('customization query failed'));

    const result = await spawnCloudAgentSession(
      { githubRepo: 'owner/repo', prompt: 'Use the files', mode: 'code' },
      'installation-default-model',
      userIntegration,
      'auth-token',
      'request-github-lookup-failure',
      undefined,
      { chatPlatform: 'slack' }
    );

    expect(mockPrepareSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'installation-default-model' })
    );
    expect(result.cloudAgentSessionId).toBe('cloud-session-1');
  });

  it('does not resolve a per-repo model override for GitLab sessions', async () => {
    await spawnCloudAgentSession(
      { gitlabProject: 'group/repo', prompt: 'Use the files', mode: 'code' },
      'installation-default-model',
      userIntegration,
      'auth-token',
      'request-gitlab-no-override',
      undefined,
      { chatPlatform: 'slack' }
    );

    expect(mockResolveModelForGitHubRepository).not.toHaveBeenCalled();
    expect(mockPrepareSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'installation-default-model' })
    );
  });
});
