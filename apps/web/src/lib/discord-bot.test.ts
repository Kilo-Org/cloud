import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  github_app_installations,
  platform_integrations,
  user_auth_provider,
  type User,
} from '@kilocode/db/schema';
import type OpenAI from 'openai';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import type { BotRunInput, BotRunResult } from '@/lib/bots/core/run-bot';
import type { RunSessionInput, RunSessionResult } from '@/lib/cloud-agent-next/run-session';
import type { DiscordBotMessageResult } from './discord-bot';
import type { DiscordEventContext } from './discord-bot/discord-channel-context';

const mockRunBot = jest.fn<(input: BotRunInput) => Promise<BotRunResult>>();
const mockRunSessionToCompletion = jest.fn<(input: RunSessionInput) => Promise<RunSessionResult>>();
const mockGetGitHubTokenForUser = jest.fn<() => Promise<string | undefined>>();
const mockGetGitHubTokenForOrganization = jest.fn<() => Promise<string | undefined>>();

// Factories delegate through lazy wrappers so the hoisted `jest.mock` calls do
// not read the mock constants before this module initializes them.
jest.mock('@/lib/bots/core/run-bot', () => ({
  runBot: (input: BotRunInput) => mockRunBot(input),
}));

jest.mock('@/lib/discord/auth', () => ({
  getDiscordBotAuthTokenForOwner: () =>
    Promise.resolve({ authToken: 'discord-bot-token', userId: 'discord-bot-user' }),
}));

jest.mock('@/lib/discord-bot/discord-channel-context', () => ({
  getDiscordConversationContext: () => Promise.resolve({}),
  formatDiscordConversationContextForPrompt: () => '',
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: () => ({}),
}));

jest.mock('@/lib/cloud-agent-next/run-session', () => ({
  runSessionToCompletion: (input: RunSessionInput) => mockRunSessionToCompletion(input),
}));

jest.mock('@/lib/cloud-agent/github-integration-helpers', () => ({
  getGitHubTokenForUser: () => mockGetGitHubTokenForUser(),
  getGitHubTokenForOrganization: () => mockGetGitHubTokenForOrganization(),
}));

const CONNECTED_REPOSITORY = 'kilo-test/connected-repo';
const UNCONNECTED_REPOSITORY = 'kilo-test/unlisted-repo';

let discordIdSequence = 0;

function nextSnowflake(): string {
  discordIdSequence += 1;
  return `${Date.now()}${String(discordIdSequence).padStart(6, '0')}`;
}

async function createDiscordInstallation(ownerId: string): Promise<string> {
  const guildId = nextSnowflake();
  await db.insert(platform_integrations).values({
    owned_by_user_id: ownerId,
    platform: 'discord',
    integration_type: 'oauth',
    platform_installation_id: guildId,
    platform_account_id: guildId,
    platform_account_login: 'Test Guild',
    integration_status: 'active',
    metadata: { model_slug: 'fake-deterministic' },
  });
  return guildId;
}

async function connectGitHubRepository(ownerId: string): Promise<void> {
  const installationId = `1${String(Date.now()).slice(-6)}${String(discordIdSequence).padStart(5, '0')}`;
  const [installation] = await db
    .insert(github_app_installations)
    .values({
      github_app_type: 'standard',
      installation_id: installationId,
      account_login: 'kilo-test',
      account_type: 'Organization',
      lifecycle_state: 'active',
    })
    .returning();

  await db.insert(platform_integrations).values({
    owned_by_user_id: ownerId,
    platform: 'github',
    integration_type: 'app',
    platform_installation_id: installationId,
    platform_account_id: 'kilo-test',
    platform_account_login: 'kilo-test',
    integration_status: 'active',
    repository_access: 'selected',
    repositories: [
      {
        id: 424242,
        name: 'connected-repo',
        full_name: CONNECTED_REPOSITORY,
        private: true,
      },
    ],
    github_installation_id: installation.id,
    github_connection_role: 'workflow',
  });
}

async function linkDiscordAccount(kiloUserId: string, discordUserId: string): Promise<void> {
  await db.insert(user_auth_provider).values({
    kilo_user_id: kiloUserId,
    provider: 'discord',
    provider_account_id: discordUserId,
    email: `${discordUserId}@example.com`,
    avatar_url: 'https://example.com/avatar.png',
  });
}

function spawnToolCall(repository: string): OpenAI.Chat.Completions.ChatCompletionMessageToolCall {
  return {
    id: 'call_spawn_1',
    type: 'function',
    function: {
      name: 'spawn_cloud_agent',
      arguments: JSON.stringify({ githubRepo: repository, prompt: 'Inspect the repository.' }),
    },
  };
}

describe('processDiscordBotMessage session start authorization', () => {
  let processDiscordBotMessage: (
    userMessage: string,
    guildId: string,
    discordEventContext?: DiscordEventContext
  ) => Promise<DiscordBotMessageResult>;
  let installationOwner: User;
  let guildId: string;
  let modelRequestedRepository: string;

  beforeAll(async () => {
    // A static import of the module under test would load the real
    // collaborators before the jest.mock factories above register.
    ({ processDiscordBotMessage } = await import('./discord-bot'));
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    modelRequestedRepository = CONNECTED_REPOSITORY;
    mockRunBot.mockImplementation(async input => {
      if ((input.tools ?? []).length === 0) {
        return { response: 'Here is an answer.', toolCallsMade: [] };
      }
      const toolResult = await input.toolExecutor(spawnToolCall(modelRequestedRepository));
      return { response: toolResult.content, toolCallsMade: ['spawn_cloud_agent'] };
    });
    mockRunSessionToCompletion.mockResolvedValue({
      response: 'The session finished.',
      sessionId: 'cloud-session-1',
      hasError: false,
      statusMessages: [],
    });
    mockGetGitHubTokenForUser.mockResolvedValue('github-installation-token');
    mockGetGitHubTokenForOrganization.mockResolvedValue('github-installation-token');

    installationOwner = await insertTestUser();
    guildId = await createDiscordInstallation(installationOwner.id);
    await connectGitHubRepository(installationOwner.id);
  });

  function eventContext(discordUserId: string) {
    return {
      guildId,
      channelId: nextSnowflake(),
      userId: discordUserId,
      messageId: nextSnowflake(),
    };
  }

  it('answers without session tools when the author has no linked Kilo account', async () => {
    const result = await processDiscordBotMessage(
      `Change something in ${CONNECTED_REPOSITORY}`,
      guildId,
      eventContext(nextSnowflake())
    );

    expect(mockRunBot).toHaveBeenCalledTimes(1);
    const [runInput] = mockRunBot.mock.calls[0];
    expect(runInput.tools).toEqual([]);
    expect(runInput.systemPrompt).toContain('/connected-accounts');
    expect(runInput.systemPrompt).not.toContain(CONNECTED_REPOSITORY);
    expect(result.response).toBe('Here is an answer.');

    const toolResult = await runInput.toolExecutor(spawnToolCall(CONNECTED_REPOSITORY));
    expect(toolResult.content).toContain('/connected-accounts');
    expect(mockRunSessionToCompletion).not.toHaveBeenCalled();
    expect(result.cloudAgentSessionId).toBeUndefined();
  });

  it('starts a session for the linked installation owner on a connected repository', async () => {
    const discordUserId = nextSnowflake();
    await linkDiscordAccount(installationOwner.id, discordUserId);

    const result = await processDiscordBotMessage(
      `Change something in ${CONNECTED_REPOSITORY}`,
      guildId,
      eventContext(discordUserId)
    );

    const [runInput] = mockRunBot.mock.calls[0];
    expect(JSON.stringify(runInput.tools)).toContain('spawn_cloud_agent');
    expect(runInput.systemPrompt).toContain(CONNECTED_REPOSITORY);

    expect(result.response).toBe('The session finished.');
    expect(mockRunSessionToCompletion).toHaveBeenCalledTimes(1);
    const [sessionInput] = mockRunSessionToCompletion.mock.calls[0];
    expect(sessionInput.prepareInput).toMatchObject({
      githubRepo: CONNECTED_REPOSITORY,
      githubToken: 'github-installation-token',
      createdOnPlatform: 'discord',
    });
    expect(result.cloudAgentSessionId).toBe('cloud-session-1');
  });

  it('refuses a repository outside the installation without starting a session', async () => {
    const discordUserId = nextSnowflake();
    await linkDiscordAccount(installationOwner.id, discordUserId);
    modelRequestedRepository = UNCONNECTED_REPOSITORY;

    const result = await processDiscordBotMessage(
      `Change something in ${UNCONNECTED_REPOSITORY}`,
      guildId,
      eventContext(discordUserId)
    );

    expect(result.response).toContain('not available through this Discord installation');
    expect(mockRunSessionToCompletion).not.toHaveBeenCalled();
    expect(mockGetGitHubTokenForUser).not.toHaveBeenCalled();
    expect(result.cloudAgentSessionId).toBeUndefined();
  });
});
