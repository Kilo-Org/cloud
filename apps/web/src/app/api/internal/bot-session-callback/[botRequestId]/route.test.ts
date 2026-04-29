import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHmac } from 'crypto';
import type { NextRequest } from 'next/server';
import type { POST as POSTType } from './route';

type MockAnyAsync = (...args: unknown[]) => Promise<unknown>;
type MockAnySync = (...args: unknown[]) => unknown;
type MockGetAdapter = (platform: string) => unknown;

const mockDbLimit = jest.fn<MockAnyAsync>();
const mockDbReturning = jest.fn<MockAnyAsync>();
const mockTeamsStartTyping = jest.fn<MockAnyAsync>();
const mockTeamsPostMessage = jest.fn<MockAnyAsync>();
const mockTeamsChannelIdFromThreadId = jest.fn<MockAnySync>();
const mockTeamsIsDM = jest.fn<MockAnySync>();
const mockSlackGetInstallation = jest.fn<MockAnyAsync>();
const mockBotInitialize = jest.fn<MockAnyAsync>();
const mockBotGetAdapter = jest.fn<MockGetAdapter>();
const mockBotRegisterSingleton = jest.fn<MockAnySync>();
const mockGetBotRequestCloudAgentSession = jest.fn<MockAnyAsync>();
const mockGetBotRequestCloudAgentSessionGroupReadiness = jest.fn<MockAnyAsync>();
const mockClaimBotRequestCloudAgentSessionGroupContinuation = jest.fn<MockAnyAsync>();
const mockMarkBotRequestCloudAgentSessionTerminalStrict = jest.fn<MockAnyAsync>();
const mockRecordBotRequestCloudAgentSessionResultStrict = jest.fn<MockAnyAsync>();
const mockRecordBotRequestCloudAgentSessionResultErrorStrict = jest.fn<MockAnyAsync>();

let afterPromises: Promise<void>[] = [];

jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: (fn: () => Promise<void>) => {
    afterPromises.push(fn());
  },
}));

jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-internal-secret',
}));

jest.mock('@/lib/bot/constants', () => ({
  MAX_ITERATIONS: 5,
}));

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: mockDbLimit,
        })),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(() => ({
          returning: mockDbReturning,
        })),
      })),
    })),
  },
}));

jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: mockBotInitialize,
    getAdapter: mockBotGetAdapter,
    registerSingleton: mockBotRegisterSingleton,
  },
}));

jest.mock('@/lib/bot/cloud-agent-session-groups', () => ({
  claimBotRequestCloudAgentSessionGroupContinuation:
    mockClaimBotRequestCloudAgentSessionGroupContinuation,
  getBotRequestCloudAgentSession: mockGetBotRequestCloudAgentSession,
  getBotRequestCloudAgentSessionGroupReadiness: mockGetBotRequestCloudAgentSessionGroupReadiness,
}));

jest.mock('@/lib/bot/request-logging', () => ({
  markBotRequestCloudAgentSessionTerminalStrict: mockMarkBotRequestCloudAgentSessionTerminalStrict,
  recordBotRequestCloudAgentSessionResultErrorStrict:
    mockRecordBotRequestCloudAgentSessionResultErrorStrict,
  recordBotRequestCloudAgentSessionResultStrict: mockRecordBotRequestCloudAgentSessionResultStrict,
}));

jest.mock('@/lib/bot/agent-runner', () => ({
  createSyntheticThread: jest.fn(),
  runBotAgent: jest.fn(),
}));

jest.mock('@/lib/user', () => ({
  findUserById: jest.fn(),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

const BOT_REQUEST_ID = 'd6423759-6630-427a-9631-7faf541d5a1e';
const CLOUD_AGENT_SESSION_ID = 'agent_bc8c260d-9365-4a30-98a7-33371c018b04';
const TEAMS_THREAD_ID = 'teams:conversation:service';

function makeRequest(body: Record<string, unknown>, currentStep = 5): NextRequest {
  const token = createHmac('sha256', 'test-internal-secret')
    .update(`bot-callback:${BOT_REQUEST_ID}`)
    .digest('hex');

  return {
    headers: {
      get: (name: string) => (name === 'X-Bot-Callback-Token' ? token : null),
    },
    json: () => Promise.resolve(body),
    nextUrl: new URL(
      `https://test.kilo.ai/api/internal/bot-session-callback/${BOT_REQUEST_ID}?currentStep=${currentStep}`
    ),
  } as unknown as NextRequest;
}

function makeParams(): { params: Promise<{ botRequestId: string }> } {
  return { params: Promise.resolve({ botRequestId: BOT_REQUEST_ID }) };
}

async function flushAfterCallbacks() {
  await Promise.all(afterPromises);
  afterPromises = [];
}

describe('POST /api/internal/bot-session-callback/[botRequestId]', () => {
  let POST: typeof POSTType;

  beforeEach(async () => {
    jest.clearAllMocks();
    afterPromises = [];

    mockBotInitialize.mockResolvedValue(undefined);
    mockBotGetAdapter.mockImplementation((platform: string) => {
      if (platform === 'teams') {
        return {
          name: 'teams',
          startTyping: mockTeamsStartTyping,
          postMessage: mockTeamsPostMessage,
          channelIdFromThreadId: mockTeamsChannelIdFromThreadId,
          isDM: mockTeamsIsDM,
        };
      }

      return {
        name: 'slack',
        getInstallation: mockSlackGetInstallation,
      };
    });
    mockTeamsStartTyping.mockResolvedValue(undefined);
    mockTeamsPostMessage.mockResolvedValue({
      id: 'teams-message-1',
      threadId: TEAMS_THREAD_ID,
      raw: {},
    });
    mockTeamsChannelIdFromThreadId.mockReturnValue('teams:conversation');
    mockTeamsIsDM.mockReturnValue(false);
    mockSlackGetInstallation.mockRejectedValue(new Error('Slack installation should not be read'));

    mockDbLimit.mockResolvedValue([
      {
        id: BOT_REQUEST_ID,
        created_by: 'user-1',
        organization_id: null,
        platform_integration_id: 'teams-integration-1',
        platform: 'teams',
        platform_thread_id: TEAMS_THREAD_ID,
        platform_message_id: 'teams-message-original',
        user_message: 'Create T3 App',
        status: 'pending',
        error_message: null,
        model_used: null,
        steps: [],
        cloud_agent_session_id: CLOUD_AGENT_SESSION_ID,
        response_time_ms: null,
        created_at: '2026-04-29T14:00:00.000Z',
        updated_at: '2026-04-29T14:00:00.000Z',
      },
    ]);
    mockDbReturning.mockResolvedValue([{ id: BOT_REQUEST_ID }]);

    mockGetBotRequestCloudAgentSession.mockResolvedValue({
      bot_request_id: BOT_REQUEST_ID,
      cloud_agent_session_id: CLOUD_AGENT_SESSION_ID,
      status: 'running',
      final_message: null,
      final_message_error: null,
      github_repo: null,
      gitlab_project: null,
      mode: 'code',
    });
    mockMarkBotRequestCloudAgentSessionTerminalStrict.mockResolvedValue(true);
    mockRecordBotRequestCloudAgentSessionResultStrict.mockResolvedValue(true);
    mockRecordBotRequestCloudAgentSessionResultErrorStrict.mockResolvedValue(true);
    mockGetBotRequestCloudAgentSessionGroupReadiness.mockResolvedValue({
      status: 'ready',
      sessions: [
        {
          bot_request_id: BOT_REQUEST_ID,
          cloud_agent_session_id: CLOUD_AGENT_SESSION_ID,
          status: 'completed',
          final_message: '# Create T3 App',
          final_message_error: null,
          github_repo: null,
          gitlab_project: null,
          mode: 'code',
        },
      ],
    });
    mockClaimBotRequestCloudAgentSessionGroupContinuation.mockResolvedValue(true);

    ({ POST } = await import('./route'));
  });

  it('uses the Teams adapter for tracked Cloud Agent callbacks', async () => {
    const response = await POST(
      makeRequest({
        status: 'completed',
        cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
        executionId: 'execution-1',
        kiloSessionId: 'ses_22660159dffeXLZ427LdfmBTZy',
        lastAssistantMessageText: '# Create T3 App',
      }),
      makeParams()
    );

    expect(response.status).toBe(200);
    await flushAfterCallbacks();

    expect(mockBotGetAdapter).toHaveBeenCalledWith('teams');
    expect(mockBotGetAdapter).not.toHaveBeenCalledWith('slack');
    expect(mockSlackGetInstallation).not.toHaveBeenCalled();
    expect(mockTeamsStartTyping).toHaveBeenCalledWith(
      TEAMS_THREAD_ID,
      'Processing Cloud Agent result...'
    );
    expect(mockTeamsPostMessage).toHaveBeenCalledWith(TEAMS_THREAD_ID, {
      markdown:
        'Cloud Agent result for unknown repository (code, agent_bc8c260d-9365-4a30-98a7-33371c018b04, completed):\n\n# Create T3 App',
    });
    expect(mockDbReturning).toHaveBeenCalled();
  });
});
