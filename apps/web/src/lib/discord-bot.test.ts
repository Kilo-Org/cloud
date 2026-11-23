import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  github_app_installations,
  kilocode_users,
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
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { verifyKiloTokenForPolicy } from '@kilocode/worker-utils/kilo-token-policy';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { generateBotUserId } from '@/lib/bot-users/types';
import {
  DISCORD_SESSION_DENIAL_MESSAGES,
  type DiscordSessionDenialReason,
} from './discord-bot/discord-session-authorization';
import { and, eq } from 'drizzle-orm';

const mockRunBot = jest.fn<(input: BotRunInput) => Promise<BotRunResult>>();
const mockRunSessionToCompletion = jest.fn<(input: RunSessionInput) => Promise<RunSessionResult>>();
let mockDiscordContextForPrompt = '';

// Factories delegate through lazy wrappers so the hoisted `jest.mock` calls do
// not read the mock constants before this module initializes them.
jest.mock('@/lib/bots/core/run-bot', () => ({
  runBot: (input: BotRunInput) => mockRunBot(input),
}));

jest.mock('@/lib/discord-bot/discord-channel-context', () => ({
  getDiscordConversationContext: () => Promise.resolve({}),
  formatDiscordConversationContextForPrompt: () => mockDiscordContextForPrompt,
}));

jest.mock('@/lib/cloud-agent-next/run-session', () => ({
  runSessionToCompletion: (input: RunSessionInput) => mockRunSessionToCompletion(input),
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

async function connectGitHubRepository(ownerId: string): Promise<string> {
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

  const [association] = await db
    .insert(platform_integrations)
    .values({
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
    })
    .returning();
  return association.id;
}

async function connectOrganizationGitHubRepository(
  organizationId: string,
  options: {
    accountLogin: string;
    repositories: Array<{ id: number; name: string; full_name: string; private: boolean }>;
    createdAt: string;
  }
): Promise<string> {
  const installationId = nextSnowflake();
  const [installation] = await db
    .insert(github_app_installations)
    .values({
      github_app_type: 'standard',
      installation_id: installationId,
      account_login: options.accountLogin,
      account_type: 'Organization',
      lifecycle_state: 'active',
    })
    .returning();

  const [association] = await db
    .insert(platform_integrations)
    .values({
      owned_by_organization_id: organizationId,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: installationId,
      platform_account_id: options.accountLogin,
      platform_account_login: options.accountLogin,
      integration_status: 'active',
      repository_access: 'selected',
      repositories: options.repositories,
      github_installation_id: installation.id,
      github_connection_role: 'workflow',
      created_at: options.createdAt,
    })
    .returning();
  return association.id;
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
  let connectedAssociationId: string;
  let modelRequestedRepository: string;

  beforeAll(async () => {
    // A static import of the module under test would load the real
    // collaborators before the jest.mock factories above register.
    ({ processDiscordBotMessage } = await import('./discord-bot'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDiscordContextForPrompt = '';
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
    installationOwner = await insertTestUser();
    guildId = await createDiscordInstallation(installationOwner.id);
    connectedAssociationId = await connectGitHubRepository(installationOwner.id);
  });

  function eventContext(discordUserId: string) {
    return {
      guildId,
      channelId: nextSnowflake(),
      userId: discordUserId,
      messageId: nextSnowflake(),
    };
  }

  const refusalCases: Array<{
    label: string;
    reason: DiscordSessionDenialReason;
    prepare: () => Promise<string>;
  }> = [
    {
      label: 'an author with no linked Kilo account',
      reason: 'unlinked_account',
      prepare: async () => nextSnowflake(),
    },
    {
      label: 'a linked account that is blocked',
      reason: 'account_unavailable',
      prepare: async () => {
        const blockedUser = await insertTestUser({ blocked_at: new Date().toISOString() });
        const discordUserId = nextSnowflake();
        await linkDiscordAccount(blockedUser.id, discordUserId);
        return discordUserId;
      },
    },
    {
      label: 'a linked account that does not own the installation',
      reason: 'not_installation_owner',
      prepare: async () => {
        const otherUser = await insertTestUser();
        const discordUserId = nextSnowflake();
        await linkDiscordAccount(otherUser.id, discordUserId);
        return discordUserId;
      },
    },
    {
      label: 'a linked account outside the installation organization',
      reason: 'not_organization_member',
      prepare: async () => {
        const organization = await createTestOrganization(
          'Discord refusal workspace',
          installationOwner.id,
          0
        );
        await db
          .update(platform_integrations)
          .set({ owned_by_user_id: null, owned_by_organization_id: organization.id })
          .where(
            and(
              eq(platform_integrations.owned_by_user_id, installationOwner.id),
              eq(platform_integrations.platform, 'discord')
            )
          );
        const otherUser = await insertTestUser();
        const discordUserId = nextSnowflake();
        await linkDiscordAccount(otherUser.id, discordUserId);
        return discordUserId;
      },
    },
  ];

  for (const refusalCase of refusalCases) {
    it(`refuses ${refusalCase.label} without calling the model`, async () => {
      const discordUserId = await refusalCase.prepare();

      const result = await processDiscordBotMessage(
        `Change something in ${CONNECTED_REPOSITORY}`,
        guildId,
        eventContext(discordUserId)
      );

      expect(mockRunBot).not.toHaveBeenCalled();
      expect(mockRunSessionToCompletion).not.toHaveBeenCalled();
      expect(result.response).toBe(DISCORD_SESSION_DENIAL_MESSAGES[refusalCase.reason]);
      expect(result.modelUsed).toBe('');
      expect(result.toolCallsMade).toEqual([]);
      expect(result.cloudAgentSessionId).toBeUndefined();
    });
  }

  it.each([
    { label: 'a suspended status', state: { integration_status: 'suspended' as const } },
    {
      label: 'a suspension marker on an active status',
      state: { integration_status: 'active' as const, suspended_at: new Date().toISOString() },
    },
  ])('refuses a message for an installation with $label', async ({ state }) => {
    await db
      .update(platform_integrations)
      .set(state)
      .where(
        and(
          eq(platform_integrations.owned_by_user_id, installationOwner.id),
          eq(platform_integrations.platform, 'discord')
        )
      );
    const discordUserId = nextSnowflake();
    await linkDiscordAccount(installationOwner.id, discordUserId);

    const result = await processDiscordBotMessage(
      `Change something in ${CONNECTED_REPOSITORY}`,
      guildId,
      eventContext(discordUserId)
    );

    expect(mockRunBot).not.toHaveBeenCalled();
    expect(mockRunSessionToCompletion).not.toHaveBeenCalled();
    expect(result.error).toBe('installation_not_active');
    expect(result.response).toBe('');
    expect(result.modelUsed).toBe('');
    expect(result.toolCallsMade).toEqual([]);
    expect(result.cloudAgentSessionId).toBeUndefined();
    expect(result.installation?.platform_installation_id).toBe(guildId);
  });

  it.each([
    { label: 'a blocked account', state: { blocked_at: new Date().toISOString() } },
    { label: 'a disabled personal account', state: { personal_account_disabled: true } },
  ])('keeps the account state out of the public reply for $label', async ({ state }) => {
    const unavailableUser = await insertTestUser(state);
    const discordUserId = nextSnowflake();
    await linkDiscordAccount(unavailableUser.id, discordUserId);

    const result = await processDiscordBotMessage(
      `Change something in ${CONNECTED_REPOSITORY}`,
      guildId,
      eventContext(discordUserId)
    );

    expect(mockRunBot).not.toHaveBeenCalled();
    expect(result.response).toBe(DISCORD_SESSION_DENIAL_MESSAGES.account_unavailable);
    expect(result.response).not.toMatch(/block|disabl|suspend|bann/i);
  });

  it('refuses a message that carries no Discord author context', async () => {
    const result = await processDiscordBotMessage(
      `Change something in ${CONNECTED_REPOSITORY}`,
      guildId
    );

    expect(mockRunBot).not.toHaveBeenCalled();
    expect(result.response).toBe(DISCORD_SESSION_DENIAL_MESSAGES.unknown_requester);
    expect(result.modelUsed).toBe('');
  });

  it('places Discord context in its named prompt section', async () => {
    mockDiscordContextForPrompt = 'Channel topic: weekly update';
    const discordUserId = nextSnowflake();
    await linkDiscordAccount(installationOwner.id, discordUserId);

    await processDiscordBotMessage(
      `Change something in ${CONNECTED_REPOSITORY}`,
      guildId,
      eventContext(discordUserId)
    );

    const [runInput] = mockRunBot.mock.calls[0];
    expect(runInput.systemPrompt).toContain('<platform_conversation_context platform="discord">');
    expect(runInput.systemPrompt).toContain('Channel topic: weekly update');
    expect(runInput.systemPrompt).toContain('</platform_conversation_context>');
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
      githubIntegrationId: connectedAssociationId,
      githubAccessPurpose: 'workflow',
      createdOnPlatform: 'discord',
    });
    expect(sessionInput.prepareInput).not.toHaveProperty('githubToken');
    expect(result.cloudAgentSessionId).toBe('cloud-session-1');
  });

  it(
    'credentials an organization session from the association that grants the repository',
    async () => {
      const organization = await createTestOrganization(
        'Discord association workspace',
        installationOwner.id,
        0
      );
      await db
        .update(platform_integrations)
        .set({ owned_by_user_id: null, owned_by_organization_id: organization.id })
        .where(
          and(
            eq(platform_integrations.owned_by_user_id, installationOwner.id),
            eq(platform_integrations.platform, 'discord')
          )
        );
      const primaryAssociationId = await connectOrganizationGitHubRepository(organization.id, {
        accountLogin: 'kilo-test-primary',
        repositories: [
          {
            id: 515151,
            name: 'other-repo',
            full_name: 'kilo-test-primary/other-repo',
            private: true,
          },
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      const grantingAssociationId = await connectOrganizationGitHubRepository(organization.id, {
        accountLogin: 'kilo-test',
        repositories: [
          {
            id: 626262,
            name: 'connected-repo',
            full_name: CONNECTED_REPOSITORY,
            private: true,
          },
        ],
        createdAt: '2026-02-01T00:00:00.000Z',
      });
      const discordUserId = nextSnowflake();
      await linkDiscordAccount(installationOwner.id, discordUserId);

      const result = await processDiscordBotMessage(
        `Inspect ${CONNECTED_REPOSITORY}`,
        guildId,
        eventContext(discordUserId)
      );

      expect(result.response).toBe('The session finished.');
      expect(mockRunSessionToCompletion).toHaveBeenCalledTimes(1);
      const [sessionInput] = mockRunSessionToCompletion.mock.calls[0];
      expect(sessionInput.prepareInput.githubIntegrationId).toBe(grantingAssociationId);
      expect(sessionInput.prepareInput.githubIntegrationId).not.toBe(primaryAssociationId);
      expect(sessionInput.prepareInput.githubAccessPurpose).toBe('workflow');
      expect(sessionInput.prepareInput.kilocodeOrganizationId).toBe(organization.id);
      expect(sessionInput.prepareInput).not.toHaveProperty('githubToken');
    }
  );

  it.each(['user', 'org'] as const)(
    'authenticates %s session operations with bounded workflow authority',
    async ownerType => {
      jest.replaceProperty(process, 'env', {
        ...process.env,
        SHARED_RESOURCE_TOKENS_ENABLED: 'true',
        CLOUD_AGENT_RESOURCE_TOKENS_ENABLED: 'true',
      });
      const organization =
        ownerType === 'org'
          ? await createTestOrganization('Discord workspace', installationOwner.id, 0)
          : undefined;
      if (organization) {
        await db
          .update(platform_integrations)
          .set({ owned_by_user_id: null, owned_by_organization_id: organization.id })
          .where(eq(platform_integrations.owned_by_user_id, installationOwner.id));
      }
      const actingUserId = organization
        ? generateBotUserId(organization.id, 'discord-bot')
        : installationOwner.id;
      const discordUserId = nextSnowflake();
      await linkDiscordAccount(installationOwner.id, discordUserId);
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        const bearer = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '');
        if (!bearer) throw new Error('Session credential required');
        const verified = await verifyKiloTokenForPolicy(bearer, NEXTAUTH_SECRET, {
          audience: 'cloud-agent-next',
          mode: 'required',
        });
        const [actingUser] = await db
          .select()
          .from(kilocode_users)
          .where(eq(kilocode_users.id, actingUserId));
        expect(verified.userId).toBe(actingUserId);
        expect(verified.claims.organizationId).toBe(organization?.id);
        expect(verified.claims.botId).toBe(organization ? 'discord-bot' : undefined);
        expect(verified.claims.runtimeAdmission).toMatchObject({
          source: 'automation',
          authorizationUserId: actingUserId,
          authorizationPepper: actingUser.api_token_pepper,
        });
        expect(verified.claims.credentialExchange).toBe(false);
        expect(verified.claims.exp - verified.claims.iat).toBeLessThanOrEqual(3600);
        return Response.json({
          result: {
            data: { cloudAgentSessionId: 'cloud-session-1', kiloSessionId: 'kilo-session-1' },
          },
        });
      });
      mockRunSessionToCompletion.mockImplementationOnce(async input => {
        const prepared = await input.client.prepareSession(input.prepareInput);
        return {
          response: 'The session finished.',
          sessionId: prepared.cloudAgentSessionId,
          hasError: false,
          statusMessages: [],
        };
      });

      const result = await processDiscordBotMessage(
        `Inspect ${CONNECTED_REPOSITORY}`,
        guildId,
        eventContext(discordUserId)
      );

      expect(result.response).toBe('The session finished.');
      expect(result.cloudAgentSessionId).toBe('cloud-session-1');
    }
  );

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
    expect(result.cloudAgentSessionId).toBeUndefined();
  });
});
