const mockRequireByAdapterFn = jest.fn();
const mockRunBotAgentFn = jest.fn();
const mockCreateBotRequestFn = jest.fn();
const mockUpdateBotRequestFn = jest.fn();
const mockExtractAndUploadAttachmentsFn = jest.fn();

function requireByAdapter(...args: unknown[]) {
  return mockRequireByAdapterFn(...args);
}

function runBotAgent(...args: unknown[]) {
  return mockRunBotAgentFn(...args);
}

function createBotRequest(...args: unknown[]) {
  return mockCreateBotRequestFn(...args);
}

function updateBotRequest(...args: unknown[]) {
  return mockUpdateBotRequestFn(...args);
}

function extractAndUploadAttachments(...args: unknown[]) {
  return mockExtractAndUploadAttachmentsFn(...args);
}

jest.mock('@/lib/bot/platforms', () => ({
  botPlatforms: { requireByAdapter },
}));

jest.mock('@/lib/bot/agent-runner', () => ({
  runBotAgent,
}));

jest.mock('@/lib/bot/request-logging', () => ({
  createBotRequest,
  updateBotRequest,
}));

jest.mock('@/lib/bot/attachments', () => ({
  extractAndUploadAttachments,
}));

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import type { Message, Thread } from 'chat';
import type { PlatformIntegration, User } from '@kilocode/db';
import { processLinkedMessage } from './run';

const thread = {
  id: 'github:Kilo-Org/on-call:issue:37',
  adapter: { name: 'github' },
  post: jest.fn(async () => ({ id: 'posted-1' })),
  startTyping: jest.fn(async () => undefined),
} as unknown as Thread;

const message = {
  id: '55',
  text: '@kilocode-dev please fix the build',
  author: { fullName: 'rso-dev', isBot: false, isMe: false, userId: '42', userName: 'rso-dev' },
  attachments: [],
} as unknown as Message;

const integration = {
  id: 'pi_1',
  platform: 'github',
  owned_by_organization_id: 'org_1',
  platform_installation_id: '98765',
} as PlatformIntegration;

const user = { id: 'user_1' } as User;

function createBotPlatform(overrides: Record<string, unknown> = {}) {
  return {
    authorizeBotActions: jest.fn(async () => ({ allowed: true })),
    startProcessingIndicator: jest.fn(async () => jest.fn(async () => undefined)),
    withAuthContext: jest.fn(async ({ fn }: { fn: () => Promise<unknown> }) => await fn()),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockExtractAndUploadAttachmentsFn.mockResolvedValue({ files: [] });
  mockCreateBotRequestFn.mockResolvedValue('bot-request-1');
  mockRunBotAgentFn.mockResolvedValue({
    finalText: 'Done.',
    startedCloudAgentSession: false,
    collectedSteps: [],
    responseTimeMs: 12,
  });
});

test('a denied repository authorization replies and never starts the agent', async () => {
  mockRequireByAdapterFn.mockReturnValue(
    createBotPlatform({
      authorizeBotActions: jest.fn(async () => ({
        allowed: false,
        markdown: 'I could not confirm write access to `Kilo-Org/on-call`.',
      })),
    })
  );

  await processLinkedMessage({ thread, message, platformIntegration: integration, user });

  expect(thread.post).toHaveBeenCalledWith({
    markdown: 'I could not confirm write access to `Kilo-Org/on-call`.',
  });
  expect(mockCreateBotRequestFn).not.toHaveBeenCalled();
  expect(mockRunBotAgentFn).not.toHaveBeenCalled();
});

test('an allowed repository authorization runs the agent with the triggering login', async () => {
  const botPlatform = createBotPlatform();
  mockRequireByAdapterFn.mockReturnValue(botPlatform);

  await processLinkedMessage({ thread, message, platformIntegration: integration, user });

  expect(botPlatform.authorizeBotActions).toHaveBeenCalledWith({
    thread,
    message,
    platformIntegration: integration,
  });
  expect(mockRunBotAgentFn).toHaveBeenCalledWith(
    expect.objectContaining({ actorLogin: 'rso-dev', botRequestId: 'bot-request-1' })
  );
});
