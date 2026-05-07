import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CodeReviewOrchestrator } from '../../src/code-review-orchestrator';
import type { CodeReview, SessionInput } from '../../src/types';

function getReviewStub(name = `review-${crypto.randomUUID()}`) {
  const id = env.CODE_REVIEW_ORCHESTRATOR.idFromName(name);
  return env.CODE_REVIEW_ORCHESTRATOR.get(id);
}

function sessionInput(): SessionInput {
  return {
    gitUrl: 'https://example.test/repo.git',
    prompt: 'Review this pull request',
    mode: 'code',
    model: 'test-model',
    upstreamBranch: 'main',
  };
}

function codeReview(overrides: Partial<CodeReview> = {}): CodeReview {
  return {
    reviewId: `review-${crypto.randomUUID()}`,
    authToken: 'test-auth-token',
    sessionInput: sessionInput(),
    owner: {
      type: 'user',
      id: 'user-id',
      userId: 'user-id',
    },
    status: 'queued',
    updatedAt: new Date().toISOString(),
    agentVersion: 'v2',
    ...overrides,
  };
}

function workerAuthHeaders(): HeadersInit {
  return { Authorization: 'Bearer test-backend-token' };
}

function hasFetchCall(fetchMock: ReturnType<typeof vi.fn>, path: string): boolean {
  return fetchMock.mock.calls.some(([request]) => String(request).includes(path));
}

function getFetchCall(fetchMock: ReturnType<typeof vi.fn>, path: string) {
  return fetchMock.mock.calls.find(([request]) => String(request).includes(path));
}

describe('CodeReviewOrchestrator recovery', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('start arms a fallback alarm for a queued review', async () => {
    const stub = getReviewStub();

    await stub.start({
      reviewId: crypto.randomUUID(),
      authToken: 'test-auth-token',
      sessionInput: sessionInput(),
      owner: { type: 'user', id: 'user-id', userId: 'user-id' },
      agentVersion: 'v2',
    });

    const alarm = await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) =>
      state.storage.getAlarm()
    );

    expect(alarm).toEqual(expect.any(Number));
    expect(alarm).toBeGreaterThan(Date.now());
  });

  it('status route returns DO status and 404s when no state exists', async () => {
    const missingId = crypto.randomUUID();
    const missingResponse = await SELF.fetch(`https://worker.test/reviews/${missingId}/status`, {
      headers: workerAuthHeaders(),
    });
    expect(missingResponse.status).toBe(404);

    const reviewId = crypto.randomUUID();
    const stub = getReviewStub(reviewId);
    await stub.start({
      reviewId,
      authToken: 'test-auth-token',
      sessionInput: sessionInput(),
      owner: { type: 'user', id: 'user-id', userId: 'user-id' },
      agentVersion: 'v2',
    });

    const response = await SELF.fetch(`https://worker.test/reviews/${reviewId}/status`, {
      headers: workerAuthHeaders(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      reviewId,
      status: 'queued',
    });
  });

  it('queued review alarm retries runReview and transitions to running', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        return Response.json({
          result: {
            data: {
              cloudAgentSessionId: 'agent-test-session',
              kiloSessionId: 'ses_test_session',
            },
          },
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return Response.json({ result: { data: { executionId: 'exec-test', status: 'running' } } });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview());
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    const status = await stub.status();
    expect(status).toMatchObject({
      status: 'running',
      sessionId: 'agent-test-session',
      cliSessionId: 'ses_test_session',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloud-agent-next.example.test/trpc/prepareSession',
      expect.any(Object)
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloud-agent-next.example.test/trpc/initiateFromKilocodeSessionV2',
      expect.any(Object)
    );
  });

  it('continues a healthy previous cloud-agent-next session for follow-up reviews', async () => {
    const stub = getReviewStub();
    const previousSessionId = 'agent_previous_session';
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/getSessionHealth')) {
        return Response.json({
          result: {
            data: {
              cloudAgentSessionId: previousSessionId,
              sandboxId: 'ses-healthy',
              sandboxStatus: 'healthy',
              executionHealth: 'none',
            },
          },
        });
      }
      if (url.includes('/trpc/updateSession')) {
        return Response.json({ result: { data: { success: true } } });
      }
      if (url.includes('/trpc/sendMessageV2')) {
        return Response.json({
          result: { data: { executionId: 'exec-followup', status: 'running' } },
        });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          previousCloudAgentSessionId: previousSessionId,
        })
      );
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    const status = await stub.status();
    expect(status).toMatchObject({
      status: 'running',
      sessionId: previousSessionId,
    });
    expect(status.cliSessionId).toBeUndefined();
    expect(hasFetchCall(fetchMock, '/trpc/getSessionHealth')).toBe(true);
    expect(hasFetchCall(fetchMock, '/trpc/updateSession')).toBe(true);
    expect(hasFetchCall(fetchMock, '/trpc/sendMessageV2')).toBe(true);
    expect(hasFetchCall(fetchMock, '/trpc/prepareSession')).toBe(false);
    expect(hasFetchCall(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toBe(false);
  });

  it('skips continuation and prepares a fresh session when previous sandbox is unreachable', async () => {
    const stub = getReviewStub();
    const previousSessionId = 'agent_previous_unreachable';
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/getSessionHealth')) {
        return Response.json({
          result: {
            data: {
              cloudAgentSessionId: previousSessionId,
              sandboxStatus: 'unreachable',
              executionHealth: 'none',
            },
          },
        });
      }
      if (url.includes('/trpc/prepareSession')) {
        return Response.json({
          result: {
            data: {
              cloudAgentSessionId: 'agent-fresh-session',
              kiloSessionId: 'ses_fresh_session',
            },
          },
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return Response.json({
          result: { data: { executionId: 'exec-fresh', status: 'running' } },
        });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          previousCloudAgentSessionId: previousSessionId,
        })
      );
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    const status = await stub.status();
    expect(status).toMatchObject({
      status: 'running',
      sessionId: 'agent-fresh-session',
      cliSessionId: 'ses_fresh_session',
    });
    expect(hasFetchCall(fetchMock, '/trpc/getSessionHealth')).toBe(true);
    expect(hasFetchCall(fetchMock, '/trpc/updateSession')).toBe(false);
    expect(hasFetchCall(fetchMock, '/trpc/sendMessageV2')).toBe(false);
    expect(hasFetchCall(fetchMock, '/trpc/prepareSession')).toBe(true);
    expect(hasFetchCall(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toBe(true);
  });

  it('skips continuation and prepares a fresh session when previous execution is stale', async () => {
    const stub = getReviewStub();
    const previousSessionId = 'agent_previous_stale';
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/getSessionHealth')) {
        return Response.json({
          result: {
            data: {
              cloudAgentSessionId: previousSessionId,
              sandboxStatus: 'healthy',
              executionHealth: 'stale',
              activeExecutionId: 'exec-stale',
            },
          },
        });
      }
      if (url.includes('/trpc/prepareSession')) {
        return Response.json({
          result: {
            data: {
              cloudAgentSessionId: 'agent-fresh-stale',
              kiloSessionId: 'ses_fresh_stale',
            },
          },
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return Response.json({
          result: { data: { executionId: 'exec-fresh', status: 'running' } },
        });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          previousCloudAgentSessionId: previousSessionId,
        })
      );
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    const status = await stub.status();
    expect(status).toMatchObject({
      status: 'running',
      sessionId: 'agent-fresh-stale',
      cliSessionId: 'ses_fresh_stale',
    });
    expect(hasFetchCall(fetchMock, '/trpc/updateSession')).toBe(false);
    expect(hasFetchCall(fetchMock, '/trpc/sendMessageV2')).toBe(false);
    expect(hasFetchCall(fetchMock, '/trpc/prepareSession')).toBe(true);
  });

  it('skips continuation and prepares a fresh session when previous execution is active', async () => {
    const stub = getReviewStub();
    const previousSessionId = 'agent_previous_active';
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/getSessionHealth')) {
        return Response.json({
          result: {
            data: {
              cloudAgentSessionId: previousSessionId,
              sandboxStatus: 'healthy',
              executionHealth: 'healthy',
              activeExecutionId: 'exec-active',
              activeExecutionStatus: 'running',
            },
          },
        });
      }
      if (url.includes('/trpc/prepareSession')) {
        return Response.json({
          result: {
            data: {
              cloudAgentSessionId: 'agent-fresh-active',
              kiloSessionId: 'ses_fresh_active',
            },
          },
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return Response.json({
          result: { data: { executionId: 'exec-fresh', status: 'running' } },
        });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          previousCloudAgentSessionId: previousSessionId,
        })
      );
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    const status = await stub.status();
    expect(status).toMatchObject({
      status: 'running',
      sessionId: 'agent-fresh-active',
      cliSessionId: 'ses_fresh_active',
    });
    expect(hasFetchCall(fetchMock, '/trpc/updateSession')).toBe(false);
    expect(hasFetchCall(fetchMock, '/trpc/sendMessageV2')).toBe(false);
    expect(hasFetchCall(fetchMock, '/trpc/prepareSession')).toBe(true);
  });

  it('falls back to a fresh session when health preflight returns an error', async () => {
    const stub = getReviewStub();
    const previousSessionId = 'agent_previous_missing';
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/getSessionHealth')) {
        return new Response('Session not found', { status: 404 });
      }
      if (url.includes('/trpc/prepareSession')) {
        return Response.json({
          result: {
            data: {
              cloudAgentSessionId: 'agent-fresh-after-error',
              kiloSessionId: 'ses_fresh_after_error',
            },
          },
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return Response.json({
          result: { data: { executionId: 'exec-fresh', status: 'running' } },
        });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          previousCloudAgentSessionId: previousSessionId,
        })
      );
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    const status = await stub.status();
    expect(status).toMatchObject({
      status: 'running',
      sessionId: 'agent-fresh-after-error',
      cliSessionId: 'ses_fresh_after_error',
    });
    expect(hasFetchCall(fetchMock, '/trpc/getSessionHealth')).toBe(true);
    expect(hasFetchCall(fetchMock, '/trpc/updateSession')).toBe(false);
    expect(hasFetchCall(fetchMock, '/trpc/sendMessageV2')).toBe(false);
    expect(hasFetchCall(fetchMock, '/trpc/prepareSession')).toBe(true);
  });

  it('falls back to a fresh session when sendMessageV2 fails after healthy preflight', async () => {
    const stub = getReviewStub();
    const previousSessionId = 'agent_previous_send_failure';
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/getSessionHealth')) {
        return Response.json({
          result: {
            data: {
              cloudAgentSessionId: previousSessionId,
              sandboxStatus: 'healthy',
              executionHealth: 'none',
            },
          },
        });
      }
      if (url.includes('/trpc/updateSession')) {
        return Response.json({ result: { data: { success: true } } });
      }
      if (url.includes('/trpc/sendMessageV2')) {
        return new Response('Session not found', { status: 404 });
      }
      if (url.includes('/trpc/prepareSession')) {
        return Response.json({
          result: {
            data: {
              cloudAgentSessionId: 'agent-fresh-after-send-failure',
              kiloSessionId: 'ses_fresh_after_send_failure',
            },
          },
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return Response.json({
          result: { data: { executionId: 'exec-fresh', status: 'running' } },
        });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          previousCloudAgentSessionId: previousSessionId,
        })
      );
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    const status = await stub.status();
    expect(status).toMatchObject({
      status: 'running',
      sessionId: 'agent-fresh-after-send-failure',
      cliSessionId: 'ses_fresh_after_send_failure',
    });
    expect(hasFetchCall(fetchMock, '/trpc/getSessionHealth')).toBe(true);
    expect(hasFetchCall(fetchMock, '/trpc/updateSession')).toBe(true);
    expect(hasFetchCall(fetchMock, '/trpc/sendMessageV2')).toBe(true);
    expect(hasFetchCall(fetchMock, '/trpc/prepareSession')).toBe(true);

    const updateCall = getFetchCall(fetchMock, '/trpc/updateSession');
    const updateBody = JSON.parse(String(updateCall?.[1]?.body));
    expect(updateBody).toMatchObject({
      cloudAgentSessionId: previousSessionId,
      callbackTarget: {
        url: expect.stringContaining('/api/internal/code-review-status/'),
      },
    });
  });

  it('aborts alarm recovery before cloud-agent calls when DB is already terminal', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({
          success: true,
          message: 'Review already in terminal state',
          currentStatus: 'cancelled',
        });
      }
      return new Response('cloud-agent should not be called', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview());
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    const status = await stub.status();
    expect(status.status).toBe('cancelled');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('terminal cleanup alarm still deletes storage', async () => {
    const stub = getReviewStub();

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          status: 'completed',
          completedAt: new Date().toISOString(),
          events: [{ timestamp: new Date().toISOString(), eventType: 'test', message: 'stored' }],
        })
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    const stored = await runInDurableObject(
      stub,
      async (_instance: CodeReviewOrchestrator, state) => state.storage.get('state')
    );
    expect(stored).toBeUndefined();
  });
});
