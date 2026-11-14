/**
 * The tRPC links must send queries as POST. `trpc.test.ts` mocks
 * `@trpc/client`, so it can only observe the options the app passes; this
 * suite runs the real links and asserts the HTTP request they produce for a
 * no-input procedure, including the `{}` body the batched link sends and
 * `withJsonBody` restores for the single link.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { trpcClient } from './trpc';

vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.example.com',
  E2E_LATENCY_MESSAGES_MS: 0,
  E2E_LATENCY_SESSION_MS: 0,
  E2E_SECURE_STORE_FAULT_MS: 0,
  LATENCY_INGEST_URL: undefined,
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(() => Promise.resolve(null)),
  setItemAsync: vi.fn(() => Promise.resolve(undefined)),
  deleteItemAsync: vi.fn(() => Promise.resolve(undefined)),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
}));

vi.mock('@/lib/storage-keys', () => ({
  ACTIVE_USER_ID_KEY: 'active-user-id',
  AUTH_TOKEN_KEY: 'auth-token',
  ORGANIZATION_STORAGE_KEY: 'organization',
  TOKEN_EXPIRES_AT_KEY: 'token-expires-at',
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

vi.mock('expo-application', () => ({
  nativeApplicationVersion: '1.0.4',
}));

type CapturedRequest = { url: string; init: RequestInit };

// The client module captures the global `fetch` when it evaluates, so the stub
// installs before the import of `./trpc` resolves.
const fetchStub = vi.hoisted(() => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; init: RequestInit }[] = [];
  function requestUrl(url: string | URL | Request): string {
    if (typeof url === 'string') {
      return url;
    }
    return url instanceof URL ? url.toString() : url.url;
  }
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: requestUrl(url), init: init ?? {} });
    return Promise.resolve(
      Response.json({ result: { data: null } }, { headers: { 'content-type': 'application/json' } })
    );
  }) as typeof fetch;
  return { originalFetch, requests };
});

const capturedRequests: CapturedRequest[] = fetchStub.requests;

function lastRequest(): CapturedRequest {
  const request = capturedRequests.at(-1);
  if (!request) {
    throw new Error('no HTTP request was made');
  }
  return request;
}

beforeEach(() => {
  capturedRequests.length = 0;
});

afterAll(() => {
  globalThis.fetch = fetchStub.originalFetch;
});

describe('tRPC HTTP method', () => {
  it('sends an unbatched no-input query as POST with an empty JSON body', async () => {
    await trpcClient.user.getMe.query();

    expect(capturedRequests).toHaveLength(1);
    const request = lastRequest();
    expect(request.url).toBe('https://api.example.com/api/trpc/user.getMe');
    expect(request.init.method).toBe('POST');
    expect(request.init.body).toBe('{}');
  });

  it('sends a batched no-input query as POST with an empty JSON body', async () => {
    await trpcClient.kiloPass.getState.query();

    expect(capturedRequests).toHaveLength(1);
    const request = lastRequest();
    expect(request.url).toBe('https://api.example.com/api/trpc/kiloPass.getState?batch=1');
    expect(request.init.method).toBe('POST');
    expect(request.init.body).toBe('{}');
  });
});
