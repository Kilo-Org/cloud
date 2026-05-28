/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CodeReviewOrchestrator } from '../../src/code-review-orchestrator';
import type { CodeReview, SessionInput } from '../../src/types';
import { deriveCallbackToken } from '@kilocode/worker-utils';

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

function trpcError(
  status: number,
  message: string,
  code = 'INTERNAL_SERVER_ERROR',
  data: Record<string, unknown> = {}
): Response {
  return Response.json(
    {
      error: {
        message,
        code: -32603,
        data: {
          code,
          httpStatus: status,
          path: 'prepareSession',
          ...data,
        },
      },
    },
    { status }
  );
}

function mockSuccessfulCloudAgentNextRun() {
  const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
    const url = String(request);
    if (url.includes('/api/internal/code-review-status/')) {
      return Response.json({ success: true });
    }
    if (url.includes('/trpc/prepareSession')) {
      return trpcSuccess({ cloudAgentSessionId: 'agent-fresh', kiloSessionId: 'ses_fresh' });
    }
    if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
      return trpcSuccess({ executionId: 'exec-fresh', status: 'running' });
    }

    return new Response('unexpected fetch', { status: 500 });
  });
  globalThis.fetch = fetchMock;
  return fetchMock;
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
      status: expect.stringMatching(/queued|running/),
    });
  });

  it('POST /review uses attempt-specific durable object names', async () => {
    const fetchMock = mockSuccessfulCloudAgentNextRun();
    const reviewId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();

    const response = await SELF.fetch('https://worker.test/review', {
      method: 'POST',
      headers: { ...workerAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reviewId,
        attemptId,
        authToken: 'test-auth-token',
        sessionInput: sessionInput(),
        owner: { type: 'user', id: 'user-id', userId: 'user-id' },
        agentVersion: 'v2',
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ reviewId, attemptId, status: 'queued' });

    const statusResponse = await SELF.fetch(
      `https://worker.test/reviews/${reviewId}/status?attemptId=${attemptId}`,
      { headers: workerAuthHeaders() }
    );
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      reviewId,
      attemptId,
      status: expect.stringMatching(/queued|running/),
    });

    const prepareCall = getFetchCall(fetchMock, '/trpc/prepareSession');
    const prepareBody = JSON.parse(String(prepareCall?.[1]?.body));
    const expectedCallbackToken = await deriveCallbackToken({
      secret: env.CALLBACK_TOKEN_SECRET,
      scope: 'code-review-status-callback',
      resourceParts: [reviewId, attemptId],
    });
    const statusUpdateCall = getFetchCall(fetchMock, '/api/internal/code-review-status/');
    const statusUpdateInit = statusUpdateCall?.[1] as RequestInit | undefined;
    expect(statusUpdateInit?.headers).toMatchObject({ 'X-Callback-Token': expectedCallbackToken });
    expect(statusUpdateInit?.headers).not.toHaveProperty('X-Internal-Secret');
    expect(prepareBody.callbackTarget).toMatchObject({
      url: expect.stringContaining(`attemptId=${attemptId}`),
      headers: { 'X-Callback-Token': expectedCallbackToken },
    });
    expect(prepareBody.callbackTarget.headers).not.toHaveProperty('X-Internal-Secret');
  });

  it('fresh attempt dispatch does not reuse failed state from an earlier attempt', async () => {
    mockSuccessfulCloudAgentNextRun();
    const reviewId = crypto.randomUUID();
    const attemptA = crypto.randomUUID();
    const attemptB = crypto.randomUUID();

    const failedStub = getReviewStub(`${reviewId}:${attemptA}`);
    await runInDurableObject(failedStub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          reviewId,
          attemptId: attemptA,
          status: 'failed',
          errorMessage: 'old failure',
        })
      );
    });

    const response = await SELF.fetch('https://worker.test/review', {
      method: 'POST',
      headers: { ...workerAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reviewId,
        attemptId: attemptB,
        authToken: 'test-auth-token',
        sessionInput: sessionInput(),
        owner: { type: 'user', id: 'user-id', userId: 'user-id' },
        agentVersion: 'v2',
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      reviewId,
      attemptId: attemptB,
      status: expect.stringMatching(/queued|running/),
    });

    const failedStatus = await failedStub.status();
    expect(failedStatus).toMatchObject({ reviewId, attemptId: attemptA, status: 'failed' });
    const freshStatusResponse = await SELF.fetch(
      `https://worker.test/reviews/${reviewId}/status?attemptId=${attemptB}`,
      { headers: workerAuthHeaders() }
    );
    await expect(freshStatusResponse.json()).resolves.toMatchObject({
      reviewId,
      attemptId: attemptB,
      status: expect.stringMatching(/queued|running/),
    });
  });

  it('retry-fresh route requires auth', async () => {
    const response = await SELF.fetch(
      `https://worker.test/reviews/${crypto.randomUUID()}/retry-fresh`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'test' }),
      }
    );

    expect(response.status).toBe(401);
  });

  it('retry-fresh starts a fresh session without continuation APIs', async () => {
    const reviewId = crypto.randomUUID();
    const stub = getReviewStub(reviewId);
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcSuccess({
          cloudAgentSessionId: 'agent-retry-fresh',
          kiloSessionId: 'ses_retry_fresh',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-retry-fresh', status: 'running' });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          reviewId,
          status: 'running',
          sessionId: 'agent-old',
          cliSessionId: 'ses_old',
          sandboxId: 'sandbox-old',
          previousCloudAgentSessionId: 'agent-previous',
          errorMessage: 'Container shutdown: SIGTERM',
          terminalReason: 'sandbox_error',
        })
      );
    });

    const response = await SELF.fetch(`https://worker.test/reviews/${reviewId}/retry-fresh`, {
      method: 'POST',
      headers: { ...workerAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'agent-old', reason: 'Container shutdown: SIGTERM' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: false, reviewId });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(0);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    expect(fetchCalls(fetchMock, '/trpc/getSessionHealth')).toHaveLength(0);
    expect(fetchCalls(fetchMock, '/trpc/updateSession')).toHaveLength(0);
    expect(fetchCalls(fetchMock, '/trpc/sendMessageV2')).toHaveLength(0);
  });

  it('retry-fresh starts a new retry attempt durable object instead of resetting the failed attempt', async () => {
    const reviewId = crypto.randomUUID();
    const failedAttemptId = crypto.randomUUID();
    const retryAttemptId = crypto.randomUUID();
    const failedStub = getReviewStub(`${reviewId}:${failedAttemptId}`);
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcSuccess({
          cloudAgentSessionId: 'agent-retry-fresh',
          kiloSessionId: 'ses_retry_fresh',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-retry-fresh', status: 'running' });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;

    await runInDurableObject(failedStub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          reviewId,
          attemptId: failedAttemptId,
          status: 'running',
          sessionId: 'agent-old',
          cliSessionId: 'ses_old',
          errorMessage: 'Container shutdown: SIGTERM',
          terminalReason: 'sandbox_error',
        })
      );
    });

    const response = await SELF.fetch(`https://worker.test/reviews/${reviewId}/retry-fresh`, {
      method: 'POST',
      headers: { ...workerAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'agent-old',
        reason: 'Container shutdown: SIGTERM',
        failedAttemptId,
        retryAttemptId,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, reviewId });

    const oldStatus = await failedStub.status();
    expect(oldStatus).toMatchObject({ reviewId, attemptId: failedAttemptId, status: 'running' });

    const retryStub = getReviewStub(`${reviewId}:${retryAttemptId}`);
    await expect(retryStub.status()).resolves.toMatchObject({
      reviewId,
      attemptId: retryAttemptId,
      status: 'running',
    });
  });

  it('retry-fresh ignores mismatched sessions', async () => {
    const reviewId = crypto.randomUUID();
    const stub = getReviewStub(reviewId);

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          reviewId,
          status: 'running',
          sessionId: 'agent-current',
        })
      );
    });

    const response = await SELF.fetch(`https://worker.test/reviews/${reviewId}/retry-fresh`, {
      method: 'POST',
      headers: { ...workerAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'agent-old', reason: 'Container shutdown: SIGTERM' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: false, reviewId });
    await expect(storedReview(stub)).resolves.toMatchObject({
      status: 'running',
      sessionId: 'agent-current',
    });
  });

  it('retry-fresh ignores exhausted retries', async () => {
    const reviewId = crypto.randomUUID();
    const stub = getReviewStub(reviewId);

    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({
          reviewId,
          status: 'running',
          sessionId: 'agent-current',
          sandboxRetryAttempted: true,
        })
      );
    });

    const response = await SELF.fetch(`https://worker.test/reviews/${reviewId}/retry-fresh`, {
      method: 'POST',
      headers: { ...workerAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'agent-current', reason: 'Container shutdown: SIGTERM' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: false, reviewId });
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

    await expect(storedReview(stub)).resolves.toMatchObject({
      sandboxRetryAttempted: true,
      status: 'running',
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

  it('retries prepareSession from a structured workspace mkdir retry marker', async () => {
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
          return trpcError(
            500,
            'Failed to create workspace directory: FileSystemError: mkdir operation failed with exit code NaN',
            'INTERNAL_SERVER_ERROR',
            { error: 'sandbox_internal_server_error', retryable: true }
          );
        }
        return trpcSuccess({
          cloudAgentSessionId: 'agent-workspace-retry',
          kiloSessionId: 'ses_workspace_retry',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-workspace-retry', status: 'running' });
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
      sessionId: 'agent-workspace-retry',
      cliSessionId: 'ses_workspace_retry',
    });

    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(2);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(1);

    await expect(storedReview(stub)).resolves.toMatchObject({
      sandboxRetryAttempted: true,
      status: 'running',
      sessionId: 'agent-workspace-retry',
      cliSessionId: 'ses_workspace_retry',
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

  it('does not retry workspace mkdir prose without a structured retry marker', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcError(
          500,
          'Failed to create workspace directory: FileSystemError: mkdir operation failed with exit code NaN'
        );
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
    });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(1);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(0);
    await expect(storedReview(stub)).resolves.toMatchObject({
      status: 'failed',
    });
    const stored = await storedReview(stub);
    expect(stored?.sandboxRetryAttempted).toBeUndefined();
  });

  it('retries prepareSession once after wrapper waitForPort readiness timeout', async () => {
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
          return trpcError(
            500,
            'Wrapper did not become ready on port 5353 within 30000ms: waitForPort timed out'
          );
        }
        return trpcSuccess({
          cloudAgentSessionId: 'agent-wrapper-timeout-retry',
          kiloSessionId: 'ses_wrapper_timeout_retry',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-wrapper-timeout-retry', status: 'running' });
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
      status: 'running',
      sessionId: 'agent-wrapper-timeout-retry',
      cliSessionId: 'ses_wrapper_timeout_retry',
    });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(2);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(1);
    await expect(storedReview(stub)).resolves.toMatchObject({ sandboxRetryAttempted: true });
  });

  it('retries prepareSession once after wrapper kilo server startup timeout', async () => {
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
          return trpcError(
            500,
            'Wrapper did not become ready on port 5353 within 30000ms: waitForPort timed out | wrapperFileLog: failed to start kilo server: Timeout waiting for server to start after 45000ms'
          );
        }
        return trpcSuccess({
          cloudAgentSessionId: 'agent-kilo-startup-retry',
          kiloSessionId: 'ses_kilo_startup_retry',
        });
      }
      if (url.includes('/trpc/initiateFromKilocodeSessionV2')) {
        return trpcSuccess({ executionId: 'exec-kilo-startup-retry', status: 'running' });
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
      status: 'running',
      sessionId: 'agent-kilo-startup-retry',
      cliSessionId: 'ses_kilo_startup_retry',
    });
    expect(fetchCalls(fetchMock, '/trpc/prepareSession')).toHaveLength(2);
    expect(fetchCalls(fetchMock, '/trpc/initiateFromKilocodeSessionV2')).toHaveLength(1);
    await expect(storedReview(stub)).resolves.toMatchObject({ sandboxRetryAttempted: true });
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

  it('does not retry configured-session lookup failures nested in wrapper readiness output', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcError(
          500,
          'Wrapper did not become ready on port 5353 within 30000ms: waitForPort timed out | wrapperFileLog: configured session ses_missing not found: Session get returned no data for ses_missing'
        );
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

  it('does not retry repo-specific checkout failures that surface as prepareSession 500s', async () => {
    const stub = getReviewStub();
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/')) {
        return Response.json({ success: true });
      }
      if (url.includes('/trpc/prepareSession')) {
        return trpcError(
          500,
          'SandboxError: HTTP error! status: 500 during setup | Failed to checkout pull ref: Object does not exist on the server'
        );
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

  it('continues a session when abandoned legacy execution rows are omitted from current health', async () => {
    const stub = getReviewStub();
    const previousSessionId = 'agent_previous_stranded_legacy';
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes('/api/internal/code-review-status/'))
        return Response.json({ success: true });
      if (url.includes('/trpc/getSessionHealth')) {
        return trpcSuccess({
          cloudAgentSessionId: previousSessionId,
          sandboxStatus: 'healthy',
          executionHealth: 'none',
        });
      }
      if (url.includes('/trpc/updateSession')) return trpcSuccess({ success: true });
      if (url.includes('/trpc/sendMessageV2')) {
        return trpcSuccess({
          executionId: 'msg_followup',
          status: 'started',
          messageId: 'msg_followup',
          delivery: 'queued',
        });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    globalThis.fetch = fetchMock;
    await runInDurableObject(stub, async (_instance: CodeReviewOrchestrator, state) => {
      await state.storage.put(
        'state',
        codeReview({ previousCloudAgentSessionId: previousSessionId })
      );
      await state.storage.setAlarm(Date.now() + 30_000);
    });

    await runDurableObjectAlarm(stub);

    expect(hasFetchCall(fetchMock, '/trpc/sendMessageV2')).toBe(true);
    expect(hasFetchCall(fetchMock, '/trpc/prepareSession')).toBe(false);
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
        headers: { 'X-Callback-Token': expect.stringMatching(/^[0-9a-f]{64}$/) },
      },
    });
    expect(updateBody.callbackTarget.headers).not.toHaveProperty('X-Internal-Secret');
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
      status: 'running',
      sessionId: 'agent-fresh-after-sandbox-500',
      cliSessionId: 'ses_fresh_after_sandbox_500',
    });
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
