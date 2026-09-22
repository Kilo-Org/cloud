import { afterEach, describe, expect, it, vi } from 'vitest';
import { forwardedAuthFromProps, ORGANIZATION_ID_HEADER, verifyKiloSessionToken } from './auth';
import { resolveExternalToken } from './index';

describe('auth (props-derived identity)', () => {
  it('names the organization header apps/web reads', () => {
    expect(ORGANIZATION_ID_HEADER).toBe('x-kilocode-organizationid');
  });

  it('forwards the grant Kilo token and organization as a bearer + org header value', () => {
    const auth = forwardedAuthFromProps({
      kiloUserId: 'user-1',
      organizationId: 'org-uuid-1',
      kiloToken: 'kilo-tok',
      clientId: 'client-1',
    });
    expect(auth).toEqual({
      authorization: 'Bearer kilo-tok',
      organizationId: 'org-uuid-1',
      kiloUserId: 'user-1',
      clientId: 'client-1',
    });
  });

  it('omits the organization for a personal grant (a caller header is never consulted)', () => {
    const auth = forwardedAuthFromProps({
      kiloUserId: 'user-1',
      organizationId: null,
      kiloToken: 'kilo-tok',
      clientId: 'client-1',
    });
    expect(auth.organizationId).toBeUndefined();
    expect(auth.authorization).toBe('Bearer kilo-tok');
  });
});

/**
 * The session-token verifier: apps/web's `GET /api/user` is the only trust
 * anchor. The fake fetch records the outgoing request; no live network runs.
 */
describe('verifyKiloSessionToken (apps/web is the trust anchor)', () => {
  function fetchStub(handler: (url: string, init: RequestInit) => Promise<Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const request: RequestInit = init ?? {};
      calls.push({ url: String(url), init: request });
      return handler(String(url), request);
    });
    return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
  }

  it('a 200 /api/user yields the identity and the request carried the bearer', async () => {
    const { calls, fetchImpl } = fetchStub(async () =>
      Response.json({ id: 'user-7', email: 'someone@example.com' })
    );
    const identity = await verifyKiloSessionToken({
      webBaseUrl: 'https://app.kilo.ai',
      token: 'kilo-session-token',
      fetchImpl,
    });

    expect(identity).toEqual({ kiloUserId: 'user-7' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://app.kilo.ai/api/user');
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.redirect).toBe('manual');
    expect((calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer kilo-session-token'
    );
  });

  it('a non-2xx response yields null', async () => {
    const { fetchImpl } = fetchStub(async () => new Response('unauthorized', { status: 401 }));
    expect(
      await verifyKiloSessionToken({
        webBaseUrl: 'https://app.kilo.ai',
        token: 'bad-token',
        fetchImpl,
      })
    ).toBeNull();
  });

  it('a rejected fetch yields null (transport error or timeout)', async () => {
    const network = fetchStub(async () => {
      throw new Error('network down');
    });
    expect(
      await verifyKiloSessionToken({
        webBaseUrl: 'https://app.kilo.ai',
        token: 'kilo-session-token',
        fetchImpl: network.fetchImpl,
      })
    ).toBeNull();

    const timedOut = fetchStub(async () => {
      throw new DOMException('The operation was aborted', 'AbortError');
    });
    expect(
      await verifyKiloSessionToken({
        webBaseUrl: 'https://app.kilo.ai',
        token: 'kilo-session-token',
        fetchImpl: timedOut.fetchImpl,
      })
    ).toBeNull();
  });

  it('a malformed or id-less body yields null', async () => {
    const bodies = [
      new Response('not json', { status: 200 }),
      Response.json({}),
      Response.json({ id: '' }),
      Response.json({ id: 42 }),
      Response.json([{ id: 'user-1' }]),
    ];
    for (const response of bodies) {
      const { fetchImpl } = fetchStub(async () => response);
      expect(
        await verifyKiloSessionToken({
          webBaseUrl: 'https://app.kilo.ai',
          token: 'kilo-session-token',
          fetchImpl,
        })
      ).toBeNull();
    }
  });

  it('never logs the token', async () => {
    const spies = ['log', 'warn', 'error'].map(level =>
      vi.spyOn(console, level as 'log').mockImplementation(() => {})
    );
    try {
      const { fetchImpl } = fetchStub(async () => Response.json({ id: 'user-7' }));
      await verifyKiloSessionToken({
        webBaseUrl: 'https://app.kilo.ai',
        token: 'kilo-session-token',
        fetchImpl,
      });
      for (const spy of spies) {
        expect(spy.mock.calls.flat().join(' ')).not.toContain('kilo-session-token');
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

/** The exact library wiring: `providerOptions.resolveExternalToken`. */
describe('resolveExternalToken (library wiring)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function externalTokenInput(token: string, organizationId?: string) {
    const headers = new Headers();
    if (organizationId !== undefined) headers.set(ORGANIZATION_ID_HEADER, organizationId);
    return {
      token,
      request: new Request('https://kilo-mcp.test/mcp', { headers }),
      env: { WEB_BASE_URL: 'https://app.kilo.ai' } as Env,
    };
  }

  it('returns the grant props for a valid session token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ id: 'user-7' }))
    );
    const result = await resolveExternalToken(externalTokenInput('kilo-session', 'org-9'));

    expect(result).toEqual({
      props: { kiloToken: 'kilo-session', kiloUserId: 'user-7', organizationId: 'org-9' },
    });
    // `resourceMetadata.resource` is unset, so no audience is required.
    expect(result).not.toHaveProperty('audience');
  });

  it('omits the organization when the client sent none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ id: 'user-7' }))
    );
    const result = await resolveExternalToken(externalTokenInput('kilo-session'));

    expect(result).toEqual({ props: { kiloToken: 'kilo-session', kiloUserId: 'user-7' } });
  });

  it('returns null for an invalid session token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 }))
    );
    expect(await resolveExternalToken(externalTokenInput('bad-token'))).toBeNull();
  });
});
