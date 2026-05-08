declare global {
  var __botTestMentionHandler: ((thread: unknown, message: unknown) => Promise<void> | void) | null;
}

globalThis.__botTestMentionHandler ??= null;

function getMockState() {
  return { kind: 'state' };
}

function getMockSlackAdapter() {
  return {
    name: 'slack',
    botUserId: 'U_BOT',
    deleteInstallation: jest.fn(),
    deleteMessage: jest.fn(),
    handleWebhook: jest.fn(),
    postMessage: jest.fn(),
    publishHomeView: jest.fn(),
    setSuggestedPrompts: jest.fn(),
  };
}

function getMockGithubAdapter() {
  return {
    name: 'github',
    getInstallationId: jest.fn(),
  };
}

const mockSlackBotPlatform = {
  platform: 'slack',
  documentationUrl: 'https://kilo.ai/docs/code-with-ai/platforms/slack',
  usesGenericLinkAccountRoute: true,
  getIdentity: jest.fn(),
  isEnabledForBot: jest.fn(() => true),
  canHandleMessage: jest.fn(() => true),
  promptLinkAccount: jest.fn(async () => undefined),
  withAuthContext: jest.fn(async ({ fn }: { fn: () => Promise<unknown> }) => await fn()),
  getConversationContext: jest.fn(async () => ''),
  getRequesterInfo: jest.fn(),
};

jest.mock(
  'chat',
  () => ({
    Chat: jest.fn().mockImplementation(() => ({
      webhooks: {},
      getState: () => getMockState(),
      getAdapter: jest.fn(),
      initialize: jest.fn(),
      onAction: jest.fn(),
      onAppHomeOpened: jest.fn(),
      onAssistantThreadStarted: jest.fn(),
      onMemberJoinedChannel: jest.fn(),
      onNewMention: jest.fn(handler => {
        globalThis.__botTestMentionHandler = handler;
      }),
      registerSingleton: jest.fn(),
    })),
  }),
  { virtual: true }
);

jest.mock(
  '@chat-adapter/slack',
  () => ({
    createSlackAdapter: jest.fn(() => getMockSlackAdapter()),
    SlackAdapter: class SlackAdapter {},
  }),
  { virtual: true }
);

jest.mock(
  '@chat-adapter/github',
  () => ({
    createGitHubAdapter: jest.fn(() => getMockGithubAdapter()),
  }),
  { virtual: true }
);

function getMockLinearAdapter() {
  return {
    name: 'linear',
    botUserId: 'bot-linear',
    deleteInstallation: jest.fn(),
    getInstallation: jest.fn(),
    getUser: jest.fn(),
    handleOAuthCallback: jest.fn(),
    handleWebhook: jest.fn(),
    withInstallation: jest.fn(),
  };
}

jest.mock(
  '@chat-adapter/linear',
  () => ({
    createLinearAdapter: jest.fn(() => getMockLinearAdapter()),
    LinearAdapter: class LinearAdapter {},
  }),
  { virtual: true }
);

jest.mock('@/lib/config.server', () => ({
  SLACK_CLIENT_ID: 'slack-client-id',
  SLACK_CLIENT_SECRET: 'slack-client-secret',
  SLACK_SIGNING_SECRET: 'slack-signing-secret',
  LINEAR_CLIENT_ID: 'linear-client-id',
  LINEAR_CLIENT_SECRET: 'linear-client-secret',
  LINEAR_WEBHOOK_SECRET: 'linear-webhook-secret',
}));

jest.mock('@/lib/integrations/platforms/github/app-selector', () => ({
  getGitHubAppCredentials: jest.fn(() => ({
    appId: 'github-app-id',
    privateKey: 'github-private-key',
    webhookSecret: 'github-webhook-secret',
  })),
}));

jest.mock('@/lib/bot-identity', () => ({
  resolveKiloUserId: jest.fn(),
  unlinkKiloUser: jest.fn(async () => undefined),
}));

jest.mock('@/lib/bot/platform-helpers', () => ({
  canKiloUserAccessPlatformIntegration: jest.fn(),
  getPlatformIntegration: jest.fn(),
  getPlatformIntegrationByBotUserId: jest.fn(),
}));

jest.mock('@/lib/bot/platforms', () => ({
  botPlatforms: {
    get: jest.fn(() => mockSlackBotPlatform),
    getByAdapter: jest.fn(() => mockSlackBotPlatform),
    require: jest.fn(() => mockSlackBotPlatform),
    requireByAdapter: jest.fn(() => mockSlackBotPlatform),
  },
}));

jest.mock('@/lib/bot/platforms/slack-webhook', () => ({
  createSlackWebhookHandler: jest.fn(() => async () => new Response('ok')),
}));

jest.mock('@/lib/bot/platforms/linear-webhook', () => ({
  createLinearWebhookHandler: jest.fn(() => async () => new Response('ok')),
}));

jest.mock('@/lib/user', () => ({
  findUserById: jest.fn(),
}));

jest.mock('@/lib/bot/run', () => ({
  processLinkedMessage: jest.fn(async () => undefined),
}));

jest.mock('@/lib/bot/state', () => ({
  createChatState: jest.fn(() => getMockState()),
}));

jest.mock('@/lib/bot/helpers', () => ({
  isSlackMissingScopeError: jest.fn(() => false),
  postSlackReinstallInstruction: jest.fn(),
}));

jest.mock('@/lib/integrations/slack-service', () => ({
  deleteInstallationByTeamId: jest.fn(),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

import { resolveKiloUserId, unlinkKiloUser } from '@/lib/bot-identity';
import {
  canKiloUserAccessPlatformIntegration,
  getPlatformIntegration,
} from '@/lib/bot/platform-helpers';
import { findUserById } from '@/lib/user';
import { processLinkedMessage } from '@/lib/bot/run';
import { bot } from './bot';

const mockedResolveKiloUserId = jest.mocked(resolveKiloUserId);
const mockedUnlinkKiloUser = jest.mocked(unlinkKiloUser);
const mockedCanKiloUserAccessPlatformIntegration = jest.mocked(
  canKiloUserAccessPlatformIntegration
);
const mockedGetPlatformIntegration = jest.mocked(getPlatformIntegration);
const mockedFindUserById = jest.mocked(findUserById);
const mockedProcessLinkedMessage = jest.mocked(processLinkedMessage);
const mockState = getMockState();

function makeThread() {
  return { id: 'thread-1', adapter: { name: 'slack' } };
}

function makeMessage() {
  return { author: { userId: 'U123' }, raw: { team_id: 'T123' } };
}

function getMentionHandler() {
  const handler = globalThis.__botTestMentionHandler;
  if (!handler) throw new Error('mention handler not registered');
  return handler;
}

describe('bot mention authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSlackBotPlatform.getIdentity.mockReset();
    mockSlackBotPlatform.isEnabledForBot.mockReturnValue(true);
    mockSlackBotPlatform.canHandleMessage.mockReturnValue(true);
    mockSlackBotPlatform.promptLinkAccount.mockResolvedValue(undefined as never);
  });

  it('unlinks and prompts again when the linked user no longer has integration access', async () => {
    const identity = { platform: 'slack', teamId: 'T123', userId: 'U123' };
    const integration = { id: 'pi-slack', owned_by_organization_id: 'org-1' };
    const user = { id: 'kilo-user-1' };
    mockSlackBotPlatform.getIdentity.mockResolvedValue(identity as never);
    mockedGetPlatformIntegration.mockResolvedValue(integration as never);
    mockedResolveKiloUserId.mockResolvedValue('kilo-user-1');
    mockedFindUserById.mockResolvedValue(user as never);
    mockedCanKiloUserAccessPlatformIntegration.mockResolvedValue(false);

    await getMentionHandler()(makeThread(), makeMessage());

    expect(mockedUnlinkKiloUser).toHaveBeenCalledWith(mockState, identity);
    expect(mockSlackBotPlatform.promptLinkAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: expect.objectContaining({ id: 'thread-1' }),
        message: expect.objectContaining({ author: { userId: 'U123' } }),
        identity,
        platformIntegration: integration,
        state: mockState,
      })
    );
    expect(mockedProcessLinkedMessage).not.toHaveBeenCalled();
  });

  it('processes the linked message when the user still has integration access', async () => {
    const thread = makeThread();
    const message = makeMessage();
    const identity = { platform: 'slack', teamId: 'T123', userId: 'U123' };
    const integration = { id: 'pi-slack', owned_by_organization_id: 'org-1' };
    const user = { id: 'kilo-user-1' };
    mockSlackBotPlatform.getIdentity.mockResolvedValue(identity as never);
    mockedGetPlatformIntegration.mockResolvedValue(integration as never);
    mockedResolveKiloUserId.mockResolvedValue('kilo-user-1');
    mockedFindUserById.mockResolvedValue(user as never);
    mockedCanKiloUserAccessPlatformIntegration.mockResolvedValue(true);

    await getMentionHandler()(thread, message);

    expect(mockedUnlinkKiloUser).not.toHaveBeenCalled();
    expect(mockSlackBotPlatform.promptLinkAccount).not.toHaveBeenCalled();
    expect(mockedProcessLinkedMessage).toHaveBeenCalledWith({
      thread,
      message,
      platformIntegration: integration,
      user,
    });
  });
});

void bot;
