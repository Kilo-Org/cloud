import { deriveCallbackToken } from '@kilocode/worker-utils';
import { describe, expect, it } from 'vitest';
import worker from './index.js';

const CALLBACK_SECRET = 'callback-token-secret';
const FINDING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_FINDING_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
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
        MANUAL_ANALYSIS_QUEUE: {
          sendBatch: async batch => {
            queued.push(batch);
          },
        },
      } as CloudflareEnv
    );

    expect(response.status).toBe(202);
    expect(queued[0]?.[0]?.body).toMatchObject({
      findingId: FINDING_ID,
      actorUserId: 'user-123',
      retrySandboxOnly: true,
    });
  });
});
