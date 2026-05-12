/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import type { CodeReviewOrchestrator } from '../../src/code-review-orchestrator';
import type { CodeReview, SessionInput } from '../../src/types';

const QUEUED_REVIEW_TIMEOUT_MS = 10 * 60 * 1000;
const RUNNING_REVIEW_TIMEOUT_MS = 90 * 60 * 1000;
const ALARM_RETRY_DELAY_MS = 5 * 60 * 1000;
const CLEANUP_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

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

async function storedAlarm(stub: DurableObjectStub<CodeReviewOrchestrator>) {
  return runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) =>
    state.storage.getAlarm()
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

  afterAll(() => {
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
    const startedBefore = Date.now();
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

    const alarm = await storedAlarm(stub);
    expect(alarm).toEqual(expect.any(Number));
    expect(alarm).toBeGreaterThanOrEqual(startedBefore + RUNNING_REVIEW_TIMEOUT_MS);
    expect(alarm).toBeLessThanOrEqual(Date.now() + RUNNING_REVIEW_TIMEOUT_MS);
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

    const failedStatusUpdates = fetchCalls(fetchMock, '/api/internal/code-review-status/').filter(
      call => {
        const init = call[1] as RequestInit | undefined;
        if (typeof init?.body !== 'string') return false;
        return (JSON.parse(init.body) as { status?: string }).status === 'failed';
      }
    );
    expect(failedStatusUpdates).toHaveLength(0);
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
    await expect(stub.status()).resolves.toMatchObject({
      status: 'failed',
      terminalReason: 'sandbox_error',
    });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(2);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    expect(lastStatusUpdateBody(fetchMock)).toMatchObject({
      status: 'failed',
      terminalReason: 'sandbox_error',
    });
    await expect(storedReview(stub)).resolves.toMatchObject({
      status: 'failed',
      sandboxRetryAttempted: true,
      terminalReason: 'sandbox_error',
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

  it('retries with a fresh session when sendMessageV2 fails with a sandbox 500', async () => {
    const stub = getReviewStub();
    const previousSessionId = 'agent_previous_sandbox_500';
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
        return trpcError(500, 'Container failed with internal server error status: 500');
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcSuccess({
          cloudAgentSessionId: 'agent-fresh-after-sandbox-500',
          kiloSessionId: 'ses_fresh_after_sandbox_500',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-fresh-sandbox', status: 'running' });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          previousCloudAgentSessionId: previousSessionId,
          sessionId: previousSessionId,
          cliSessionId: 'ses_previous',
        })
      );
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({
      status: 'running',
      sessionId: 'agent-fresh-after-sandbox-500',
      cliSessionId: 'ses_fresh_after_sandbox_500',
    });
    expect(fetchCalls(fetchMock, '/trpc/getSessionHealth')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/updateSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/sendMessageV2')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(1);

    const stored = await storedReview(stub);
    expect(stored).toMatchObject({
      sandboxRetryAttempted: true,
      sessionId: 'agent-fresh-after-sandbox-500',
      cliSessionId: 'ses_fresh_after_sandbox_500',
    });
    expect(stored?.previousCloudAgentSessionId).toBeUndefined();
  });

  it('fails with sandbox_error when sendMessageV2 retry also hits a sandbox 500', async () => {
    const stub = getReviewStub();
    const previousSessionId = 'agent_previous_sandbox_repeat';
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
        return trpcError(500, 'SandboxError: HTTP error! status: 500 during resume');
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcError(500, 'SandboxError: HTTP error! status: 500 during setup');
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
    await expect(stub.status()).resolves.toMatchObject({
      status: 'failed',
      terminalReason: 'sandbox_error',
    });
    expect(fetchCalls(fetchMock, '/trpc/sendMessageV2')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    expect(lastStatusUpdateBody(fetchMock)).toMatchObject({
      status: 'failed',
      terminalReason: 'sandbox_error',
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
    const alarm = await storedAlarm(stub);
    expect(alarm).toEqual(expect.any(Number));
    expect(alarm).toBeGreaterThan(Date.now());
  });

  it('recent running alarm syncs DB status and re-arms watchdog without failing', async () => {
    const stub = getReviewStub();
    const startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      return new Response('cloud-agent should not be called', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          status: 'running',
          startedAt,
          updatedAt: startedAt,
          sessionId: 'agent-running-session',
        })
      );
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({
      status: 'running',
      sessionId: 'agent-running-session',
    });
    expect(fetchCalls(fetchMock, '/api/internal/code-review-status/')).toHaveLength(1);
    expect(lastStatusUpdateBody(fetchMock)).toMatchObject({ status: 'running' });
    expect(hasFetchCall(fetchMock, '/trpc/prepareSession')).toBe(false);
    await expect(storedAlarm(stub)).resolves.toBe(
      Date.parse(startedAt) + RUNNING_REVIEW_TIMEOUT_MS
    );
  });

  it('running alarm syncs local terminal state when DB is already terminal', async () => {
    const stub = getReviewStub();
    const startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const cleanupStart = Date.now();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({
          success: true,
          message: 'Review already in terminal state',
          currentStatus: 'completed',
          terminalReason: 'timeout',
        });
      }
      return new Response('cloud-agent should not be called', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          status: 'running',
          startedAt,
          updatedAt: startedAt,
          events: [{ timestamp: startedAt, eventType: 'test', message: 'stored' }],
        })
      );
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    const stored = await storedReview(stub);
    expect(stored).toMatchObject({
      status: 'completed',
      terminalReason: 'timeout',
      events: [],
    });
    expect(stored?.completedAt).toEqual(expect.any(String));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const alarm = await storedAlarm(stub);
    expect(alarm).toEqual(expect.any(Number));
    expect(alarm).toBeGreaterThanOrEqual(cleanupStart + CLEANUP_DELAY_MS);
    expect(alarm).toBeLessThanOrEqual(Date.now() + CLEANUP_DELAY_MS);
  });

  it('stale running alarm marks review failed and schedules cleanup', async () => {
    const stub = getReviewStub();
    const startedAt = new Date(Date.now() - RUNNING_REVIEW_TIMEOUT_MS - 1_000).toISOString();
    const cleanupStart = Date.now();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      return new Response('cloud-agent should not be called', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          status: 'running',
          startedAt,
          updatedAt: startedAt,
          sessionId: 'agent-stale-session',
        })
      );
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({
      status: 'failed',
      errorMessage: 'Review timed out waiting for cloud agent callback',
      terminalReason: 'timeout',
    });
    expect(fetchCalls(fetchMock, '/api/internal/code-review-status/')).toHaveLength(2);
    expect(lastStatusUpdateBody(fetchMock)).toMatchObject({
      status: 'failed',
      terminalReason: 'timeout',
      errorMessage: 'Review timed out waiting for cloud agent callback',
    });
    expect(hasFetchCall(fetchMock, '/trpc/prepareSession')).toBe(false);
    const alarm = await storedAlarm(stub);
    expect(alarm).toEqual(expect.any(Number));
    expect(alarm).toBeGreaterThanOrEqual(cleanupStart + CLEANUP_DELAY_MS);
    expect(alarm).toBeLessThanOrEqual(Date.now() + CLEANUP_DELAY_MS);
  });

  it('stale queued alarm marks review failed without calling cloud-agent', async () => {
    const stub = getReviewStub();
    const queuedAt = new Date(Date.now() - QUEUED_REVIEW_TIMEOUT_MS - 1_000).toISOString();
    const cleanupStart = Date.now();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      return new Response('cloud-agent should not be called', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put('state', codeReview({ updatedAt: queuedAt }));
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(stub.status()).resolves.toMatchObject({
      status: 'failed',
      errorMessage: 'Review timed out waiting to start',
      terminalReason: 'timeout',
    });
    expect(fetchCalls(fetchMock, '/api/internal/code-review-status/')).toHaveLength(1);
    expect(lastStatusUpdateBody(fetchMock)).toMatchObject({
      status: 'failed',
      terminalReason: 'timeout',
      errorMessage: 'Review timed out waiting to start',
    });
    expect(hasFetchCall(fetchMock, '/trpc/prepareSession')).toBe(false);
    expect(hasFetchCall(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toBe(false);
    const alarm = await storedAlarm(stub);
    expect(alarm).toEqual(expect.any(Number));
    expect(alarm).toBeGreaterThanOrEqual(cleanupStart + CLEANUP_DELAY_MS);
    expect(alarm).toBeLessThanOrEqual(Date.now() + CLEANUP_DELAY_MS);
  });

  it('terminal cleanup deletes storage after DB terminal sync succeeds', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          status: 'completed',
          completedAt: new Date().toISOString(),
          sessionId: 'agent-terminal-session',
          cliSessionId: 'ses_terminal',
          terminalReason: 'timeout',
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
    await expect(storedAlarm(stub)).resolves.toBeNull();
    expect(fetchCalls(fetchMock, '/api/internal/code-review-status/')).toHaveLength(1);
    expect(lastStatusUpdateBody(fetchMock)).toMatchObject({
      status: 'completed',
      sessionId: 'agent-terminal-session',
      cliSessionId: 'ses_terminal',
      terminalReason: 'timeout',
    });
  });

  it('terminal cleanup retries instead of deleting when DB terminal sync fails transiently', async () => {
    const stub = getReviewStub();
    const retryStart = Date.now();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return new Response('temporary status failure', { status: 500 });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          status: 'failed',
          completedAt: new Date().toISOString(),
          errorMessage: 'temporary local failure',
          terminalReason: 'upstream_error',
        })
      );
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    await expect(storedReview(stub)).resolves.toMatchObject({
      status: 'failed',
      errorMessage: 'temporary local failure',
      terminalReason: 'upstream_error',
    });
    const alarm = await storedAlarm(stub);
    expect(alarm).toEqual(expect.any(Number));
    expect(alarm).toBeGreaterThanOrEqual(retryStart + ALARM_RETRY_DELAY_MS);
    expect(alarm).toBeLessThanOrEqual(Date.now() + ALARM_RETRY_DELAY_MS);
  });

  it('alarm handler failure leaves a future retry alarm', async () => {
    const stub = getReviewStub();
    const retryStart = Date.now();
    const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        if (body?.status === 'failed') {
          return new Response('temporary status failure', { status: 500 });
        }
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
    await expect(storedReview(stub)).resolves.toMatchObject({ status: 'failed' });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(lastStatusUpdateBody(fetchMock)).toMatchObject({ status: 'failed' });
    const alarm = await storedAlarm(stub);
    expect(alarm).toEqual(expect.any(Number));
    expect(alarm).toBeGreaterThanOrEqual(retryStart + ALARM_RETRY_DELAY_MS);
    expect(alarm).toBeLessThanOrEqual(Date.now() + ALARM_RETRY_DELAY_MS);
  });
});
