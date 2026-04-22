import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import type { NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import {
  bot_requests,
  bot_request_cloud_agent_sessions,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { randomUUID, createHmac } from 'crypto';
import type { POST as POSTType } from './route';

// --- Mock functions ---

const mockRunBotAgent = jest.fn() as jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const mockFetchFinalAssistantTextWithRetries = jest.fn() as jest.Mock<
  (...args: unknown[]) => Promise<unknown>
>;
const mockPostMessage = jest.fn() as jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const mockGetInstallation = jest.fn() as jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const mockInitialize = jest.fn() as jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const mockRegisterSingleton = jest.fn() as jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const mockFetchThread = jest.fn() as jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const mockRemoveReaction = jest.fn() as jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const mockAddReaction = jest.fn() as jest.Mock<(...args: unknown[]) => Promise<unknown>>;

// Capture promises scheduled via next/server `after` so tests can await them.
let afterPromises: Promise<void>[] = [];

jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server') as Record<string, unknown>;
  return {
    ...actual,
    after: (fn: () => Promise<void>) => {
      afterPromises.push(fn());
    },
  };
});

/** Flush all pending `after` callbacks and reset the queue. */
async function flushAfterCallbacks() {
  await Promise.all(afterPromises);
  afterPromises = [];
}

// Note: jest.mock of config.server does not take effect in this test environment,
// so we use the real value from .env.test (mock-secret) for token derivation.
// jest.mock('@/lib/config.server', () => ({
//   INTERNAL_API_SECRET: 'test-internal-secret',
// }));

jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: mockInitialize,
    registerSingleton: mockRegisterSingleton,
    getAdapter: jest.fn(() => ({
      getInstallation: mockGetInstallation,
      postMessage: mockPostMessage,
      fetchThread: mockFetchThread,
      removeReaction: mockRemoveReaction,
      addReaction: mockAddReaction,
      withBotToken: jest.fn(async (_token: string, fn: () => Promise<unknown>) => fn()),
    })),
  },
}));

jest.mock('@/lib/cloud-agent-next/session-result', () => ({
  fetchFinalAssistantTextWithRetries: mockFetchFinalAssistantTextWithRetries,
}));

jest.mock('@/lib/bot/agent-runner', () => ({
  createSyntheticThread: jest.fn((_params: unknown) => ({
    id: 'slack:T123:C456:thread1',
    postEphemeral: jest.fn(),
  })),
  runBotAgent: mockRunBotAgent,
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

// Dynamically import the route so mocks are resolved first.
let POST: typeof POSTType;
beforeAll(async () => {
  const route = await import('./route');
  POST = route.POST;
});

function deriveToken(botRequestId: string): string {
  return createHmac('sha256', 'mock-secret').update(`bot-callback:${botRequestId}`).digest('hex');
}

function makeRequest(botRequestId: string, body: Record<string, unknown>): NextRequest {
  return {
    headers: {
      get: (name: string) => (name === 'X-Bot-Callback-Token' ? deriveToken(botRequestId) : null),
    },
    json: async () => body,
    nextUrl: {
      searchParams: {
        get: () => '0',
      },
    },
  } as unknown as NextRequest;
}

describe('bot session callback route', () => {
  beforeEach(async () => {
    afterPromises = [];
    jest.clearAllMocks();
    mockGetInstallation.mockResolvedValue({ botToken: 'test-bot-token' });
    mockPostMessage.mockResolvedValue({ id: 'mock-message-id' });
    mockFetchThread.mockResolvedValue({
      id: 'slack:T123:C456:thread1',
      channelId: 'C456',
      isDM: false,
    });
    mockRunBotAgent.mockResolvedValue({
      finalText: 'Continuation result',
      startedCloudAgentSession: false,
      collectedSteps: [],
      responseTimeMs: 100,
    });
    mockFetchFinalAssistantTextWithRetries.mockResolvedValue('Final assistant text');

    await db.delete(bot_request_cloud_agent_sessions).where(sql`true`);
    await db.delete(bot_requests).where(sql`true`);
    await db.delete(platform_integrations).where(sql`true`);
  });

  async function createTestBotRequest() {
    const user = await insertTestUser();
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        platform: 'slack',
        integration_type: 'app',
        platform_installation_id: 'T123',
        owned_by_user_id: user.id,
      })
      .returning({ id: platform_integrations.id });

    const [request] = await db
      .insert(bot_requests)
      .values({
        created_by: user.id,
        platform_integration_id: integration.id,
        platform: 'slack',
        platform_thread_id: 'slack:T123:C456:thread1',
        platform_message_id: 'msg-123',
        user_message: 'Test message',
        status: 'pending',
      })
      .returning({ id: bot_requests.id });

    return { user, integration, request };
  }

  it('accepts a callback for an associated session', async () => {
    const { request } = await createTestBotRequest();
    const spawnGroupId = randomUUID();

    await db.insert(bot_request_cloud_agent_sessions).values({
      bot_request_id: request.id,
      spawn_group_id: spawnGroupId,
      cloud_agent_session_id: 'agent_assoc',
      status: 'running',
    });

    const req = makeRequest(request.id, {
      sessionId: 'sess_1',
      cloudAgentSessionId: 'agent_assoc',
      executionId: 'exec_1',
      status: 'completed',
      kiloSessionId: 'kilo_1',
    });

    const res = await POST(req, { params: Promise.resolve({ botRequestId: request.id }) });
    expect(res.status).toBe(200);

    await flushAfterCallbacks();

    const [session] = await db
      .select()
      .from(bot_request_cloud_agent_sessions)
      .where(eq(bot_request_cloud_agent_sessions.cloud_agent_session_id, 'agent_assoc'));

    expect(session.status).toBe('completed');
    expect(session.kilo_session_id).toBe('kilo_1');
  });

  it('ignores a callback for an unassociated session', async () => {
    const { request } = await createTestBotRequest();

    const req = makeRequest(request.id, {
      sessionId: 'sess_1',
      cloudAgentSessionId: 'agent_unassoc',
      executionId: 'exec_1',
      status: 'completed',
      kiloSessionId: 'kilo_1',
    });

    const res = await POST(req, { params: Promise.resolve({ botRequestId: request.id }) });
    expect(res.status).toBe(200);

    await flushAfterCallbacks();

    expect(mockFetchFinalAssistantTextWithRetries).not.toHaveBeenCalled();
    expect(mockRunBotAgent).not.toHaveBeenCalled();
  });

  it('does not continue while siblings are still running', async () => {
    const { request } = await createTestBotRequest();
    const spawnGroupId = randomUUID();

    await db.insert(bot_request_cloud_agent_sessions).values([
      {
        bot_request_id: request.id,
        spawn_group_id: spawnGroupId,
        cloud_agent_session_id: 'agent_a',
        status: 'running',
      },
      {
        bot_request_id: request.id,
        spawn_group_id: spawnGroupId,
        cloud_agent_session_id: 'agent_b',
        status: 'running',
      },
    ]);

    // First callback: agent_a completes
    const reqA = makeRequest(request.id, {
      sessionId: 'sess_a',
      cloudAgentSessionId: 'agent_a',
      executionId: 'exec_a',
      status: 'completed',
      kiloSessionId: 'kilo_a',
    });

    const resA = await POST(reqA, { params: Promise.resolve({ botRequestId: request.id }) });
    expect(resA.status).toBe(200);
    await flushAfterCallbacks();

    expect(mockRunBotAgent).not.toHaveBeenCalled();
    expect(mockFetchFinalAssistantTextWithRetries).not.toHaveBeenCalled();

    // Second callback: agent_b completes
    const reqB = makeRequest(request.id, {
      sessionId: 'sess_b',
      cloudAgentSessionId: 'agent_b',
      executionId: 'exec_b',
      status: 'completed',
      kiloSessionId: 'kilo_b',
    });

    const resB = await POST(reqB, { params: Promise.resolve({ botRequestId: request.id }) });
    expect(resB.status).toBe(200);
    await flushAfterCallbacks();

    expect(mockFetchFinalAssistantTextWithRetries).toHaveBeenCalledTimes(2);
    expect(mockRunBotAgent).toHaveBeenCalledTimes(1);
  });

  it('claims the group and invokes continuation exactly once', async () => {
    const { request } = await createTestBotRequest();
    const spawnGroupId = randomUUID();

    await db.insert(bot_request_cloud_agent_sessions).values([
      {
        bot_request_id: request.id,
        spawn_group_id: spawnGroupId,
        cloud_agent_session_id: 'agent_x',
        status: 'running',
      },
      {
        bot_request_id: request.id,
        spawn_group_id: spawnGroupId,
        cloud_agent_session_id: 'agent_y',
        status: 'running',
      },
    ]);

    // Both callbacks arrive concurrently
    const reqX = makeRequest(request.id, {
      sessionId: 'sess_x',
      cloudAgentSessionId: 'agent_x',
      executionId: 'exec_x',
      status: 'completed',
      kiloSessionId: 'kilo_x',
    });

    const reqY = makeRequest(request.id, {
      sessionId: 'sess_y',
      cloudAgentSessionId: 'agent_y',
      executionId: 'exec_y',
      status: 'completed',
      kiloSessionId: 'kilo_y',
    });

    const resX = await POST(reqX, { params: Promise.resolve({ botRequestId: request.id }) });
    const resY = await POST(reqY, { params: Promise.resolve({ botRequestId: request.id }) });
    expect(resX.status).toBe(200);
    expect(resY.status).toBe(200);

    await flushAfterCallbacks();

    // runBotAgent should be called exactly once (by the single group claimant)
    expect(mockRunBotAgent).toHaveBeenCalledTimes(1);
  });

  it('duplicate callbacks after the group is claimed do not post or continue again', async () => {
    const { request } = await createTestBotRequest();
    const spawnGroupId = randomUUID();

    await db.insert(bot_request_cloud_agent_sessions).values({
      bot_request_id: request.id,
      spawn_group_id: spawnGroupId,
      cloud_agent_session_id: 'agent_z',
      status: 'running',
    });

    const req = makeRequest(request.id, {
      sessionId: 'sess_z',
      cloudAgentSessionId: 'agent_z',
      executionId: 'exec_z',
      status: 'completed',
      kiloSessionId: 'kilo_z',
    });

    // First callback
    await POST(req, { params: Promise.resolve({ botRequestId: request.id }) });
    await flushAfterCallbacks();

    expect(mockRunBotAgent).toHaveBeenCalledTimes(1);

    // Simulate duplicate callback (same session, already terminal and claimed)
    mockRunBotAgent.mockClear();
    mockFetchFinalAssistantTextWithRetries.mockClear();

    await POST(req, { params: Promise.resolve({ botRequestId: request.id }) });
    await flushAfterCallbacks();

    expect(mockRunBotAgent).not.toHaveBeenCalled();
    expect(mockFetchFinalAssistantTextWithRetries).not.toHaveBeenCalled();
  });

  it('includes failed sessions in aggregate continuation instead of immediate failure', async () => {
    const { request } = await createTestBotRequest();
    const spawnGroupId = randomUUID();

    await db.insert(bot_request_cloud_agent_sessions).values([
      {
        bot_request_id: request.id,
        spawn_group_id: spawnGroupId,
        cloud_agent_session_id: 'agent_ok',
        status: 'running',
      },
      {
        bot_request_id: request.id,
        spawn_group_id: spawnGroupId,
        cloud_agent_session_id: 'agent_fail',
        status: 'running',
      },
    ]);

    // Complete the successful one
    const reqOk = makeRequest(request.id, {
      sessionId: 'sess_ok',
      cloudAgentSessionId: 'agent_ok',
      executionId: 'exec_ok',
      status: 'completed',
      kiloSessionId: 'kilo_ok',
    });

    await POST(reqOk, { params: Promise.resolve({ botRequestId: request.id }) });
    await flushAfterCallbacks();

    expect(mockRunBotAgent).not.toHaveBeenCalled();

    // Fail the other one
    const reqFail = makeRequest(request.id, {
      sessionId: 'sess_fail',
      cloudAgentSessionId: 'agent_fail',
      executionId: 'exec_fail',
      status: 'failed',
      errorMessage: 'Out of memory',
    });

    await POST(reqFail, { params: Promise.resolve({ botRequestId: request.id }) });
    await flushAfterCallbacks();

    expect(mockRunBotAgent).toHaveBeenCalledTimes(1);
    const prompt = (mockRunBotAgent.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain('agent_ok');
    expect(prompt).toContain('agent_fail');
    expect(prompt).toContain('Out of memory');
  });

  it('ignores callbacks when bot request is already finalized', async () => {
    const { request } = await createTestBotRequest();
    const spawnGroupId = randomUUID();

    await db
      .update(bot_requests)
      .set({ status: 'completed' })
      .where(eq(bot_requests.id, request.id));

    await db.insert(bot_request_cloud_agent_sessions).values({
      bot_request_id: request.id,
      spawn_group_id: spawnGroupId,
      cloud_agent_session_id: 'agent_done',
      status: 'running',
    });

    const req = makeRequest(request.id, {
      sessionId: 'sess_done',
      cloudAgentSessionId: 'agent_done',
      executionId: 'exec_done',
      status: 'completed',
      kiloSessionId: 'kilo_done',
    });

    const res = await POST(req, { params: Promise.resolve({ botRequestId: request.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe('Bot request already finalized');
  });
});
