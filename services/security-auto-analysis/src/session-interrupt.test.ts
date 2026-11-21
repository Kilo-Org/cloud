import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_CLEANUP_TIMEOUT_MS,
  SESSION_INTERRUPT_TIMEOUT_MS,
  interruptAnalysisCloudAgentSession,
} from './session-interrupt.js';

const AUTH_TOKEN = 'control-token';
const CLOUD_AGENT_SESSION_ID = 'agent-session-1';
const FINDING_ID = 'finding-1';
const INTERRUPT_URL = 'https://cloud-agent-next/trpc/interruptSession';

function createEnv(respond: (request: Request) => Promise<Response>) {
  const requests: Request[] = [];
  const fetch = vi.fn(async (request: Request) => {
    requests.push(request);
    return respond(request);
  });
  return { env: { CLOUD_AGENT_NEXT: { fetch } } as unknown as CloudflareEnv, requests };
}

function interruptParams(env: CloudflareEnv, timeoutMs?: number) {
  return {
    env,
    authToken: AUTH_TOKEN,
    cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
    findingId: FINDING_ID,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function singleRequest(requests: Request[]): Request {
  expect(requests).toHaveLength(1);
  const [request] = requests;
  if (request === undefined) throw new Error('Expected exactly one Cloud Agent request');
  return request;
}

// A peer that accepts the request and never answers: the promise only settles
// when the request's own deadline aborts the signal.
function answerOnlyOnAbort(request: Request, onAbort?: () => void): Promise<Response> {
  const { promise, reject } = Promise.withResolvers<Response>();
  request.signal.addEventListener(
    'abort',
    () => {
      onAbort?.();
      reject(request.signal.reason);
    },
    { once: true }
  );
  return promise;
}

describe('interruptAnalysisCloudAgentSession', () => {
  it('offers a shorter bound for a cleanup whose outcome is decided', () => {
    expect(SESSION_CLEANUP_TIMEOUT_MS).toBeLessThan(SESSION_INTERRUPT_TIMEOUT_MS);
  });

  it('ends the call when a peer that never answers hits the interrupt deadline', async () => {
    let aborted = false;
    const { env, requests } = createEnv(async request =>
      answerOnlyOnAbort(request, () => {
        aborted = true;
      })
    );

    const startedAt = Date.now();
    await expect(
      interruptAnalysisCloudAgentSession(interruptParams(env, 20))
    ).resolves.toBeUndefined();
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(2000);
    expect(aborted).toBe(true);
    expect(singleRequest(requests).signal.aborted).toBe(true);
  });

  it('sends a POST for the session with a bearer header and an abort signal', async () => {
    const { env, requests } = createEnv(async () => Response.json({ result: { data: {} } }));

    await expect(interruptAnalysisCloudAgentSession(interruptParams(env))).resolves.toBeUndefined();

    const request = singleRequest(requests);
    expect(request.method).toBe('POST');
    expect(request.url).toBe(INTERRUPT_URL);
    expect(request.headers.get('Authorization')).toBe(`Bearer ${AUTH_TOKEN}`);
    expect(await request.json()).toEqual({ sessionId: CLOUD_AGENT_SESSION_ID });
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not throw when the peer rejects the request', async () => {
    const { env, requests } = createEnv(async () => {
      throw new Error('network failure');
    });

    await expect(interruptAnalysisCloudAgentSession(interruptParams(env))).resolves.toBeUndefined();

    singleRequest(requests);
  });

  it('does not throw when the peer answers a non-OK status', async () => {
    const { env, requests } = createEnv(
      async () => new Response('interrupt unavailable', { status: 500 })
    );

    await expect(interruptAnalysisCloudAgentSession(interruptParams(env))).resolves.toBeUndefined();

    singleRequest(requests);
  });
});
