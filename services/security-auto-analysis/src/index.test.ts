import {
  createSecurityAgentCommand,
  markSecurityAgentCommandQueueAdmissionFailed,
} from '@kilocode/db';
import { getWorkerDb } from '@kilocode/db/client';
import { deriveCallbackToken } from '@kilocode/worker-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RemediationModule from './remediation.js';
import { startManualRemediation } from './remediation.js';
import { dispatchDueOwners } from './dispatcher.js';
import worker from './index.js';

const loggerMock = vi.hoisted(() => {
  const logger = {
    withTags: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  logger.withTags.mockReturnValue(logger);
  return logger;
});

vi.mock('@kilocode/db', () => ({
  createSecurityAgentCommand: vi.fn(),
  markSecurityAgentCommandQueueAdmissionFailed: vi.fn(),
}));
vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn() }));
vi.mock('./dispatcher.js', () => ({ dispatchDueOwners: vi.fn() }));
vi.mock('./logger.js', () => ({
  logger: loggerMock,
  sanitizedExceptionName: (error: unknown) =>
    error instanceof Error ? error.name : 'UnknownError',
}));
vi.mock('./remediation.js', async importOriginal => ({
  ...(await importOriginal<typeof RemediationModule>()),
  startManualRemediation: vi.fn(),
}));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  loggerMock.withTags.mockReturnValue(loggerMock);
  vi.mocked(getWorkerDb).mockReturnValue({} as never);
  vi.mocked(dispatchDueOwners).mockResolvedValue({
    dispatchId: 'dispatch-123',
    discoveredOwners: 0,
    enqueuedMessages: 0,
    discoveredRemediationAttempts: 0,
    enqueuedRemediationMessages: 0,
  });
  vi.mocked(createSecurityAgentCommand).mockResolvedValue({
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  } as never);
});

const CALLBACK_SECRET = 'callback-token-secret';
const FINDING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_FINDING_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REMEDIATION_ATTEMPT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ATTEMPT_TOKEN = 'attempt-token-123';

function callbackRequest(headers: Record<string, string> = {}): Request {
  return new Request(
    `https://security-auto-analysis/internal/security-analysis-callback/${FINDING_ID}?attempt=${ATTEMPT_TOKEN}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        sessionId: 'session-123',
        cloudAgentSessionId: 'agent-123',
        executionId: 'exec-123',
        status: 'completed',
        lastAssistantMessageText: '# Completed',
      }),
    }
  );
}

async function callbackTokenFor(
  findingId = FINDING_ID,
  attemptToken = ATTEMPT_TOKEN
): Promise<string> {
  return deriveCallbackToken({
    secret: CALLBACK_SECRET,
    scope: 'security-analysis-callback',
    resourceParts: [findingId, attemptToken],
  });
}

async function remediationCallbackTokenFor(
  attemptId = REMEDIATION_ATTEMPT_ID,
  attemptToken = ATTEMPT_TOKEN
): Promise<string> {
  return deriveCallbackToken({
    secret: CALLBACK_SECRET,
    scope: 'security-remediation-callback',
    resourceParts: [attemptId, attemptToken],
  });
}

function scheduledEnv(heartbeatUrl: string | undefined): CloudflareEnv {
  return {
    BETTERSTACK_HEARTBEAT_URL: heartbeatUrl,
    ENVIRONMENT: 'test',
    CF_VERSION_METADATA: { id: 'version-123', tag: '', timestamp: '' },
  } as CloudflareEnv;
}

async function runScheduled(env: CloudflareEnv): Promise<{
  scheduledResult: Promise<void>;
  heartbeatPromise: Promise<unknown>;
}> {
  let heartbeatPromise: Promise<unknown> | undefined;
  const scheduledResult = worker.scheduled({} as ScheduledController, env, {
    waitUntil(promise) {
      heartbeatPromise = promise;
    },
  } as ExecutionContext);
  await scheduledResult.catch(() => undefined);
  if (!heartbeatPromise) throw new Error('Expected heartbeat waitUntil promise');
  return { scheduledResult, heartbeatPromise };
}

function manualRemediationRequest(): Request {
  return new Request('https://security-auto-analysis/internal/remediation/start', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-api-key': 'worker-secret',
    },
    body: JSON.stringify({
      schemaVersion: 1,
      findingId: FINDING_ID,
      owner: { userId: 'user-123' },
      actorUserId: 'user-123',
    }),
  });
}

describe('scheduled dispatcher heartbeat', () => {
  it('delivers successful dispatch heartbeats and logs attempted and successful outcomes', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    const { scheduledResult, heartbeatPromise } = await runScheduled(
      scheduledEnv('https://heartbeat.example/secret')
    );
    await expect(scheduledResult).resolves.toBeUndefined();
    await heartbeatPromise;

    expect(fetchMock).toHaveBeenCalledWith(
      'https://heartbeat.example/secret',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    const dispatchId = vi.mocked(dispatchDueOwners).mock.calls[0]?.[1];
    expect(dispatchId).toEqual(expect.any(String));
    expect(heartbeatTags()).toEqual(
      expect.arrayContaining([expect.objectContaining({ dispatch_id: dispatchId })])
    );
    expect(heartbeatOutcomes()).toEqual(['attempted', 'succeeded']);
    expect(JSON.stringify(loggerMock.withTags.mock.calls)).not.toContain('heartbeat.example');
  });

  it('selects /fail, rethrows dispatcher errors, and preserves them across heartbeat failure', async () => {
    const dispatcherError = new Error('original dispatcher failure');
    vi.mocked(dispatchDueOwners).mockRejectedValueOnce(dispatcherError);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('heartbeat-url credential network failure'));

    const { scheduledResult, heartbeatPromise } = await runScheduled(
      scheduledEnv('https://heartbeat.example/secret')
    );
    await expect(scheduledResult).rejects.toBe(dispatcherError);
    await expect(heartbeatPromise).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://heartbeat.example/secret/fail',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    const dispatchId = vi.mocked(dispatchDueOwners).mock.calls[0]?.[1];
    expect(dispatchId).toEqual(expect.any(String));
    expect(heartbeatTags()).toEqual(
      expect.arrayContaining([expect.objectContaining({ dispatch_id: dispatchId })])
    );
    expect(heartbeatOutcomes()).toEqual(['attempted', 'failed']);
    const failureTags = heartbeatTags().at(-1);
    expect(failureTags).toMatchObject({
      exception_name: 'Error',
      error_message: 'Heartbeat network failure',
      heartbeat_kind: 'failure',
    });
    expect(JSON.stringify(loggerMock.withTags.mock.calls)).not.toContain('credential');
  });

  it('logs skipped delivery when heartbeat binding is absent', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const { scheduledResult, heartbeatPromise } = await runScheduled(scheduledEnv(undefined));
    await expect(scheduledResult).resolves.toBeUndefined();
    await heartbeatPromise;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(heartbeatOutcomes()).toEqual(['skipped']);
  });

  it('treats non-2xx responses as delivery failures without failing dispatch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));

    const { scheduledResult, heartbeatPromise } = await runScheduled(
      scheduledEnv('https://heartbeat.example/secret')
    );
    await expect(scheduledResult).resolves.toBeUndefined();
    await heartbeatPromise;

    expect(heartbeatOutcomes()).toEqual(['attempted', 'failed']);
    expect(heartbeatTags().at(-1)).toMatchObject({
      response_status: 503,
      response_status_class: '5xx',
    });
  });

  it('logs heartbeat timeouts without failing dispatch', async () => {
    const timeout = new Error('heartbeat URL timed out');
    timeout.name = 'TimeoutError';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(timeout);

    const { scheduledResult, heartbeatPromise } = await runScheduled(
      scheduledEnv('https://heartbeat.example/secret')
    );
    await expect(scheduledResult).resolves.toBeUndefined();
    await heartbeatPromise;

    expect(heartbeatOutcomes()).toEqual(['attempted', 'timeout']);
    expect(heartbeatTags().at(-1)).toMatchObject({
      exception_name: 'TimeoutError',
      error_message: 'Heartbeat delivery timed out',
    });
    expect(JSON.stringify(loggerMock.withTags.mock.calls)).not.toContain('heartbeat URL');
  });
});

function heartbeatTags(): Array<Record<string, unknown>> {
  return loggerMock.withTags.mock.calls
    .map(([tags]) => tags)
    .filter(tags => tags.event_name === 'security_auto_analysis.heartbeat_delivery');
}

function heartbeatOutcomes(): unknown[] {
  return heartbeatTags().map(tags => tags.outcome);
}

describe('manual remediation ingress', () => {
  it('returns HTTP 409 with analysis_required for a policy rejection', async () => {
    vi.mocked(startManualRemediation).mockResolvedValue({
      admitted: false,
      reason: 'analysis_required',
    });

    const response = await worker.fetch(manualRemediationRequest(), {
      INTERNAL_API_SECRET: { get: async () => 'worker-secret' },
    } as CloudflareEnv);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      accepted: false,
      admitted: false,
      reason: 'analysis_required',
    });
  });

  it('returns HTTP 404 when the finding no longer exists', async () => {
    vi.mocked(startManualRemediation).mockResolvedValue({
      admitted: false,
      reason: 'finding_not_found',
    });

    const response = await worker.fetch(manualRemediationRequest(), {
      INTERNAL_API_SECRET: { get: async () => 'worker-secret' },
    } as CloudflareEnv);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      admitted: false,
      reason: 'finding_not_found',
    });
  });

  it('returns HTTP 202 with attempt correlation after accepted admission', async () => {
    vi.mocked(startManualRemediation).mockResolvedValue({
      admitted: true,
      remediationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      attemptId: REMEDIATION_ATTEMPT_ID,
      attemptNumber: 1,
    });

    const response = await worker.fetch(manualRemediationRequest(), {
      INTERNAL_API_SECRET: { get: async () => 'worker-secret' },
    } as CloudflareEnv);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      success: true,
      accepted: true,
      admitted: true,
      remediationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      attemptId: REMEDIATION_ATTEMPT_ID,
      attemptNumber: 1,
    });
  });
});

describe('security analysis callback ingress', () => {
  it('rejects callback traffic without a scoped callback token', async () => {
    const response = await worker.fetch(callbackRequest(), {
      CALLBACK_TOKEN_SECRET: { get: async () => CALLBACK_SECRET },
    } as CloudflareEnv);

    expect(response.status).toBe(401);
  });

  it('rejects callback traffic with the raw internal secret alone', async () => {
    const response = await worker.fetch(callbackRequest({ 'X-Internal-Secret': 'worker-secret' }), {
      CALLBACK_TOKEN_SECRET: { get: async () => CALLBACK_SECRET },
      INTERNAL_API_SECRET: { get: async () => 'worker-secret' },
    } as CloudflareEnv);

    expect(response.status).toBe(401);
  });

  it('rejects callback traffic with a callback token scoped to another finding', async () => {
    const response = await worker.fetch(
      callbackRequest({ 'X-Callback-Token': await callbackTokenFor(OTHER_FINDING_ID) }),
      { CALLBACK_TOKEN_SECRET: { get: async () => CALLBACK_SECRET } } as CloudflareEnv
    );

    expect(response.status).toBe(401);
  });

  it('rejects callbacks while Worker callback ingress routing is paused', async () => {
    const response = await worker.fetch(
      new Request(
        `https://security-auto-analysis/internal/security-analysis-callback/${FINDING_ID}`,
        { method: 'POST' }
      ),
      { SECURITY_ANALYSIS_CALLBACK_WORKER_INGRESS_ENABLED: 'false' } as CloudflareEnv
    );

    expect(response.status).toBe(503);
  });

  it('accepts authenticated callbacks by enqueuing durable Worker finalization', async () => {
    const queued: MessageSendRequest<unknown>[][] = [];
    const response = await worker.fetch(
      callbackRequest({ 'X-Callback-Token': await callbackTokenFor() }),
      {
        CALLBACK_TOKEN_SECRET: { get: async () => CALLBACK_SECRET },
        CALLBACK_QUEUE: {
          sendBatch: async batch => {
            queued.push(batch);
          },
        },
      } as CloudflareEnv
    );

    expect(response.status).toBe(202);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.[0]?.body).toMatchObject({
      findingId: FINDING_ID,
      attemptToken: ATTEMPT_TOKEN,
      payload: { status: 'completed' },
    });
  });

  it('accepts authenticated failed callbacks for durable Worker terminalization', async () => {
    const queued: MessageSendRequest<unknown>[][] = [];
    const request = new Request(
      `https://security-auto-analysis/internal/security-analysis-callback/${FINDING_ID}?attempt=${ATTEMPT_TOKEN}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Callback-Token': await callbackTokenFor(),
        },
        body: JSON.stringify({
          sessionId: 'session-123',
          cloudAgentSessionId: 'agent-123',
          executionId: 'exec-123',
          status: 'failed',
          errorMessage: 'sandbox failed',
        }),
      }
    );
    const response = await worker.fetch(request, {
      CALLBACK_TOKEN_SECRET: { get: async () => CALLBACK_SECRET },
      CALLBACK_QUEUE: {
        sendBatch: async batch => {
          queued.push(batch);
        },
      },
    } as CloudflareEnv);

    expect(response.status).toBe(202);
    expect(queued[0]?.[0]?.body).toMatchObject({
      findingId: FINDING_ID,
      attemptToken: ATTEMPT_TOKEN,
      payload: { status: 'failed', errorMessage: 'sandbox failed' },
    });
  });

  it('rejects manual analysis commands while Worker command routing is paused', async () => {
    const response = await worker.fetch(
      new Request('https://security-auto-analysis/internal/manual-analysis-start', {
        method: 'POST',
      }),
      { MANUAL_ANALYSIS_COMMAND_ROUTING_ENABLED: 'false' } as CloudflareEnv
    );

    expect(response.status).toBe(503);
  });

  it('compensates the accepted command when manual analysis queue admission fails', async () => {
    await expect(
      worker.fetch(
        new Request('https://security-auto-analysis/internal/manual-analysis-start', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-internal-api-key': 'worker-secret',
          },
          body: JSON.stringify({
            schemaVersion: 1,
            findingId: FINDING_ID,
            owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
            actorUserId: 'user-123',
          }),
        }),
        {
          INTERNAL_API_SECRET: { get: async () => 'worker-secret' },
          HYPERDRIVE: { connectionString: 'postgres://worker' },
          MANUAL_ANALYSIS_QUEUE: {
            sendBatch: async () => {
              throw new Error('queue unavailable');
            },
          },
        } as unknown as CloudflareEnv
      )
    ).rejects.toThrow('queue unavailable');
    expect(markSecurityAgentCommandQueueAdmissionFailed).toHaveBeenCalledWith(
      {},
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'Queue admission failed'
    );
  });

  it('accepts manual analysis commands by enqueuing Worker-owned orchestration', async () => {
    const queued: MessageSendRequest<unknown>[][] = [];
    const response = await worker.fetch(
      new Request('https://security-auto-analysis/internal/manual-analysis-start', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'worker-secret',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          findingId: FINDING_ID,
          owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
          actorUserId: 'user-123',
          requestedModels: { analysisModel: 'analysis/model' },
          retrySandboxOnly: true,
        }),
      }),
      {
        INTERNAL_API_SECRET: { get: async () => 'worker-secret' },
        HYPERDRIVE: { connectionString: 'postgres://worker' },
        MANUAL_ANALYSIS_QUEUE: {
          sendBatch: async batch => {
            queued.push(batch);
          },
        },
      } as CloudflareEnv
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      accepted: true,
      commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    });
    expect(queued[0]?.[0]?.body).toMatchObject({
      commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      findingId: FINDING_ID,
      actorUserId: 'user-123',
      retrySandboxOnly: true,
    });
  });

  it('accepts apply auto-remediation commands by enqueuing command orchestration', async () => {
    const queued: MessageSendRequest<unknown>[][] = [];
    const commandId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const response = await worker.fetch(
      new Request('https://security-auto-analysis/internal/apply-auto-remediation', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'worker-secret',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          commandId,
          owner: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
          actorUserId: 'user-123',
        }),
      }),
      {
        INTERNAL_API_SECRET: { get: async () => 'worker-secret' },
        REMEDIATION_COMMAND_QUEUE: {
          sendBatch: async batch => {
            queued.push(batch);
          },
        },
      } as CloudflareEnv
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      accepted: true,
      commandId,
    });
    expect(queued[0]?.[0]?.body).toMatchObject({
      commandId,
      actorUserId: 'user-123',
    });
  });

  it('accepts authenticated remediation callbacks by enqueuing durable finalization', async () => {
    const queued: MessageSendRequest<unknown>[][] = [];
    const response = await worker.fetch(
      new Request(
        `https://security-auto-analysis/internal/security-remediation-callback/${REMEDIATION_ATTEMPT_ID}?attempt=${ATTEMPT_TOKEN}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Callback-Token': await remediationCallbackTokenFor(),
          },
          body: JSON.stringify({
            sessionId: 'session-123',
            cloudAgentSessionId: 'agent-123',
            executionId: 'exec-123',
            status: 'completed',
            lastAssistantMessageText:
              '{"status":"pr_opened","prUrl":"https://github.com/kilo/repo/pull/1","summary":"Opened draft PR","validation":[]}',
          }),
        }
      ),
      {
        CALLBACK_TOKEN_SECRET: { get: async () => CALLBACK_SECRET },
        REMEDIATION_CALLBACK_QUEUE: {
          sendBatch: async batch => {
            queued.push(batch);
          },
        },
      } as CloudflareEnv
    );

    expect(response.status).toBe(202);
    expect(queued[0]?.[0]?.body).toMatchObject({
      attemptId: REMEDIATION_ATTEMPT_ID,
      attemptToken: ATTEMPT_TOKEN,
      payload: { status: 'completed' },
    });
  });
});
