import type { PlatformIntegration, User } from '@kilocode/db';
import type { Message, Thread } from 'chat';
import { z } from 'zod';
import { runBotAgent } from './agent-runner';
import type { SpawnCloudAgentInput as SpawnInput } from './tools/spawn-cloud-agent-session';
import { createCloudAgentNextClient } from '@/lib/cloud-agent-next/cloud-agent-client';
import {
  buildGitLabCloneUrl,
  getGitLabInstanceUrlForOrganization,
  getGitLabTokenForOrganization,
  getGitLabTokenForUser,
} from '@/lib/cloud-agent/gitlab-integration-helpers';
import {
  formatGitHubRepositoriesForPrompt,
  getGitHubRepositoryContext,
  resolveGitHubRepositoryForOwner,
} from '@/lib/slack-bot/github-repository-context';
import {
  formatGitLabRepositoriesForPrompt,
  getGitLabRepositoryContext,
} from '@/lib/slack-bot/gitlab-repository-context';
import { recordBotRequestCloudAgentSession } from '@/lib/bot/request-logging';

type AgentOptions = {
  instructions: string;
  tools: {
    spawnCloudAgentSession: {
      inputSchema: z.ZodType<SpawnInput>;
      execute: (args: SpawnInput) => Promise<{ response: string }>;
    };
  };
};

const mockAgentOptions = jest.fn<void, [AgentOptions]>();
const mockGenerate = jest.fn<Promise<{ text: string }>, []>();
const mockGetConversationContext = jest.fn<Promise<string>, []>();
const mockGetGitHubIntegrationById = jest.fn<Promise<PlatformIntegration | null>, unknown[]>();
const mockPrepareSession = jest.fn<
  Promise<{ cloudAgentSessionId: string; kiloSessionId: string }>,
  [unknown]
>();
const mockInitiateFromPreparedSession = jest.fn<Promise<void>, []>();

jest.mock('ai', () => ({
  ToolLoopAgent: jest.fn().mockImplementation((options: AgentOptions) => {
    mockAgentOptions(options);
    return { generate: mockGenerate };
  }),
  tool: (definition: unknown) => definition,
  isStepCount: jest.fn(),
  generateText: jest.fn(async () => ({ text: 'Review the current pull request' })),
}));
jest.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: () => ({ chatModel: jest.fn() }),
}));
jest.mock('@/lib/bot/platforms', () => ({
  botPlatforms: {
    requireByAdapter: () => ({
      documentationUrl: 'https://kilo.ai/docs',
      getConversationContext: () => mockGetConversationContext(),
      getRequesterInfo: async () => ({ displayName: 'Requester', platform: 'github' }),
    }),
  },
}));
jest.mock('@/lib/bot/request-logging', () => ({
  linkBotRequestToSession: jest.fn(),
  recordBotRequestCloudAgentSession: jest.fn(),
  updateBotRequest: jest.fn(),
}));
jest.mock('@/lib/cloud-agent-next/session-url', () => ({
  buildSessionUrl: () => 'https://app.example.test/cloud/chat?sessionId=kilo-session-1',
}));
jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: jest.fn(),
}));
jest.mock('@/lib/slack-bot/github-repository-context', () => ({
  getGitHubRepositoryContext: jest.fn(),
  formatGitHubRepositoriesForPrompt: jest.fn(context => JSON.stringify(context)),
  resolveGitHubRepositoryForOwner: jest.fn(),
}));
jest.mock('@/lib/slack-bot/gitlab-repository-context', () => ({
  getGitLabRepositoryContext: jest.fn(),
  formatGitLabRepositoriesForPrompt: jest.fn(context => JSON.stringify(context)),
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
jest.mock('@/lib/bot-users/bot-user-service', () => ({
  getBotUserId: jest.fn(async () => 'bot-user-1'),
}));
jest.mock('@/lib/bot/github-link-token', () => ({ createGitHubLinkToken: jest.fn() }));
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: jest.fn(),
}));
jest.mock('@/lib/integrations/github/runtime-authorization', () => ({
  assertGitHubInstallationRuntimeAuthorized: jest.fn(),
}));
jest.mock('@/lib/web-config.server', () => ({ CALLBACK_TOKEN_SECRET: 'callback-secret' }));
jest.mock('@kilocode/web-shared/lib/constants', () => ({
  APP_URL: 'https://app.example.test',
}));
jest.mock('@kilocode/web-shared/lib/tokens', () => ({
  generateApiToken: () => 'auth-token',
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/is-free-model', () => ({
  isFreeModel: async () => false,
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock(
  'chat',
  () => ({
    Actions: jest.fn(),
    Card: jest.fn(),
    CardText: jest.fn(),
    LinkButton: jest.fn(),
    Section: jest.fn(),
  }),
  { virtual: true }
);

const threadRepository = 'Kilo-Org/cloud';
const otherRepository = 'Kilo-Org/other';
const gitlabProject = 'group/project';
const githubRepositories = [threadRepository, otherRepository].map((fullName, index) => ({
  id: index + 1,
  name: fullName.split('/')[1],
  full_name: fullName,
  private: true,
  githubIntegrationId: 'github-association-1',
  githubAppType: 'standard' as const,
}));
let toolInput: SpawnInput;

function agentOptions(): AgentOptions {
  const options = mockAgentOptions.mock.calls[0]?.[0];
  if (!options) throw new Error('The bot agent was not constructed');
  return options;
}

function runParams(platform: 'github' | 'slack' | 'linear' = 'github') {
  const message = {
    id: 'message-1',
    text: 'Review the current pull request',
    author: {
      fullName: 'Requester',
      userName: 'requester',
      userId: 'requester-1',
      isBot: false,
      isMe: false,
    },
    raw: platform === 'github' ? { repository: { id: 1, full_name: threadRepository } } : {},
  } as Message;

  return {
    thread: {
      id: platform === 'github' ? `github:${threadRepository}:42` : `${platform}:channel:thread`,
      channelId: platform === 'github' ? `github:${threadRepository}` : `${platform}:channel`,
      adapter: { name: platform },
      startTyping: jest.fn(async () => {}),
      postEphemeral: jest.fn(async () => null),
    } as unknown as Thread,
    message,
    rawMessage: message,
    platformIntegration: {
      id: 'bot-integration-1',
      platform,
      owned_by_organization_id: 'org-1',
      owned_by_user_id: null,
      metadata: null,
    } as PlatformIntegration,
    user: { id: 'user-1' } as User,
    botRequestId: 'request-1',
    prompt: message.text,
  } satisfies Parameters<typeof runBotAgent>[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  toolInput = { prompt: 'Review PR #42 without changing it', mode: 'ask' };
  mockGenerate.mockImplementation(async () => {
    const result = await agentOptions().tools.spawnCloudAgentSession.execute(toolInput);
    return { text: result.response };
  });
  mockGetConversationContext.mockResolvedValue('Current thread conversation');
  jest.mocked(createCloudAgentNextClient).mockReturnValue({
    prepareSession: mockPrepareSession,
    initiateFromPreparedSession: mockInitiateFromPreparedSession,
  } as never);
  mockPrepareSession.mockResolvedValue({
    cloudAgentSessionId: 'cloud-session-1',
    kiloSessionId: 'kilo-session-1',
  });
  mockInitiateFromPreparedSession.mockResolvedValue(undefined);
  jest.mocked(getGitHubRepositoryContext).mockResolvedValue({ repositories: githubRepositories });
  jest
    .mocked(resolveGitHubRepositoryForOwner)
    .mockImplementation(
      async (_owner, fullName) =>
        githubRepositories.find(repository => repository.full_name === fullName) ?? null
    );
  mockGetGitHubIntegrationById.mockResolvedValue({
    ...runParams().platformIntegration,
    id: 'github-association-1',
    repositories: githubRepositories,
  });
  jest.mocked(getGitLabRepositoryContext).mockResolvedValue({
    accountLogin: 'group',
    repositoryAccess: 'all',
    repositoriesSyncedAt: null,
    repositories: [{ id: 3, name: 'project', full_name: gitlabProject, private: true }],
    instanceUrl: 'https://gitlab.com',
  });
  jest.mocked(getGitLabTokenForOrganization).mockResolvedValue('gitlab-token');
  jest.mocked(getGitLabTokenForUser).mockResolvedValue('gitlab-token');
  jest.mocked(getGitLabInstanceUrlForOrganization).mockResolvedValue('https://gitlab.com');
  jest.mocked(buildGitLabCloneUrl).mockReturnValue(`https://gitlab.com/${gitlabProject}.git`);
});

describe.each(['initial', 'continuation'] as const)('GitHub %s execution', execution => {
  function githubParams() {
    const params: Parameters<typeof runBotAgent>[0] = runParams();
    if (execution === 'continuation') {
      delete params.rawMessage;
      params.completedStepCount = 1;
      params.initialSteps = [];
      params.prompt = `Cloud Agent result mentioned ${otherRepository} and ${gitlabProject}`;
      params.message = {
        author: params.message.author,
        id: 'request-1:callback',
        text: params.prompt,
      };
    }
    return params;
  }

  it.each([
    `github:${threadRepository}:issue:42`,
    `github:${threadRepository}:42`,
    `github:${threadRepository}:42:rc:301`,
  ])('binds %s despite conflicting model repository arguments', async threadId => {
    const params = githubParams();
    params.thread = { ...params.thread, id: threadId } as Thread;
    toolInput = { ...toolInput, githubRepo: otherRepository, gitlabProject };

    const result = await runBotAgent(params);

    expect(result.startedCloudAgentSession).toBe(true);
    expect(mockPrepareSession).toHaveBeenCalledTimes(1);
    expect(mockPrepareSession).toHaveBeenCalledWith(
      expect.objectContaining({
        githubRepo: threadRepository,
        githubIntegrationId: 'github-association-1',
        githubAccessPurpose: 'workflow',
        createdOnPlatform: 'github',
        mode: toolInput.mode,
        prompt: expect.stringContaining(toolInput.prompt),
      })
    );
    expect(mockPrepareSession.mock.calls[0]?.[0]).not.toHaveProperty('gitUrl');
    expect(getGitLabTokenForOrganization).not.toHaveBeenCalled();
    expect(getGitLabTokenForUser).not.toHaveBeenCalled();
    expect(resolveGitHubRepositoryForOwner).toHaveBeenCalledWith(
      { type: 'org', id: 'org-1' },
      threadRepository,
      'workflow'
    );
    expect(mockGetGitHubIntegrationById).toHaveBeenCalledWith(
      { type: 'org', id: 'org-1' },
      'github-association-1'
    );
    expect(recordBotRequestCloudAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ githubRepo: threadRepository, gitlabProject: undefined })
    );
    const spawnTool = agentOptions().tools.spawnCloudAgentSession;
    expect(Object.keys(z.toJSONSchema(spawnTool.inputSchema).properties ?? {})).toEqual([
      'prompt',
      'mode',
    ]);
    expect(spawnTool.inputSchema.parse(toolInput)).toEqual({
      prompt: toolInput.prompt,
      mode: toolInput.mode,
    });
    expect(getGitHubRepositoryContext).not.toHaveBeenCalled();
    expect(getGitLabRepositoryContext).not.toHaveBeenCalled();
    expect(formatGitHubRepositoriesForPrompt).not.toHaveBeenCalled();
    expect(formatGitLabRepositoriesForPrompt).not.toHaveBeenCalled();
    expect(agentOptions().instructions).toContain(threadRepository);
    expect(agentOptions().instructions).not.toContain(otherRepository);
    expect(agentOptions().instructions).not.toContain(gitlabProject);
    expect(mockGetConversationContext).toHaveBeenCalledTimes(1);
  });

  it('prepares the thread repository when the tool supplies only task inputs', async () => {
    await runBotAgent(githubParams());

    expect(mockPrepareSession).toHaveBeenCalledWith(
      expect.objectContaining({ githubRepo: threadRepository, mode: 'ask' })
    );
    expect(getGitLabTokenForOrganization).not.toHaveBeenCalled();
  });

  it('cannot select another accessible GitHub repository in code mode', async () => {
    toolInput = { ...toolInput, githubRepo: otherRepository, mode: 'code' };

    await runBotAgent(githubParams());

    expect(mockPrepareSession).toHaveBeenCalledWith(
      expect.objectContaining({ githubRepo: threadRepository, mode: 'code' })
    );
    expect(resolveGitHubRepositoryForOwner).not.toHaveBeenCalledWith(
      expect.anything(),
      otherRepository,
      expect.anything()
    );
  });

  it('fails clearly without a trusted repository instead of using tool or prompt suggestions', async () => {
    const params = githubParams();
    params.thread = {
      ...params.thread,
      id: 'github:unresolved',
      channelId: 'github:unresolved',
    } as Thread;
    if (params.rawMessage) params.rawMessage = { ...params.rawMessage, raw: {} } as Message;
    params.prompt = `Review ${threadRepository}; GitHub only`;
    toolInput = { ...toolInput, githubRepo: threadRepository, gitlabProject };

    const result = await runBotAgent(params);

    expect(result.finalText).toContain('Could not resolve the GitHub repository for this thread');
    expect(result.startedCloudAgentSession).toBe(false);
    expect(mockAgentOptions).not.toHaveBeenCalled();
    expect(mockPrepareSession).not.toHaveBeenCalled();
    expect(getGitHubRepositoryContext).not.toHaveBeenCalled();
    expect(getGitLabRepositoryContext).not.toHaveBeenCalled();
    expect(getGitLabTokenForOrganization).not.toHaveBeenCalled();
  });

  it.each(['repository', 'connection'])('retains the GitHub %s access check', async denied => {
    if (denied === 'repository') {
      jest.mocked(resolveGitHubRepositoryForOwner).mockResolvedValue(null);
    } else {
      mockGetGitHubIntegrationById.mockResolvedValue(null);
    }

    const result = await runBotAgent(githubParams());

    expect(result.startedCloudAgentSession).toBe(false);
    expect(result.finalText).toContain(
      denied === 'repository' ? 'not uniquely available' : 'no longer available'
    );
    expect(mockPrepareSession).not.toHaveBeenCalled();
    expect(getGitLabTokenForOrganization).not.toHaveBeenCalled();
  });
});

it('can bind the repository from trusted webhook metadata', async () => {
  const params = runParams();
  params.thread = {
    ...params.thread,
    id: 'github:unresolved',
    channelId: 'github:unresolved',
  } as Thread;

  await runBotAgent(params);

  expect(mockPrepareSession).toHaveBeenCalledWith(
    expect.objectContaining({ githubRepo: threadRepository })
  );
});

describe.each(['slack', 'linear'] as const)('%s repository selection', platform => {
  it.each(['github', 'gitlab'] as const)(
    'preserves model-selected %s repositories',
    async source => {
      const params = runParams(platform);
      toolInput = {
        ...toolInput,
        ...(source === 'github' ? { githubRepo: otherRepository } : { gitlabProject }),
      };

      await runBotAgent(params);

      const properties = z.toJSONSchema(
        agentOptions().tools.spawnCloudAgentSession.inputSchema
      ).properties;
      expect(properties).toHaveProperty('githubRepo');
      expect(properties).toHaveProperty('gitlabProject');
      expect(getGitHubRepositoryContext).toHaveBeenCalledWith(
        { type: 'org', id: 'org-1' },
        platform === 'slack' ? 'agent' : 'workflow'
      );
      expect(getGitLabRepositoryContext).toHaveBeenCalledWith({ type: 'org', id: 'org-1' });
      expect(agentOptions().instructions).toContain(otherRepository);
      expect(agentOptions().instructions).toContain(gitlabProject);
      if (source === 'github') {
        expect(mockPrepareSession).toHaveBeenCalledWith(
          expect.objectContaining({
            githubRepo: otherRepository,
            githubAccessPurpose: platform === 'slack' ? 'agent' : 'workflow',
            createdOnPlatform: platform,
          })
        );
        expect(getGitLabTokenForOrganization).not.toHaveBeenCalled();
      } else {
        expect(getGitLabTokenForOrganization).toHaveBeenCalledWith('org-1', 'bot-user-1');
        expect(mockPrepareSession).toHaveBeenCalledWith(
          expect.objectContaining({
            gitUrl: `https://gitlab.com/${gitlabProject}.git`,
            platform: 'gitlab',
            createdOnPlatform: platform,
          })
        );
        expect(resolveGitHubRepositoryForOwner).not.toHaveBeenCalled();
      }
    }
  );
});
