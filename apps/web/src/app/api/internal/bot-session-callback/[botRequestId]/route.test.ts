import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';

const afterCallbacks: Array<() => Promise<void> | void> = [];
const mockMarkTerminal = jest.fn<Promise<boolean>, [unknown]>(async () => true);
const mockUpdateValues: Array<Record<string, unknown>> = [];
const mockBotInitialize = jest.fn();
const mockGetPlatformIntegration = jest.fn();
const mockStartProcessingIndicator = jest.fn();
let platformIntegrationId: string | null = '00000000-0000-4000-8000-000000000002';

class MockPlatformIntegrationUnavailableError extends Error {}

jest.mock('next/server', () => ({
  ...jest.requireActual('next/server'),
  after: (callback: () => Promise<void> | void) => afterCallbacks.push(callback),
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: '',
}));
jest.mock('@/lib/web-config.server', () => ({
  CALLBACK_TOKEN_SECRET: 'callback-secret',
}));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              id: '00000000-0000-4000-8000-000000000001',
              status: 'pending',
              created_at: '2026-09-07T00:00:00.000Z',
              cloud_agent_session_id: 'session-1',
              platform_integration_id: platformIntegrationId,
              platform_thread_id: 'github:thread',
              platform_message_id: 'message-1',
              platform: 'github',
              created_by: 'user-1',
              steps: [],
            },
          ],
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        mockUpdateValues.push(values);
        return { where: () => ({ returning: async () => [{ id: 'request-1' }] }) };
      },
    }),
  },
}));
jest.mock('@/lib/bot/cloud-agent-session-groups', () => ({
  getBotRequestCloudAgentSession: jest.fn(async () => ({
    cloud_agent_session_id: 'session-1',
    status: 'pending',
  })),
  getBotRequestCloudAgentSessionGroupReadiness: jest.fn(),
  claimBotRequestCloudAgentSessionGroupContinuation: jest.fn(),
}));
jest.mock('@/lib/bot/request-logging', () => ({
  markBotRequestCloudAgentSessionTerminalStrict: (input: unknown) => mockMarkTerminal(input),
  recordBotRequestCloudAgentSessionResultErrorStrict: jest.fn(),
  recordBotRequestCloudAgentSessionResultStrict: jest.fn(),
}));
jest.mock('@/lib/bot/platform-helpers', () => ({
  PlatformIntegrationUnavailableError: MockPlatformIntegrationUnavailableError,
  PlatformIntegrationNotFoundError: class PlatformIntegrationNotFoundError extends Error {},
  getPlatformIntegrationById: (...args: unknown[]) => mockGetPlatformIntegration(...args),
}));
jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: (...args: unknown[]) => mockBotInitialize(...args),
    thread: jest.fn(() => ({ id: 'thread' })),
  },
}));
jest.mock('@/lib/bot/platforms', () => ({
  botPlatforms: {
    require: () => ({
      withAuthContext: async ({ fn }: { fn: () => Promise<unknown> }) => fn(),
      startProcessingIndicator: (...args: unknown[]) => mockStartProcessingIndicator(...args),
    }),
  },
}));
jest.mock('@/lib/bot/agent-runner', () => ({ runBotAgent: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/user/find-user-by-id', () => ({ findUserById: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { GitHubRuntimeAuthorizationError } from '@/lib/integrations/github/runtime-authorization';
import type { BotRequestCloudAgentSession } from '@kilocode/db/schema';
import {
  getBotRequestCloudAgentSession,
  getBotRequestCloudAgentSessionGroupReadiness,
  claimBotRequestCloudAgentSessionGroupContinuation,
} from '@/lib/bot/cloud-agent-session-groups';
import { recordBotRequestCloudAgentSessionResultStrict } from '@/lib/bot/request-logging';
import type * as RequestLogging from '@/lib/bot/request-logging';
import { runBotAgent } from '@/lib/bot/agent-runner';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { captureException } from '@sentry/nextjs';
import { bot } from '@/lib/bot';
import { MAX_ITERATIONS } from '@/lib/bot/constants';

beforeEach(() => {
  afterCallbacks.length = 0;
  mockUpdateValues.length = 0;
  mockMarkTerminal.mockClear();
  mockMarkTerminal.mockImplementation(async () => true);
  jest.mocked(getBotRequestCloudAgentSession).mockResolvedValue({
    cloud_agent_session_id: 'session-1',
    status: 'running',
  } as BotRequestCloudAgentSession);
  mockBotInitialize.mockClear();
  platformIntegrationId = '00000000-0000-4000-8000-000000000002';
  mockGetPlatformIntegration.mockRejectedValue(
    new MockPlatformIntegrationUnavailableError('disconnected')
  );
  mockStartProcessingIndicator.mockResolvedValue(async () => {});
});

describe('completed callback continuation', () => {
  const mockPost = jest.fn(async (_message: { markdown: string }) => ({ id: 'posted-message' }));
  const sessions = new Map<string, BotRequestCloudAgentSession>();
  let claimed: boolean;
  let consoleLog: jest.SpyInstance;
  let consoleError: jest.SpyInstance;

  function addSession(id = 'session-1') {
    const session = {
      cloud_agent_session_id: id,
      status: 'running',
      final_message: null,
      final_message_error: null,
      github_repo: `org/${id}`,
      mode: 'code',
    } as BotRequestCloudAgentSession;
    sessions.set(id, session);
    return session;
  }

  async function deliver(payload: Record<string, unknown>, currentStep = 1) {
    const botRequestId = '00000000-0000-4000-8000-000000000001';
    const token = createHmac('sha256', 'callback-secret')
      .update(`bot-callback:${botRequestId}`)
      .digest('hex');
    const request = new NextRequest(`http://localhost/callback?currentStep=${currentStep}`, {
      method: 'POST',
      headers: { 'X-Bot-Callback-Token': token, 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'completed',
        cloudAgentSessionId: 'session-1',
        executionId: 'execution-1',
        ...payload,
      }),
    });
    const { POST } = await import('./route');
    expect((await POST(request, { params: Promise.resolve({ botRequestId }) })).status).toBe(200);
    await Promise.all(afterCallbacks.splice(0).map(callback => callback()));
  }

  beforeEach(() => {
    sessions.clear();
    claimed = false;
    mockPost.mockClear();
    consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.mocked(captureException).mockClear();
    mockGetPlatformIntegration.mockResolvedValue({ id: platformIntegrationId, platform: 'github' });
    jest.mocked(bot.thread).mockReturnValue({
      id: 'thread',
      post: mockPost,
      startTyping: jest.fn(),
      adapter: {},
    } as unknown as ReturnType<typeof bot.thread>);
    jest
      .mocked(findUserById)
      .mockResolvedValue({ id: 'user-1' } as Awaited<ReturnType<typeof findUserById>>);
    jest.mocked(runBotAgent).mockReset();
    jest.mocked(runBotAgent).mockResolvedValue({
      finalText: 'Bot synthesized response',
      startedCloudAgentSession: false,
      collectedSteps: [],
      responseTimeMs: 1,
    });
    jest
      .mocked(getBotRequestCloudAgentSession)
      .mockImplementation(async params => sessions.get(params.cloudAgentSessionId));
    mockMarkTerminal.mockImplementation(async input => {
      const params = input as {
        cloudAgentSessionId: string;
        status: BotRequestCloudAgentSession['status'];
        errorMessage?: string;
      };
      const session = sessions.get(params.cloudAgentSessionId);
      if (session) {
        session.status = params.status;
        session.error_message = params.errorMessage ?? null;
      }
      return true;
    });
    jest.mocked(recordBotRequestCloudAgentSessionResultStrict).mockReset();
    jest.mocked(recordBotRequestCloudAgentSessionResultStrict).mockImplementation(async params => {
      const session = sessions.get(params.cloudAgentSessionId);
      if (!session) return false;
      session.final_message = params.finalMessage;
      session.final_message_error = params.resultError ?? null;
      return true;
    });
    jest.mocked(getBotRequestCloudAgentSessionGroupReadiness).mockImplementation(async () => {
      const rows = [...sessions.values()];
      const waitingSessions = rows.filter(session => session.status === 'running');
      return waitingSessions.length
        ? { status: 'waiting-for-terminal', sessions: rows, waitingSessions }
        : { status: 'ready', sessions: rows };
    });
    jest.mocked(claimBotRequestCloudAgentSessionGroupContinuation).mockReset();
    jest.mocked(claimBotRequestCloudAgentSessionGroupContinuation).mockImplementation(async () => {
      if (claimed) return false;
      claimed = true;
      return true;
    });
  });

  afterEach(() => {
    consoleLog.mockRestore();
    consoleError.mockRestore();
  });

  test.each(['tracked', 'legacy'])(
    'continues %s missing summary with labeled partial evidence',
    async kind => {
      if (kind === 'tracked') addSession();
      await deliver({ recentActivity: 'Assistant: changed a file\nTool: test (completed)' });
      expect(runBotAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          completedStepCount: 1,
          prompt: expect.stringContaining(
            'Partial activity evidence (not a final response or proof of success'
          ),
        })
      );
      expect(jest.mocked(runBotAgent).mock.calls[0]?.[0].prompt).toContain(
        'Assistant: changed a file'
      );
      expect(mockPost).toHaveBeenCalledWith({ markdown: 'Bot synthesized response' });
      expect(mockUpdateValues).toContainEqual(expect.objectContaining({ status: 'completed' }));
      if (kind === 'tracked') {
        expect(recordBotRequestCloudAgentSessionResultStrict).toHaveBeenCalledWith(
          expect.objectContaining({
            finalMessage: expect.stringContaining('Partial activity evidence'),
            resultError: 'missing-final-summary',
          })
        );
      }
    }
  );

  test.each([undefined, '', '  \n', 7, {}, ['activity'], 'x'.repeat(12_001)])(
    'discards invalid or empty activity without breaking delivery (%p)',
    async activity => {
      addSession();
      await deliver({ recentActivity: activity, lastAssistantMessageText: '  \n' });
      expect(runBotAgent).toHaveBeenCalledTimes(1);
      const prompt = jest.mocked(runBotAgent).mock.calls[0]?.[0].prompt;
      expect(prompt).toContain('final summary is unavailable');
      expect(prompt).toContain('No partial activity evidence was provided.');
      expect(prompt).not.toContain('<cloud_agent_partial_activity>');
      expect(mockUpdateValues).not.toContainEqual(expect.objectContaining({ status: 'error' }));
    }
  );

  test('accepts activity at the exact character bound', async () => {
    await deliver({ recentActivity: 'x'.repeat(12_000) });
    expect(jest.mocked(runBotAgent).mock.calls[0]?.[0].prompt).toContain('x'.repeat(12_000));
  });

  test.each(['tracked', 'legacy'])(
    'continues an old %s payload without any summary or activity',
    async kind => {
      if (kind === 'tracked') addSession();
      await deliver({});
      expect(runBotAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('No partial activity evidence was provided.'),
        })
      );
      expect(mockUpdateValues).not.toContainEqual(expect.objectContaining({ status: 'error' }));
    }
  );

  test.each(['tracked', 'legacy'])(
    'posts the genuine %s final response at the iteration limit',
    async kind => {
      if (kind === 'tracked') addSession();
      await deliver(
        { lastAssistantMessageText: 'genuine final summary', recentActivity: 'ignored evidence' },
        MAX_ITERATIONS
      );
      expect(runBotAgent).not.toHaveBeenCalled();
      expect(mockPost).toHaveBeenCalledWith({
        markdown: expect.stringContaining('genuine final summary'),
      });
      expect(JSON.stringify(mockPost.mock.calls)).not.toContain('ignored evidence');
    }
  );

  test('awaits all siblings, retains fallback evidence, and continues only once', async () => {
    addSession();
    addSession('session-2');
    await deliver({ recentActivity: 'partial sibling evidence' });
    expect(runBotAgent).not.toHaveBeenCalled();
    expect(claimBotRequestCloudAgentSessionGroupContinuation).not.toHaveBeenCalled();
    await deliver({
      cloudAgentSessionId: 'session-2',
      lastAssistantMessageText: 'genuine sibling summary',
    });
    expect(runBotAgent).toHaveBeenCalledTimes(1);
    const prompt = jest.mocked(runBotAgent).mock.calls[0]?.[0].prompt;
    expect(prompt).toContain('partial sibling evidence');
    expect(prompt).toContain('genuine sibling summary');
    await deliver({
      cloudAgentSessionId: 'session-2',
      lastAssistantMessageText: 'duplicate summary',
    });
    expect(runBotAgent).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  test.each(['tracked', 'legacy'])(
    'posts only a missing-summary notice at the %s iteration limit',
    async kind => {
      if (kind === 'tracked') addSession();
      await deliver({ recentActivity: 'PRIVATE RAW ACTIVITY' }, MAX_ITERATIONS);
      expect(runBotAgent).not.toHaveBeenCalled();
      expect(mockPost).toHaveBeenCalledWith({
        markdown: expect.stringContaining(
          'session-1 completed, but its final summary is unavailable'
        ),
      });
      expect(JSON.stringify(mockPost.mock.calls)).not.toContain('PRIVATE RAW ACTIVITY');
      expect(mockUpdateValues).toContainEqual(expect.objectContaining({ status: 'completed' }));
    }
  );

  test('posts genuine sibling results normally at the iteration limit without fallback activity', async () => {
    addSession();
    addSession('session-2');
    await deliver({ recentActivity: 'PRIVATE RAW ACTIVITY' }, MAX_ITERATIONS);
    await deliver(
      { cloudAgentSessionId: 'session-2', lastAssistantMessageText: 'genuine sibling summary' },
      MAX_ITERATIONS
    );
    const markdown = mockPost.mock.calls[0]?.[0];
    expect(markdown).toEqual({ markdown: expect.stringContaining('genuine sibling summary') });
    expect(JSON.stringify(markdown)).toContain(
      'session-1 completed, but its final summary is unavailable'
    );
    expect(JSON.stringify(markdown)).not.toContain('PRIVATE RAW ACTIVITY');
  });

  test('preserves the genuine final response path', async () => {
    addSession();
    await deliver({
      lastAssistantMessageText: 'genuine final summary',
      recentActivity: 'ignored evidence',
    });
    expect(recordBotRequestCloudAgentSessionResultStrict).toHaveBeenCalledWith(
      expect.objectContaining({
        finalMessage: 'genuine final summary',
        resultError: undefined,
      })
    );
    expect(jest.mocked(runBotAgent).mock.calls[0]?.[0].prompt).toContain('genuine final summary');
    expect(jest.mocked(runBotAgent).mock.calls[0]?.[0].prompt).not.toContain('ignored evidence');
  });

  test('writes fallback evidence and its marker atomically, then clears the marker for a genuine result', async () => {
    const logging = jest.requireActual<typeof RequestLogging>('@/lib/bot/request-logging');
    await expect(
      logging.recordBotRequestCloudAgentSessionResultStrict({
        botRequestId: 'request-1',
        cloudAgentSessionId: 'session-1',
        finalMessage: 'labeled partial evidence',
        resultError: 'missing-final-summary',
      })
    ).resolves.toBe(true);
    expect(mockUpdateValues).toEqual([
      expect.objectContaining({
        final_message: 'labeled partial evidence',
        final_message_error: 'missing-final-summary',
        final_message_fetched_at: expect.any(String),
      }),
    ]);
    await logging.recordBotRequestCloudAgentSessionResultStrict({
      botRequestId: 'request-1',
      cloudAgentSessionId: 'session-1',
      finalMessage: 'genuine result',
    });
    expect(mockUpdateValues[1]).toEqual(
      expect.objectContaining({
        final_message: 'genuine result',
        final_message_error: null,
      })
    );
  });

  test('preserves actual stored result errors rather than treating them as fallback evidence', async () => {
    const session = addSession();
    session.final_message_error = 'actual result storage failure';
    await deliver({ recentActivity: 'PRIVATE RAW ACTIVITY' });
    expect(runBotAgent).not.toHaveBeenCalled();
    expect(mockUpdateValues).toContainEqual(
      expect.objectContaining({ status: 'error', error_message: 'actual result storage failure' })
    );
    expect(mockPost).toHaveBeenCalledWith({ markdown: 'actual result storage failure' });
  });

  test.each(['failed', 'interrupted'])('preserves %s callback behavior', async status => {
    await deliver({
      status,
      errorMessage: 'actual execution failure',
      recentActivity: 'ignored evidence',
    });
    expect(runBotAgent).not.toHaveBeenCalled();
    expect(mockUpdateValues).toContainEqual(expect.objectContaining({ status: 'error' }));
    expect(mockPost).toHaveBeenCalledWith({
      markdown: expect.stringContaining('actual execution failure'),
    });
    expect(JSON.stringify(mockPost.mock.calls)).not.toContain('ignored evidence');
  });

  test('preserves failed sibling handling', async () => {
    addSession();
    const failed = addSession('session-2');
    failed.status = 'failed';
    failed.error_message = 'actual sibling failure';
    await deliver({ recentActivity: 'ignored evidence' });
    expect(runBotAgent).not.toHaveBeenCalled();
    expect(mockUpdateValues).toContainEqual(expect.objectContaining({ status: 'error' }));
    expect(mockPost).toHaveBeenCalledWith({
      markdown: expect.stringContaining('actual sibling failure'),
    });
  });

  test('preserves database result failures without leaking fallback context to telemetry', async () => {
    addSession();
    jest
      .mocked(recordBotRequestCloudAgentSessionResultStrict)
      .mockRejectedValue(new Error('query contains PRIVATE RAW ACTIVITY'));
    await deliver({ recentActivity: 'PRIVATE RAW ACTIVITY' });
    expect(runBotAgent).not.toHaveBeenCalled();
    expect(mockUpdateValues).toContainEqual(expect.objectContaining({ status: 'error' }));
    expect(mockPost).toHaveBeenCalledWith({
      markdown: 'Cloud Agent callback processing failed while saving session state.',
    });
    expect(captureException).toHaveBeenCalled();
    expect(JSON.stringify(jest.mocked(captureException).mock.calls)).not.toContain(
      'PRIVATE RAW ACTIVITY'
    );
    expect(jest.mocked(captureException).mock.calls[0]?.[0]).toEqual(
      new Error('Failed to persist Cloud Agent callback result.')
    );
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain('PRIVATE RAW ACTIVITY');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('PRIVATE RAW ACTIVITY');
  });

  test('does not spread callback context into Sentry or log fallback previews', async () => {
    addSession();
    jest
      .mocked(runBotAgent)
      .mockRejectedValue(new Error('model error includes PRIVATE RAW ACTIVITY'));
    await deliver({
      recentActivity: 'PRIVATE RAW ACTIVITY',
      unknownContext: 'OTHER PRIVATE CONTEXT',
    });
    expect(captureException).toHaveBeenCalled();
    expect(JSON.stringify(jest.mocked(captureException).mock.calls)).not.toContain('PRIVATE');
    expect(jest.mocked(captureException).mock.calls[0]?.[0]).toEqual(
      new Error('Deferred Cloud Agent callback processing failed.')
    );
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain('PRIVATE');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('PRIVATE');
  });

  test('does not log continuation text that may quote partial evidence', async () => {
    addSession();
    jest.mocked(runBotAgent).mockResolvedValue({
      finalText: 'quotes PRIVATE RAW ACTIVITY',
      startedCloudAgentSession: false,
      collectedSteps: [],
      responseTimeMs: 1,
    });
    await deliver({ recentActivity: 'PRIVATE RAW ACTIVITY' });
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain('PRIVATE RAW ACTIVITY');
    expect(captureException).not.toHaveBeenCalled();
  });
});

test('persists terminal callback state and finalizes without publishing after disconnect', async () => {
  const botRequestId = '00000000-0000-4000-8000-000000000001';
  const token = createHmac('sha256', 'callback-secret')
    .update(`bot-callback:${botRequestId}`)
    .digest('hex');
  const request = new NextRequest(`http://localhost/callback?currentStep=1`, {
    method: 'POST',
    headers: { 'X-Bot-Callback-Token': token, 'content-type': 'application/json' },
    body: JSON.stringify({
      status: 'completed',
      cloudAgentSessionId: 'session-1',
      executionId: 'execution-1',
      lastAssistantMessageText: 'finished',
    }),
  });
  const { POST } = await import('./route');
  const response = await POST(request, { params: Promise.resolve({ botRequestId }) });
  expect(response.status).toBe(200);
  await Promise.all(afterCallbacks.splice(0).map(callback => callback()));
  expect(mockMarkTerminal).toHaveBeenCalledWith(
    expect.objectContaining({ cloudAgentSessionId: 'session-1', status: 'completed' })
  );
  expect(mockUpdateValues).toContainEqual(
    expect.objectContaining({
      status: 'error',
      error_message: 'Platform connection was disconnected before callback publication.',
    })
  );
  expect(mockBotInitialize).not.toHaveBeenCalled();
});

test('finalizes when disconnect is detected by the processing indicator after healthy lookup', async () => {
  mockGetPlatformIntegration.mockResolvedValue({
    id: platformIntegrationId,
    platform: 'github',
  });
  mockStartProcessingIndicator.mockRejectedValue(new GitHubRuntimeAuthorizationError());
  const botRequestId = '00000000-0000-4000-8000-000000000001';
  const token = createHmac('sha256', 'callback-secret')
    .update(`bot-callback:${botRequestId}`)
    .digest('hex');
  const request = new NextRequest('http://localhost/callback?currentStep=1', {
    method: 'POST',
    headers: { 'X-Bot-Callback-Token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'completed', cloudAgentSessionId: 'session-1' }),
  });
  const { POST } = await import('./route');
  await POST(request, { params: Promise.resolve({ botRequestId }) });
  await Promise.all(afterCallbacks.splice(0).map(callback => callback()));
  expect(mockMarkTerminal).toHaveBeenCalled();
  expect(mockUpdateValues).toContainEqual(
    expect.objectContaining({
      status: 'error',
      error_message: 'Platform connection was disconnected before callback publication.',
    })
  );
});

test('finalizes without publishing when the integration was deleted before callback', async () => {
  platformIntegrationId = null;
  const botRequestId = '00000000-0000-4000-8000-000000000001';
  const token = createHmac('sha256', 'callback-secret')
    .update(`bot-callback:${botRequestId}`)
    .digest('hex');
  const request = new NextRequest('http://localhost/callback?currentStep=1', {
    method: 'POST',
    headers: { 'X-Bot-Callback-Token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'failed', cloudAgentSessionId: 'session-1' }),
  });
  const { POST } = await import('./route');
  const response = await POST(request, { params: Promise.resolve({ botRequestId }) });
  expect(response.status).toBe(200);
  await Promise.all(afterCallbacks.splice(0).map(callback => callback()));
  expect(mockMarkTerminal).toHaveBeenCalled();
  expect(mockUpdateValues).toContainEqual(
    expect.objectContaining({
      status: 'error',
      error_message: 'Platform connection was removed before callback publication.',
    })
  );
  expect(mockBotInitialize).not.toHaveBeenCalled();
});
