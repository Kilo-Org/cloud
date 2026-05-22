const mockPrepareSession = jest.fn();
const mockInitiateFromPreparedSession = jest.fn();
const mockGetGitHubTokenForUser = jest.fn();
const mockResolveBotSessionProfile = jest.fn();

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: jest.fn(() => ({
    prepareSession: mockPrepareSession,
    initiateFromPreparedSession: mockInitiateFromPreparedSession,
  })),
}));

jest.mock('@/lib/cloud-agent/github-integration-helpers', () => ({
  getGitHubTokenForOrganization: jest.fn(),
  getGitHubTokenForUser: (...args: unknown[]) => mockGetGitHubTokenForUser(...args),
}));

jest.mock('@/lib/cloud-agent/gitlab-integration-helpers', () => ({
  getGitLabTokenForOrganization: jest.fn(),
  getGitLabTokenForUser: jest.fn(),
  getGitLabInstanceUrlForOrganization: jest.fn(),
  getGitLabInstanceUrlForUser: jest.fn(),
  buildGitLabCloneUrl: jest.fn(),
}));

jest.mock('@/lib/bot/tools/resolve-bot-session-profile', () => ({
  resolveBotSessionProfile: (...args: unknown[]) => mockResolveBotSessionProfile(...args),
}));

jest.mock('@kilocode/cloud-agent-profile', () => ({
  profileMcpServersToClientRecord: jest.fn(() => ({})),
}));

jest.mock('@/lib/config.server', () => ({
  CALLBACK_TOKEN_SECRET: 'callback-secret',
}));

jest.mock('@/lib/constants', () => ({
  APP_URL: 'https://app.example.com',
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

import type { PlatformIntegration } from '@kilocode/db';
import { PLATFORM } from '@/lib/integrations/core/constants';
import spawnCloudAgentSession from './spawn-cloud-agent-session';

function createIntegration(): PlatformIntegration {
  return {
    id: 'pi_1',
    owned_by_user_id: 'user_1',
    owned_by_organization_id: null,
    created_by_user_id: 'user_1',
    platform: PLATFORM.GITHUB,
    integration_type: 'app',
    platform_installation_id: '98765',
    platform_account_id: '123',
    platform_account_login: 'acme',
    permissions: null,
    scopes: null,
    repository_access: 'all',
    repositories: null,
    repositories_synced_at: null,
    metadata: null,
    kilo_requester_user_id: null,
    platform_requester_account_id: null,
    integration_status: 'active',
    suspended_at: null,
    suspended_by: null,
    github_app_type: 'standard',
    installed_at: '2026-05-05T07:00:00Z',
    created_at: '2026-05-05T07:00:00Z',
    updated_at: '2026-05-05T07:00:00Z',
  };
}

describe('spawnCloudAgentSession prompt augmentation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetGitHubTokenForUser.mockResolvedValue('gh-token');
    mockPrepareSession.mockResolvedValue({
      cloudAgentSessionId: 'cloud-session-1',
      kiloSessionId: 'kilo-session-1',
    });
    mockInitiateFromPreparedSession.mockResolvedValue(undefined);
    mockResolveBotSessionProfile.mockResolvedValue({
      envVars: [],
      encryptedSecrets: [],
      setupCommands: [],
      mcpServers: [],
      skills: [],
      agents: [],
    });
  });

  it('appends enforced new-PR instructions before preparing the session', async () => {
    await spawnCloudAgentSession(
      {
        githubRepo: 'acme/widgets',
        prompt: 'Update REVIEW.md',
        mode: 'code',
      },
      'openai/gpt-5.5',
      createIntegration(),
      'auth-token',
      'user_1',
      'bot_request_1',
      undefined,
      {
        chatPlatform: 'github',
        prCreationStrategy: 'force-new',
        prSignature: '\n\nRequested by RSO',
      }
    );

    const prepareInput = mockPrepareSession.mock.calls[0][0];
    expect(prepareInput.prompt).toContain('Update REVIEW.md');
    expect(prepareInput.prompt).toContain('separate new PR');
    expect(prepareInput.prompt).toContain('original PR base branch');
    expect(prepareInput.prompt).toContain('Requested by RSO');
  });

  it('leaves prompts unchanged when no explicit new PR/MR strategy is set', async () => {
    await spawnCloudAgentSession(
      {
        githubRepo: 'acme/widgets',
        prompt: 'Update REVIEW.md',
        mode: 'code',
      },
      'openai/gpt-5.5',
      createIntegration(),
      'auth-token',
      'user_1',
      'bot_request_1'
    );

    const prepareInput = mockPrepareSession.mock.calls[0][0];
    expect(prepareInput.prompt).toBe('Update REVIEW.md');
  });
});
