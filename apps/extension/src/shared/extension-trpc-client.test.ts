/* eslint-disable @typescript-eslint/no-unsafe-type-assertion, vitest/prefer-describe-function-title, jest/no-hooks -- vitest mock calls destructuring requires typed casts; prefer-describe-function-title conflicts with jest/valid-title; hooks used for standard test setup */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createExtensionTrpcClient } from './extension-trpc-client';

const mockFetch = vi.fn();

vi.stubGlobal('fetch', mockFetch);

const FAKE_BASE_URL = 'https://api.example.com';
const FAKE_SESSION_ID = 'test-session-id';
const PROMPT_PAYLOAD = {
  cloudAgentSessionId: FAKE_SESSION_ID,
  payload: { mode: 'plan' as const, model: 'test-model', prompt: 'hello', type: 'prompt' as const },
};
const PROMPT_FIRST = {
  cloudAgentSessionId: FAKE_SESSION_ID,
  payload: { mode: 'plan' as const, model: 'test-model', prompt: 'first', type: 'prompt' as const },
};
const PROMPT_SECOND = {
  cloudAgentSessionId: FAKE_SESSION_ID,
  payload: {
    mode: 'plan' as const,
    model: 'test-model',
    prompt: 'second',
    type: 'prompt' as const,
  },
};

/**
 * Builds a realistic tRPC JSON response for an unbatched mutation call and
 * causes the next fetch invocation to resolve with it.
 */
const respondWithTRPCResult = (payload: unknown): void => {
  mockFetch.mockResolvedValueOnce(
    Response.json(
      {
        result: { data: payload },
      },
      {
        headers: {
          'content-type': 'application/json',
        },
        status: 200,
      }
    )
  );
};

describe('createExtensionTrpcClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends unbatched request to .../api/trpc/<procedure> when using skipBatch', async () => {
    respondWithTRPCResult({ ok: true });

    const client = createExtensionTrpcClient({
      apiBaseUrl: FAKE_BASE_URL,
      getToken: () => 'my-token',
    });

    await client['cloudAgentNext']['sendMessage'].mutate(PROMPT_PAYLOAD, {
      context: { skipBatch: true },
    });

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe(`${FAKE_BASE_URL}/api/trpc/cloudAgentNext.sendMessage`);
  });

  it('sends batched request with ?batch=1 under normal (no skipBatch) context', async () => {
    respondWithTRPCResult([{ result: { data: { ok: true } } }]);

    const client = createExtensionTrpcClient({
      apiBaseUrl: FAKE_BASE_URL,
      getToken: () => 'my-token',
    });

    await client['cloudAgentNext']['sendMessage'].mutate(PROMPT_PAYLOAD);

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe(`${FAKE_BASE_URL}/api/trpc/cloudAgentNext.sendMessage?batch=1`);
  });

  it('trims trailing slash from apiBaseUrl', async () => {
    respondWithTRPCResult({ ok: true });

    const client = createExtensionTrpcClient({
      apiBaseUrl: `${FAKE_BASE_URL}/`,
      getToken: () => 'my-token',
    });

    await client['cloudAgentNext']['sendMessage'].mutate(PROMPT_PAYLOAD, {
      context: { skipBatch: true },
    });

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe(`${FAKE_BASE_URL}/api/trpc/cloudAgentNext.sendMessage`);
  });

  it('includes Authorization header when getToken returns a value', async () => {
    respondWithTRPCResult({ ok: true });

    const client = createExtensionTrpcClient({
      apiBaseUrl: FAKE_BASE_URL,
      getToken: () => 'my-bearer-token',
    });

    await client['cloudAgentNext']['sendMessage'].mutate(PROMPT_PAYLOAD, {
      context: { skipBatch: true },
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init?.headers).toBeDefined();
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer my-bearer-token');
  });

  it('omits Authorization header when getToken returns undefined', async () => {
    respondWithTRPCResult({ ok: true });

    const client = createExtensionTrpcClient({
      apiBaseUrl: FAKE_BASE_URL,
      // eslint-disable-next-line unicorn/no-useless-undefined -- testing getToken undefined (no-token) path
      getToken: () => undefined,
    });

    await client['cloudAgentNext']['sendMessage'].mutate(PROMPT_PAYLOAD, {
      context: { skipBatch: true },
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init?.headers).toBeDefined();
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('omits Authorization header when getToken returns empty string', async () => {
    respondWithTRPCResult({ ok: true });

    const client = createExtensionTrpcClient({
      apiBaseUrl: FAKE_BASE_URL,
      getToken: () => '',
    });

    await client['cloudAgentNext']['sendMessage'].mutate(PROMPT_PAYLOAD, {
      context: { skipBatch: true },
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init?.headers).toBeDefined();
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('uses per-request getToken for late-bound token', async () => {
    respondWithTRPCResult({ ok: true });
    respondWithTRPCResult({ ok: true });

    let callCount = 0;
    const getToken = vi.fn().mockImplementation(() => {
      callCount += 1;
      return `token-${callCount}`;
    });

    const client = createExtensionTrpcClient({
      apiBaseUrl: FAKE_BASE_URL,
      getToken,
    });

    await client['cloudAgentNext']['sendMessage'].mutate(PROMPT_FIRST, {
      context: { skipBatch: true },
    });

    await client['cloudAgentNext']['sendMessage'].mutate(PROMPT_SECOND, {
      context: { skipBatch: true },
    });

    expect(getToken).toHaveBeenCalledTimes(2);

    const [, init1] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers1 = init1.headers as Record<string, string>;
    expect(headers1['Authorization']).toBe('Bearer token-1');

    const [, init2] = mockFetch.mock.calls[1] as [string, RequestInit];
    const headers2 = init2.headers as Record<string, string>;
    expect(headers2['Authorization']).toBe('Bearer token-2');
  });
});
