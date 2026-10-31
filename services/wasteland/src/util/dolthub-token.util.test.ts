import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchFreshDoltHubToken } from './dolthub-token.util';

const KILO_INTERNAL_API_URL = 'https://app.example.test';
const DEDICATED_SECRET = 'wasteland-dolthub-secret';
const SHARED_INTERNAL_SECRET = 'platform-internal-secret';

function envWith(overrides: Record<string, unknown> = {}): Env {
  return {
    KILO_INTERNAL_API_URL,
    WASTELAND_DOLTHUB_TOKEN_SECRET: DEDICATED_SECRET,
    INTERNAL_API_SECRET: SHARED_INTERNAL_SECRET,
    ...overrides,
  } as unknown as Env;
}

describe('fetchFreshDoltHubToken', () => {
  const originalFetch = globalThis.fetch;
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('asks for the user token with the dedicated caller credential', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'dhat.v1', dolthubUsername: 'someone' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const result = await fetchFreshDoltHubToken(envWith(), { userId: 'oauth/user-1' });

    expect(result).toEqual({
      status: 'ok',
      data: { token: 'dhat.v1', dolthubUsername: 'someone' },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${KILO_INTERNAL_API_URL}/api/internal/integrations/dolthub/token`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEDICATED_SECRET}`,
    });
    expect(init?.body).toBe(JSON.stringify({ userId: 'oauth/user-1' }));
    expect(JSON.stringify(init)).not.toContain(SHARED_INTERNAL_SECRET);
  });

  it('reports unavailable without a network call when the dedicated secret is missing', async () => {
    const result = await fetchFreshDoltHubToken(envWith({ WASTELAND_DOLTHUB_TOKEN_SECRET: '' }), {
      userId: 'oauth/user-1',
    });

    expect(result).toEqual({
      status: 'unavailable',
      reason: 'WASTELAND_DOLTHUB_TOKEN_SECRET unavailable',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not fall back to the platform-wide internal secret', async () => {
    const result = await fetchFreshDoltHubToken(
      envWith({ WASTELAND_DOLTHUB_TOKEN_SECRET: undefined }),
      { userId: 'oauth/user-1' }
    );

    expect(result.status).toBe('unavailable');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports unavailable when the endpoint rejects the caller', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{"error":"Unauthorized"}', { status: 401 }));

    const result = await fetchFreshDoltHubToken(envWith(), { userId: 'oauth/user-1' });

    expect(result.status).toBe('unavailable');
    expect(result.status === 'unavailable' ? result.reason : '').toContain('HTTP 401');
  });

  it('distinguishes an uninstalled integration from a missing route', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('{"error":"DoltHub integration not installed"}', { status: 404 })
    );
    expect(await fetchFreshDoltHubToken(envWith(), { userId: 'u' })).toEqual({
      status: 'not-installed',
    });

    fetchSpy.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    expect(await fetchFreshDoltHubToken(envWith(), { userId: 'u' })).toEqual({
      status: 'unavailable',
      reason: 'route returned 404',
    });
  });

  it('reports an inactive integration', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{"error":"inactive"}', { status: 409 }));

    expect(await fetchFreshDoltHubToken(envWith(), { userId: 'u' })).toEqual({
      status: 'not-active',
    });
  });

  it('reports unavailable for an unexpected response shape', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ token: '' }), { status: 200 }));

    expect(await fetchFreshDoltHubToken(envWith(), { userId: 'u' })).toEqual({
      status: 'unavailable',
      reason: 'unexpected response shape from token endpoint',
    });
  });

  it('reports unavailable on a transport error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('connection refused'));

    const result = await fetchFreshDoltHubToken(envWith(), { userId: 'u' });

    expect(result.status).toBe('unavailable');
    expect(result.status === 'unavailable' ? result.reason : '').toContain('connection refused');
  });
});
