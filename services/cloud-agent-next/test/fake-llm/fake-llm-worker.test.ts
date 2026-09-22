/**
 * Worker-runtime tests for the deployed fake LLM.
 *
 * These exercise the real Worker entry and the `FakeLlmState` Durable Object in
 * Miniflare: the `/test/*` admin guard, the model-route bearer boundary, stream
 * readiness, the bodyless 204 gate release, the stream shape not being a batch,
 * and the persist/hydrate cycle across an eviction.
 *
 * The Node-runtime semantics (directives, SSE payloads, counters, gates) are
 * covered by `test/unit/fake-llm-server.test.ts`; this file covers what only
 * exists in the Worker adapter.
 *
 * Every response body is consumed: an unread body keeps the Durable Object
 * request in flight, which blocks `evictDurableObject`.
 *
 * Run with `pnpm run test:fake-llm`.
 */

import { createHmac } from 'node:crypto';
import { env, evictDurableObject, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { FAKE_LLM_STATE_STORAGE_KEY, scenarioRegistry } from '../e2e/fake-llm-core.js';
import { createWorkerEmit } from '../e2e/fake-llm-worker.js';

type FakeLlmTestEnv = {
  FAKE_LLM: DurableObjectNamespace;
  NEXTAUTH_SECRET?: string;
  FAKE_LLM_ADMIN_TOKEN?: string;
};

const testEnv = env as unknown as FakeLlmTestEnv;
const ORIGIN = 'http://fake.test';
const DO_NAME = 'fake-llm';

function requireBinding(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Miniflare test binding ${name} is missing`);
  return value;
}

const ADMIN_TOKEN = () => requireBinding(testEnv.FAKE_LLM_ADMIN_TOKEN, 'FAKE_LLM_ADMIN_TOKEN');
const NEXTAUTH_SECRET = () => requireBinding(testEnv.NEXTAUTH_SECRET, 'NEXTAUTH_SECRET');

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN()}`, ...extra };
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64url(value: string): string {
  return bytesToBase64url(new TextEncoder().encode(value));
}

/** Base64url HMAC-SHA256 without relying on Buffer's `base64url` encoding name. */
function hmacBase64url(secret: string, value: string): string {
  return bytesToBase64url(new Uint8Array(createHmac('sha256', secret).update(value).digest()));
}

/** Hand-sign a JWT so the test can carry claims `signKiloToken` cannot produce. */
function signToken(overrides: Record<string, unknown> = {}, secret = NEXTAUTH_SECRET()): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    version: 3,
    kiloUserId: 'user_1',
    apiTokenPepper: 'pepper',
    iat: now,
    exp: now + 600,
    ...overrides,
  };
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  return `${header}.${body}.${hmacBase64url(secret, `${header}.${body}`)}`;
}

async function chat(prompt: string, token = signToken()): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/openrouter/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model: 'kilo/fake-deterministic',
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    }),
  });
}

async function transcription(token = signToken()): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/openrouter/audio/transcriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model: 'fake-transcribe',
      input_audio: { data: 'aGVsbG8=', format: 'wav' },
    }),
  });
}

async function requestCounts(): Promise<{ chatCompletions: number; transcriptions: number }> {
  const res = await SELF.fetch(`${ORIGIN}/test/requests`, { headers: adminHeaders() });
  expect(res.status).toBe(200);
  return (await res.json()) as { chatCompletions: number; transcriptions: number };
}

/** Consume a body so no Durable Object request stays in flight. */
async function drain(res: Response): Promise<number> {
  await res.text();
  return res.status;
}

type SseRead = {
  events: string[];
  chunkCount: number;
  firstChunkHasDone: boolean;
  firstChunkAtMs: number;
  elapsedMs: number;
};

async function readSse(body: ReadableStream<Uint8Array>): Promise<SseRead> {
  const startedAt = Date.now();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let chunkCount = 0;
  let firstChunkHasDone = false;
  let firstChunkAtMs = -1;
  const events: string[] = [];

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunkCount += 1;
    if (firstChunkAtMs < 0) firstChunkAtMs = Date.now() - startedAt;
    const text = decoder.decode(value, { stream: true });
    if (chunkCount === 1) firstChunkHasDone = text.includes('[DONE]');
    buffer += text;
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      events.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf('\n\n');
    }
  }

  return {
    events,
    chunkCount,
    firstChunkHasDone,
    firstChunkAtMs,
    elapsedMs: Date.now() - startedAt,
  };
}

async function waitForTag(tag: string, expected: boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await SELF.fetch(`${ORIGIN}/test/gate-status?tag=${tag}`, {
      headers: adminHeaders(),
    });
    if (res.status === 200) {
      const body = (await res.json()) as { engaged?: boolean };
      if (body.engaged === expected) return;
    } else {
      await res.text();
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`tag ${tag} never reached engaged=${expected}`);
}

async function waitForPersistedTranscriptions(expected: number): Promise<void> {
  const stub = testEnv.FAKE_LLM.get(testEnv.FAKE_LLM.idFromName(DO_NAME));
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const persisted = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<Record<string, unknown>>(FAKE_LLM_STATE_STORAGE_KEY)
    );
    if (persisted?.transcriptionRequests === expected) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`state never persisted transcriptionRequests=${expected}`);
}

async function waitForWaiterCount(tag: string, expected: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await SELF.fetch(`${ORIGIN}/test/waiters`, { headers: adminHeaders() });
    const body = (await res.json()) as { tags: Array<{ tag: string; count: number }> };
    if ((body.tags.find(entry => entry.tag === tag)?.count ?? 0) === expected) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`tag ${tag} never reached waiter count ${expected}`);
}

/** Global open-stream count from `/test/waiters` (gate waiters plus `hang`). */
async function liveResponses(): Promise<number> {
  const res = await SELF.fetch(`${ORIGIN}/test/waiters`, { headers: adminHeaders() });
  const body = (await res.json()) as { liveResponses: number };
  return body.liveResponses;
}

async function waitForLiveResponses(expected: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await liveResponses()) === expected) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`liveResponses never drained to ${expected}`);
}

const CONTROL_ROUTES: Array<{ label: string; path: string; init?: RequestInit }> = [
  { label: 'POST /test/release', path: '/test/release?tag=worker-guard', init: { method: 'POST' } },
  { label: 'GET /test/gate-status', path: '/test/gate-status?tag=worker-guard' },
  { label: 'GET /test/waiters', path: '/test/waiters' },
  { label: 'GET /test/requests', path: '/test/requests' },
  { label: 'GET /test/scenario-status', path: '/test/scenario-status?tag=worker-guard' },
];

/**
 * Every model route the Worker admits. The Worker entry owns the bearer
 * boundary, so each must reject a missing or admin bearer and accept a valid
 * model token — including the two routes the example body must actually reach
 * (`/api/organizations/<id>/models/validate` and audio transcriptions).
 */
const MODEL_ROUTES: Array<{
  label: string;
  path: string;
  init?: { method: string; body: string };
}> = [
  { label: 'GET /api/openrouter/models', path: '/api/openrouter/models' },
  {
    label: 'POST /api/openrouter/models/validate',
    path: '/api/openrouter/models/validate',
    init: { method: 'POST', body: JSON.stringify({ modelId: 'fake-deterministic' }) },
  },
  {
    label: 'POST /api/organizations/org_1/models/validate',
    path: '/api/organizations/org_1/models/validate',
    init: { method: 'POST', body: JSON.stringify({ modelId: 'fake-deterministic' }) },
  },
  {
    label: 'POST /api/openrouter/chat/completions',
    path: '/api/openrouter/chat/completions',
    init: {
      method: 'POST',
      body: JSON.stringify({
        model: 'kilo/fake-deterministic',
        messages: [{ role: 'user', content: '__fake__:echo:route-table' }],
        stream: true,
      }),
    },
  },
  {
    label: 'POST /api/openrouter/audio/transcriptions',
    path: '/api/openrouter/audio/transcriptions',
    init: {
      method: 'POST',
      body: JSON.stringify({
        model: 'fake-transcribe',
        input_audio: { data: 'aGVsbG8=', format: 'wav' },
      }),
    },
  },
];

describe('deployed fake llm worker', () => {
  it('answers the public health route without a credential', async () => {
    const res = await SELF.fetch(`${ORIGIN}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok', service: 'fake-llm' });
  });

  it('guards /test/* with the DO counters behind the admin bearer', async () => {
    const before = await requestCounts();

    const unauthenticated = await SELF.fetch(`${ORIGIN}/test/requests`);
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toEqual({
      error: 'admin authorization required',
    });

    await chat('__fake__:echo:deployed').then(response =>
      readSse(response.body as ReadableStream<Uint8Array>)
    );

    const after = await requestCounts();
    expect(after.chatCompletions).toBe(before.chatCompletions + 1);
  });

  it('releases a parked gate with a bodyless 204 and completes the stream', async () => {
    const baseline = await liveResponses();
    const tag = `deployed-${Date.now()}`;
    const pending = chat(`__fake__:gate:${tag}`);
    await waitForTag(tag, true);

    const waiters = await SELF.fetch(`${ORIGIN}/test/waiters`, { headers: adminHeaders() });
    expect(waiters.status).toBe(200);
    const waitersBody = (await waiters.json()) as { tags: Array<{ tag: string; count: number }> };
    expect(waitersBody.tags.find(entry => entry.tag === tag)?.count).toBe(1);
    // The parked stream is tracked globally while it waits.
    expect(await liveResponses()).toBe(baseline + 1);

    const release = await SELF.fetch(`${ORIGIN}/test/release?tag=${tag}`, {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(release.status).toBe(204);
    // An empty body, not `{}` with a JSON content type: callers that test for
    // presence treat any body as garbage on the 204 path.
    expect(await release.text()).toBe('');

    const stream = await readSse((await pending).body as ReadableStream<Uint8Array>);
    expect(stream.events[0]).toContain('"content":"done"');
    expect(stream.events.at(-1)).toContain('[DONE]');
    await waitForTag(tag, false);
    // Released waiters drain: the open-stream count returns to its baseline.
    await waitForLiveResponses(baseline);
  });

  it('streams a slow scenario incrementally instead of batching it', async () => {
    const response = await chat('__fake__:slow:4:250:8');
    expect(response.status).toBe(200);
    const stream = await readSse(response.body as ReadableStream<Uint8Array>);

    expect(stream.events.at(-1)).toContain('[DONE]');
    // A buffered response would deliver every event, including [DONE], in the
    // first read. The four 250 ms gaps must show up as separate reads.
    expect(stream.firstChunkHasDone).toBe(false);
    expect(stream.chunkCount).toBeGreaterThan(1);
    expect(stream.firstChunkAtMs).toBeLessThan(300);
    expect(stream.elapsedMs).toBeGreaterThan(600);
  });

  it('rejects a missing, malformed or foreign model token on the model routes', async () => {
    const missing = await SELF.fetch(`${ORIGIN}/api/openrouter/models`);
    expect(await drain(missing)).toBe(401);

    const malformed = await SELF.fetch(`${ORIGIN}/api/openrouter/models`, {
      headers: { Authorization: 'Bearer not-a-jwt' },
    });
    expect(await drain(malformed)).toBe(401);

    const wrongSecret = signToken({}, 'not-the-worker-secret');
    expect(await drain(await chat('__fake__:echo:nope', wrongSecret))).toBe(401);

    expect(await drain(await chat('__fake__:echo:nope', ADMIN_TOKEN()))).toBe(401);
  });

  it('rejects a policy-bearing model token', async () => {
    const policyBearer = signToken({ tokenPurpose: 'human-api', credentialExchange: false });
    expect(await drain(await chat('__fake__:echo:nope', policyBearer))).toBe(401);
  });

  it('keeps the model credential out of /test/* and the admin token out of the model routes', async () => {
    const modelBearer = signToken();

    const withModelToken = await SELF.fetch(`${ORIGIN}/test/requests`, {
      headers: { Authorization: `Bearer ${modelBearer}` },
    });
    expect(await drain(withModelToken)).toBe(401);

    const withAdminToken = await SELF.fetch(`${ORIGIN}/api/openrouter/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN()}` },
      body: JSON.stringify({ model: 'kilo/fake-deterministic', messages: [], stream: true }),
    });
    expect(await drain(withAdminToken)).toBe(401);
  });

  it('serves the model catalogue and validation with a valid model token', async () => {
    const token = signToken();

    const models = await SELF.fetch(`${ORIGIN}/api/openrouter/models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(models.status).toBe(200);
    const catalogue = (await models.json()) as { data: Array<{ id: string }> };
    expect(catalogue.data.some(entry => entry.id === 'fake-deterministic')).toBe(true);

    const validation = await SELF.fetch(`${ORIGIN}/api/openrouter/models/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ modelId: 'fake-deterministic' }),
    });
    expect(validation.status).toBe(200);
    await expect(validation.json()).resolves.toEqual({ valid: true });
  });

  it('guards every admitted model route with the model bearer only', async () => {
    for (const route of MODEL_ROUTES) {
      const requestInit = (authorization?: string): RequestInit => ({
        method: route.init?.method ?? 'GET',
        ...(route.init ? { body: route.init.body } : {}),
        headers: {
          ...(route.init ? { 'Content-Type': 'application/json' } : {}),
          ...(authorization === undefined ? {} : { Authorization: `Bearer ${authorization}` }),
        },
      });

      const missing = await SELF.fetch(`${ORIGIN}${route.path}`, requestInit());
      expect(await drain(missing), `${route.label} without a bearer`).toBe(401);

      const withAdmin = await SELF.fetch(`${ORIGIN}${route.path}`, requestInit(ADMIN_TOKEN()));
      expect(await drain(withAdmin), `${route.label} with the admin bearer`).toBe(401);

      const withModel = await SELF.fetch(`${ORIGIN}${route.path}`, requestInit(signToken()));
      expect(await drain(withModel), `${route.label} with a model bearer`).not.toBe(401);
    }
  });

  it('persists counters across a Durable Object eviction', async () => {
    const before = await requestCounts();

    const res = await transcription();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ text: 'Gateway transcription online' });

    await waitForPersistedTranscriptions(before.transcriptions + 1);

    const stub = testEnv.FAKE_LLM.get(testEnv.FAKE_LLM.idFromName(DO_NAME));
    await evictDurableObject(stub);

    const after = await requestCounts();
    expect(after.transcriptions).toBe(before.transcriptions + 1);
  });

  it('shapes a JSON 500 when the adapter fails before any shape', async () => {
    const emit = createWorkerEmit(new Request(`${ORIGIN}/api/openrouter/chat/completions`));
    emit.fail(new Error('boom'));

    expect(emit.shapedWon()).toBe(true);
    const response = emit.toResponse();
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 500, type: 'server_error' },
    });
  });

  it('answers a bodyless 500 when the handler completes without a shape', async () => {
    const tag = `no-shape-${Date.now()}`;
    const stub = testEnv.FAKE_LLM.get(testEnv.FAKE_LLM.idFromName(DO_NAME));

    // No shipped directive completes without shaping, so register a no-op
    // scenario for this test only. It drives `FakeLlmState.fetch` itself — the
    // path that owns the fallback — instead of calling the helper directly.
    scenarioRegistry[tag] = () => {};
    try {
      const observed = await runInDurableObject(stub, async instance => {
        const doInstance = instance as unknown as { fetch(request: Request): Promise<Response> };
        const response = await doInstance.fetch(
          new Request(`${ORIGIN}/api/openrouter/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'kilo/fake-deterministic',
              messages: [{ role: 'user', content: `__fake__:${tag}` }],
              stream: true,
            }),
          })
        );
        return { status: response.status, body: await response.text() };
      });

      expect(observed).toEqual({ status: 500, body: '' });
    } finally {
      delete scenarioRegistry[tag];
    }
  });

  it('guards every /test/* control route with the admin bearer', async () => {
    for (const route of CONTROL_ROUTES) {
      const missing = await SELF.fetch(`${ORIGIN}${route.path}`, route.init);
      expect(await drain(missing), `${route.label} without a bearer`).toBe(401);

      const wrong = await SELF.fetch(`${ORIGIN}${route.path}`, {
        ...route.init,
        headers: { Authorization: 'Bearer not-the-admin-token' },
      });
      expect(await drain(wrong), `${route.label} with a wrong bearer`).toBe(401);

      const authorized = await SELF.fetch(`${ORIGIN}${route.path}`, {
        ...route.init,
        headers: adminHeaders(),
      });
      expect(await drain(authorized), `${route.label} with the admin bearer`).not.toBe(401);
    }
  });

  it('guards an unsupported method on /test/* before method dispatch', async () => {
    const unauthenticated = await SELF.fetch(`${ORIGIN}/test/requests`, { method: 'DELETE' });
    expect(await drain(unauthenticated)).toBe(401);

    const authorized = await SELF.fetch(`${ORIGIN}/test/requests`, {
      method: 'DELETE',
      headers: adminHeaders(),
    });
    expect(await drain(authorized)).toBe(404);
  });

  it('leaves no phantom waiter when the emit is already closed', async () => {
    const tag = `preclosed-${Date.now()}`;
    const stub = testEnv.FAKE_LLM.get(testEnv.FAKE_LLM.idFromName(DO_NAME));

    const observed = await runInDurableObject(stub, async instance => {
      const doInstance = instance as unknown as {
        fetch(request: Request): Promise<Response>;
        core: { gates: Map<string, unknown[]>; liveResponses: Set<unknown> };
      };
      const controller = new AbortController();
      controller.abort();
      const response = await doInstance.fetch(
        new Request(`${ORIGIN}/api/openrouter/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'kilo/fake-deterministic',
            messages: [{ role: 'user', content: `__fake__:gate:${tag}` }],
            stream: true,
          }),
          signal: controller.signal,
        })
      );
      await response.body?.cancel();
      return {
        waiters: doInstance.core.gates.get(tag)?.length ?? 0,
        live: doInstance.core.liveResponses.size,
      };
    });

    expect(observed).toEqual({ waiters: 0, live: 0 });
  });

  it('returns waiters to zero when the parked stream is cancelled', async () => {
    const tag = `cancel-${Date.now()}`;
    const stub = testEnv.FAKE_LLM.get(testEnv.FAKE_LLM.idFromName(DO_NAME));

    // Miniflare does not propagate a client-side `Response.body.cancel()` or an
    // AbortController abort across the service-binding boundary (verified: the
    // stream `cancel()` callback never fires). Cancel the real stream inside the
    // DO's own execution context instead; this still exercises
    // `ReadableStream.cancel()` -> `fireClose()` -> core cleanup, observed below
    // through `/test/waiters`.
    const observed = await runInDurableObject(stub, async instance => {
      const doInstance = instance as unknown as {
        fetch(request: Request): Promise<Response>;
        core: { gates: Map<string, unknown[]> };
      };
      const response = await doInstance.fetch(
        new Request(`${ORIGIN}/api/openrouter/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'kilo/fake-deterministic',
            messages: [{ role: 'user', content: `__fake__:gate:${tag}` }],
            stream: true,
          }),
        })
      );
      const parked = doInstance.core.gates.get(tag)?.length ?? 0;
      await response.body?.cancel();
      return { parked, remaining: doInstance.core.gates.get(tag)?.length ?? 0 };
    });

    expect(observed).toEqual({ parked: 1, remaining: 0 });
    await waitForTag(tag, false);
  });

  it('releases every waiter on one tag and drains the count to zero', async () => {
    const tag = `concurrent-${Date.now()}`;
    const [first, second] = await Promise.all([
      chat(`__fake__:gate:${tag}`),
      chat(`__fake__:gate:${tag}`),
    ]);
    await waitForWaiterCount(tag, 2);

    const release = await SELF.fetch(`${ORIGIN}/test/release?tag=${tag}`, {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(release.status).toBe(204);
    expect(await release.text()).toBe('');

    const [firstStream, secondStream] = await Promise.all([
      readSse(first.body as ReadableStream<Uint8Array>),
      readSse(second.body as ReadableStream<Uint8Array>),
    ]);
    for (const stream of [firstStream, secondStream]) {
      expect(stream.events.at(-1)).toContain('[DONE]');
    }
    await waitForTag(tag, false);
  });
});
