import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { BotRunInput, BotRunResult } from '@/lib/bots/core/run-bot';
import type { RunSessionInput } from '@/lib/cloud-agent-next/run-session';
import type { getGitHubTokenForUser } from '@/lib/cloud-agent/github-integration-helpers';
import type { resolveGitHubRepositorySelection } from '@/lib/slack-bot/github-repository-context';
import type { processDiscordBotMessage as ProcessDiscordBotMessage } from './discord-bot';

const githubIntegrationId = '123e4567-e89b-12d3-a456-426614174022';
const chatIntegration = {
  id: '123e4567-e89b-12d3-a456-426614174099',
  owned_by_organization_id: 'chat-workspace',
  owned_by_user_id: null,
};
const repositoryContext = {
  installations: [
    {
      platformIntegrationId: githubIntegrationId,
      accountLogin: 'github-account',
      repositoryAccess: 'selected',
      repositoriesSyncedAt: null,
      repositories: [{ id: 1, name: 'repo', full_name: 'github-account/repo', private: true }],
    },
  ],
};

const mockRunBot = jest.fn<(input: BotRunInput) => Promise<BotRunResult>>();
const mockRunSessionToCompletion =
  jest.fn<(input: RunSessionInput) => Promise<{ response: string; sessionId?: string }>>();
const mockGetGitHubTokenForUser = jest.fn<typeof getGitHubTokenForUser>();
const mockResolveGitHubRepositorySelection = jest.fn<typeof resolveGitHubRepositorySelection>();

jest.mock('@/lib/bots/core/run-bot', () => ({
  runBot: (input: BotRunInput) => mockRunBot(input),
}));
jest.mock('@/lib/cloud-agent-next/run-session', () => ({
  runSessionToCompletion: (input: RunSessionInput) => mockRunSessionToCompletion(input),
}));
jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: jest.fn(() => ({ client: true })),
}));
jest.mock('@/lib/cloud-agent/github-integration-helpers', () => ({
  getGitHubTokenForUser: (userId: string) => mockGetGitHubTokenForUser(userId),
}));
jest.mock('@/lib/integrations/discord-service', () => ({
  getInstallationByGuildId: jest.fn(async () => chatIntegration),
  getOwnerFromInstallation: jest.fn(() => ({ type: 'org', id: 'chat-workspace' })),
  getModel: jest.fn(async () => 'model'),
}));
jest.mock('@/lib/discord/auth', () => ({
  getDiscordBotAuthTokenForOwner: jest.fn(async () => ({
    authToken: 'auth-token',
    userId: 'discord-bot-user',
  })),
}));
jest.mock('@/lib/slack-bot/github-repository-context', () => ({
  getGitHubRepositoryContext: jest.fn(async () => repositoryContext),
  formatGitHubRepositoriesForPrompt: jest.fn(() => 'repository context'),
  resolveGitHubRepositorySelection: (
    ...args: Parameters<typeof resolveGitHubRepositorySelection>
  ) => mockResolveGitHubRepositorySelection(...args),
}));
jest.mock('@/lib/discord-bot/discord-channel-context', () => ({
  getDiscordConversationContext: jest.fn(),
  formatDiscordConversationContextForPrompt: jest.fn(),
}));
jest.mock('@/lib/discord-bot/discord-utils', () => ({
  buildDiscordMessageLink: jest.fn(),
}));

let processDiscordBotMessage: typeof ProcessDiscordBotMessage;

describe('Discord bot GitHub session selection', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockResolveGitHubRepositorySelection.mockResolvedValue({
      success: true,
      githubAccount: 'github-account',
      githubIntegrationId,
    });
    mockRunSessionToCompletion.mockResolvedValue({
      response: 'Cloud Agent completed',
      sessionId: 'cloud-session',
    });
    mockRunBot.mockImplementation(async (input: BotRunInput) => {
      const result = await input.toolExecutor({
        id: 'tool-1',
        type: 'function',
        function: {
          name: 'spawn_cloud_agent',
          arguments: JSON.stringify({
            githubRepo: 'github-account/repo',
            githubAccount: 'github-account',
            githubIntegrationId,
            prompt: 'Fix the bug',
            mode: 'code',
          }),
        },
      });
      return { response: result.content, toolCallsMade: ['spawn_cloud_agent'] };
    });
    ({ processDiscordBotMessage } = await import('./discord-bot'));
  });

  it('keeps chat ownership independent while passing the selected GitHub installation to Cloud Agent', async () => {
    const result = await processDiscordBotMessage('Fix the bug', '123456789012345678');

    expect(mockResolveGitHubRepositorySelection).toHaveBeenCalledWith(
      { type: 'org', id: 'chat-workspace' },
      expect.objectContaining({
        githubAccount: 'github-account',
        githubIntegrationId,
      }),
      repositoryContext
    );
    expect(mockRunSessionToCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        prepareInput: expect.objectContaining({
          githubRepo: 'github-account/repo',
          githubIntegrationId,
          kilocodeOrganizationId: 'chat-workspace',
          createdOnPlatform: 'discord',
        }),
        ticketPayload: {
          userId: 'discord-bot-user',
          organizationId: 'chat-workspace',
        },
      })
    );
    const prepareInput = mockRunSessionToCompletion.mock.calls[0]?.[0].prepareInput;
    expect(prepareInput).not.toHaveProperty('githubToken');
    expect(mockGetGitHubTokenForUser).not.toHaveBeenCalled();
    expect(result.cloudAgentSessionId).toBe('cloud-session');
    expect(result.installation).toBe(chatIntegration);
  });
});
