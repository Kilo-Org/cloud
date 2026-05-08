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
  return { Authorization: `Bearer ${env.BACKEND_AUTH_TOKEN}` };
}

function trpcSuccess(data: unknown): Response {
  return Response.json({ result: { data } });
}

function trpcError(status: number, message: string, code = 'INTERNAL_SERVER_ERROR'): Response {
  return Response.json(
    {
      error: {
        message,
        code: -32603,
        data: {
          code,
          httpStatus: status,
          path: 'prepareSession',
        },
      },
    },
    { status }
  );
}

function fetchCalls(fetchMock: ReturnType<typeof vi.fn>, path: string) {
  return fetchMock.mock.calls.filter(([request]) => String(request).includes(path));
}

function hasFetchCall(fetchMock: ReturnType<typeof vi.fn>, path: string): boolean {
  return fetchCalls(fetchMock, path).length > 0;
}

function getFetchCall(fetchMock: ReturnType<typeof vi.fn>, path: string) {
  return fetchCalls(fetchMock, path).at(0);
}

function lastStatusUpdateBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const statusCalls = fetchCalls(fetchMock, '/api/internal/code-review-status/');
  const lastCall = statusCalls.at(-1);
  expect(lastCall).toBeDefined();

  const init = lastCall?.[1] as RequestInit | undefined;
  expect(init?.body).toEqual(expect.any(String));
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

async function storedReview(stub: DurableObjectStub<CodeReviewOrchestrator>) {
  return runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) =>
    state.storage.get<CodeReview>('state')
  );
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
        return trpcSuccess({
          cloudAgentSessionId: 'agent-test-session',
          kiloSessionId: 'ses_test_session',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-test', status: 'running' });
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
    expect(hasFetchCall(fetchMock, '/trpc/prepareSession')).toBe(true);
    expect(hasFetchCall(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toBe(true);
  });

  it('retries prepareSession once after a sandbox 500 and initiates the retry session', async () => {
    const stub = getReviewStub();
    let prepareCalls = 0;
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        prepareCalls += 1;
        if (prepareCalls === 1) {
          return trpcError(500, 'SandboxError: HTTP error! status: 500 during setup');
        }
        return trpcSuccess({
          cloudAgentSessionId: 'agent-retry-session',
          kiloSessionId: 'ses_retry_session',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-retry', status: 'running' });
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
      sessionId: 'agent-retry-session',
      cliSessionId: 'ses_retry_session',
    });

    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(2);
    const initiateCalls = fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2');
    expect(initiateCalls).toHaveLength(1);
    const initiateInit = initiateCalls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(initiateInit?.body))).toEqual({
      cloudAgentSessionId: 'agent-retry-session',
    });

    await expect(storedReview(stub)).resolves.toMatchObject({
      sandboxRetryAttempted: true,
      sessionId: 'agent-retry-session',
      cliSessionId: 'ses_retry_session',
    });
  });

  it('fails after a second sandbox 500 without initiating', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcError(500, 'SandboxError: HTTP error! status: 500 during setup');
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
    await expect(stub.status()).resolves.toMatchObject({ status: 'failed' });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(2);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    await expect(storedReview(stub)).resolves.toMatchObject({
      status: 'failed',
      sandboxRetryAttempted: true,
    });
  });

  it('does not retry billing failures from prepareSession', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcError(402, 'Insufficient credits: $1 minimum required', 'PAYMENT_REQUIRED');
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
    await expect(stub.status()).resolves.toMatchObject({ status: 'failed' });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    expect(lastStatusUpdateBody(fetchMock)).toMatchObject({
      status: 'failed',
      terminalReason: 'billing',
    });
    await expect(storedReview(stub)).resolves.toMatchObject({
      status: 'failed',
      terminalReason: 'billing',
    });
  });

  it('does not retry deterministic prepareSession 400 failures', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcError(400, 'Branch not found: main', 'BAD_REQUEST');
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
    await expect(stub.status()).resolves.toMatchObject({ status: 'failed' });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    const stored = await storedReview(stub);
    expect(stored).toMatchObject({ status: 'failed' });
    expect(stored?.sandboxRetryAttempted).toBeUndefined();
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
        return trpcSuccess({
          cloudAgentSessionId: previousSessionId,
          sandboxId: 'ses-healthy',
          sandboxStatus: 'healthy',
          executionHealth: 'none',
        });
      }
      if (url.includes('/trpc/updateSession')) {
        return trpcSuccess({ success: true });
      }
      if (url.includes('/trpc/sendMessageV2')) {
        return trpcSuccess({ executionId: 'exec-followup', status: 'running' });
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
        return trpcSuccess({
          cloudAgentSessionId: previousSessionId,
          sandboxStatus: 'unreachable',
          executionHealth: 'none',
        });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcSuccess({
          cloudAgentSessionId: 'agent-fresh-session',
          kiloSessionId: 'ses_fresh_session',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-fresh', status: 'running' });
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
        return trpcSuccess({
          cloudAgentSessionId: previousSessionId,
          sandboxStatus: 'healthy',
          executionHealth: 'stale',
          activeExecutionId: 'exec-stale',
        });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcSuccess({
          cloudAgentSessionId: 'agent-fresh-stale',
          kiloSessionId: 'ses_fresh_stale',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-fresh', status: 'running' });
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
        return trpcSuccess({
          cloudAgentSessionId: previousSessionId,
          sandboxStatus: 'healthy',
          executionHealth: 'healthy',
          activeExecutionId: 'exec-active',
          activeExecutionStatus: 'running',
        });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcSuccess({
          cloudAgentSessionId: 'agent-fresh-active',
          kiloSessionId: 'ses_fresh_active',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-fresh', status: 'running' });
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
        return trpcSuccess({
          cloudAgentSessionId: 'agent-fresh-after-error',
          kiloSessionId: 'ses_fresh_after_error',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-fresh', status: 'running' });
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
        return trpcSuccess({
          cloudAgentSessionId: previousSessionId,
          sandboxStatus: 'healthy',
          executionHealth: 'none',
        });
      }
      if (url.includes('/trpc/updateSession')) {
        return trpcSuccess({ success: true });
      }
      if (url.includes('/trpc/sendMessageV2')) {
        return new Response('Session not found', { status: 404 });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcSuccess({
          cloudAgentSessionId: 'agent-fresh-after-send-failure',
          kiloSessionId: 'ses_fresh_after_send_failure',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-fresh', status: 'running' });
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
