import { describe, expect, it, vi } from 'vitest';
import {
  ORG_LIST_QUERY_PATH,
  USER_ME_QUERY_PATH,
  createKiloPairing,
  fetchOrgOptions,
  fetchUserIsAdmin,
  pollKiloPairing,
  redirectOriginOf,
} from './kilo-pairing';
import { PERSONAL_ORG_ID } from './pages';

const WEB = 'https://app.kilo.test';

type FetchCall = [string, RequestInit | undefined];

/** The client a pairing asks about, and the echo apps/web returns for it. */
const CLIENT = {
  clientId: 'client-abc',
  clientName: 'Claude Desktop',
  redirectOrigin: 'https://client.test',
};

/** An apps/web answer that stored the client it was asked about. */
function pairingCreated(): Response {
  return Response.json({ code: 'PAIR-1', requestingClient: CLIENT });
}

function fetchMock(
  impl: (url: string, init?: RequestInit) => Response | Promise<Response>
): typeof fetch & { mock: { calls: FetchCall[] } } {
  return vi.fn(async (input: string | URL, init?: RequestInit) =>
    impl(String(input), init)
  ) as unknown as typeof fetch & { mock: { calls: FetchCall[] } };
}

function authorizeRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://kilo-mcp.test/authorize?client_id=c', { headers });
}

function forwardedHeaders(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

function sentClient(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== 'string') throw new Error('expected a JSON string pairing body');
  return JSON.parse(body) as unknown;
}

describe('redirectOriginOf', () => {
  it('answers the origin of an http(s) redirect and drops the path', () => {
    expect(redirectOriginOf('https://client.test/cb?state=1')).toBe('https://client.test');
    expect(redirectOriginOf('https://client.test:8443/cb')).toBe('https://client.test:8443');
    expect(redirectOriginOf('http://localhost:7777/cb')).toBe('http://localhost:7777');
  });

  it('answers a scheme and host for a native app redirect', () => {
    expect(redirectOriginOf('cursor://anysphere.cursor/callback')).toBe(
      'cursor://anysphere.cursor'
    );
    expect(redirectOriginOf('vscode://vendor.app')).toBe('vscode://vendor.app');
  });

  it('answers null for a redirect that is not an absolute URL', () => {
    expect(redirectOriginOf('not-a-url')).toBeNull();
    expect(redirectOriginOf('/callback')).toBeNull();
  });
});

describe('createKiloPairing', () => {
  it('names the requesting client and returns the pairing code', async () => {
    const fetchImpl = fetchMock(() => pairingCreated());
    const result = await createKiloPairing(
      { webBaseUrl: WEB, fetchImpl },
      authorizeRequest(),
      CLIENT
    );
    expect(result).toEqual({ ok: true, pairingCode: 'PAIR-1', requestingClient: CLIENT });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${WEB}/api/device-auth/codes`);
    expect(init?.method).toBe('POST');
    expect(forwardedHeaders(init)['content-type']).toBe('application/json');
    expect(sentClient(init)).toEqual({
      requesting_client: {
        client_id: 'client-abc',
        client_name: 'Claude Desktop',
        redirect_origin: 'https://client.test',
      },
    });
  });

  it('gives a nameless client a neutral display label', async () => {
    const fetchImpl = fetchMock(() =>
      Response.json({
        code: 'PAIR-1',
        requestingClient: { ...CLIENT, clientName: 'Unnamed application' },
      })
    );
    await createKiloPairing({ webBaseUrl: WEB, fetchImpl }, authorizeRequest(), {
      clientId: 'client-abc',
      redirectOrigin: 'https://client.test',
    });
    const body = sentClient(fetchImpl.mock.calls[0]![1]);
    expect(body).toMatchObject({
      requesting_client: { client_name: 'Unnamed application' },
    });
  });

  it('refuses an answer that does not name the same client', async () => {
    const otherClient = Response.json({
      code: 'PAIR-1',
      requestingClient: { ...CLIENT, clientId: 'client-other' },
    });
    await expect(
      createKiloPairing(
        { webBaseUrl: WEB, fetchImpl: fetchMock(() => otherClient) },
        authorizeRequest(),
        CLIENT
      )
    ).resolves.toEqual({ ok: false, kind: 'client_unconfirmed' });
    await expect(
      createKiloPairing(
        {
          webBaseUrl: WEB,
          fetchImpl: fetchMock(() => Response.json({ code: 'PAIR-1' })),
        },
        authorizeRequest(),
        CLIENT
      )
    ).resolves.toEqual({ ok: false, kind: 'client_unconfirmed' });
  });

  it('forwards the Cloudflare client IP and user-agent to apps/web', async () => {
    const fetchImpl = fetchMock(() => pairingCreated());
    await createKiloPairing(
      { webBaseUrl: WEB, fetchImpl },
      authorizeRequest({
        'CF-Connecting-IP': '203.0.113.7',
        'x-forwarded-for': '198.51.100.2',
        'user-agent': 'claude-ai/0.1.0',
      }),
      CLIENT
    );
    const headers = forwardedHeaders(fetchImpl.mock.calls[0]![1]);
    // CF-Connecting-IP is authoritative when present.
    expect(headers['x-forwarded-for']).toBe('203.0.113.7');
    expect(headers['user-agent']).toBe('claude-ai/0.1.0');
  });

  it('falls back to x-forwarded-for when CF-Connecting-IP is absent', async () => {
    const fetchImpl = fetchMock(() => pairingCreated());
    await createKiloPairing(
      { webBaseUrl: WEB, fetchImpl },
      authorizeRequest({ 'x-forwarded-for': '198.51.100.2' }),
      CLIENT
    );
    expect(forwardedHeaders(fetchImpl.mock.calls[0]![1])['x-forwarded-for']).toBe('198.51.100.2');
  });

  it('drops a header that fails validation without dropping the rest', async () => {
    const fetchImpl = fetchMock(() => pairingCreated());
    await createKiloPairing(
      { webBaseUrl: WEB, fetchImpl },
      authorizeRequest({
        'CF-Connecting-IP': '203.0.113.7',
        'user-agent': 'a'.repeat(2000),
      }),
      CLIENT
    );
    const headers = forwardedHeaders(fetchImpl.mock.calls[0]![1]);
    expect(headers['x-forwarded-for']).toBe('203.0.113.7');
    expect(headers['user-agent']).toBeUndefined();
  });

  it('maps 429 to rate_limited and any other failure to unreachable', async () => {
    await expect(
      createKiloPairing(
        { webBaseUrl: WEB, fetchImpl: fetchMock(() => new Response('', { status: 429 })) },
        authorizeRequest(),
        CLIENT
      )
    ).resolves.toEqual({ ok: false, kind: 'rate_limited' });
    await expect(
      createKiloPairing(
        { webBaseUrl: WEB, fetchImpl: fetchMock(() => new Response('', { status: 500 })) },
        authorizeRequest(),
        CLIENT
      )
    ).resolves.toEqual({ ok: false, kind: 'unreachable' });
  });

  it('treats a transport failure or malformed body as unreachable, never a crash', async () => {
    await expect(
      createKiloPairing(
        { webBaseUrl: WEB, fetchImpl: fetchMock(() => Promise.reject(new Error('down'))) },
        authorizeRequest(),
        CLIENT
      )
    ).resolves.toEqual({ ok: false, kind: 'unreachable' });
    await expect(
      createKiloPairing(
        { webBaseUrl: WEB, fetchImpl: fetchMock(() => Response.json({ nope: 1 })) },
        authorizeRequest(),
        CLIENT
      )
    ).resolves.toEqual({ ok: false, kind: 'unreachable' });
    await expect(
      createKiloPairing(
        { webBaseUrl: WEB, fetchImpl: fetchMock(() => Response.json({ code: '' })) },
        authorizeRequest(),
        CLIENT
      )
    ).resolves.toEqual({ ok: false, kind: 'unreachable' });
  });
});

describe('pollKiloPairing', () => {
  const deps = { webBaseUrl: WEB };

  it('maps 202/403/410 and a malformed success body', async () => {
    await expect(
      pollKiloPairing(
        { ...deps, fetchImpl: fetchMock(() => new Response('', { status: 202 })) },
        'PAIR-1'
      )
    ).resolves.toEqual({ status: 'pending' });
    await expect(
      pollKiloPairing(
        { ...deps, fetchImpl: fetchMock(() => new Response('', { status: 403 })) },
        'PAIR-1'
      )
    ).resolves.toEqual({ status: 'denied' });
    await expect(
      pollKiloPairing(
        { ...deps, fetchImpl: fetchMock(() => new Response('', { status: 410 })) },
        'PAIR-1'
      )
    ).resolves.toEqual({ status: 'expired' });
    await expect(
      pollKiloPairing(
        { ...deps, fetchImpl: fetchMock(() => Response.json({ status: 'approved' })) },
        'PAIR-1'
      )
    ).resolves.toEqual({ status: 'unreachable' });
  });

  it('returns token, userId, and the confirmed client on an approved pairing', async () => {
    const fetchImpl = fetchMock(() =>
      Response.json({
        status: 'approved',
        token: 'kilo-jwt',
        userId: 'u-7',
        requestingClient: CLIENT,
        clientConfirmed: true,
      })
    );
    await expect(pollKiloPairing({ ...deps, fetchImpl }, 'PAIR-9')).resolves.toEqual({
      status: 'approved',
      token: 'kilo-jwt',
      userId: 'u-7',
      requestingClient: CLIENT,
      clientConfirmed: true,
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${WEB}/api/device-auth/codes/PAIR-9`);
  });

  it('reports an approval that carries no usable client description', async () => {
    await expect(
      pollKiloPairing(
        {
          ...deps,
          fetchImpl: fetchMock(() =>
            Response.json({ status: 'approved', token: 'kilo-jwt', userId: 'u-7' })
          ),
        },
        'PAIR-9'
      )
    ).resolves.toEqual({
      status: 'approved',
      token: 'kilo-jwt',
      userId: 'u-7',
      requestingClient: null,
      clientConfirmed: false,
    });
    await expect(
      pollKiloPairing(
        {
          ...deps,
          fetchImpl: fetchMock(() =>
            Response.json({
              status: 'approved',
              token: 'kilo-jwt',
              userId: 'u-7',
              requestingClient: { clientId: 'client-abc' },
              clientConfirmed: 'true',
            })
          ),
        },
        'PAIR-9'
      )
    ).resolves.toEqual({
      status: 'approved',
      token: 'kilo-jwt',
      userId: 'u-7',
      requestingClient: null,
      clientConfirmed: false,
    });
  });

  it('treats a transport failure or a non-OK status as unreachable', async () => {
    await expect(
      pollKiloPairing(
        { ...deps, fetchImpl: fetchMock(() => Promise.reject(new Error('down'))) },
        'P'
      )
    ).resolves.toEqual({ status: 'unreachable' });
    await expect(
      pollKiloPairing(
        { ...deps, fetchImpl: fetchMock(() => new Response('', { status: 500 })) },
        'P'
      )
    ).resolves.toEqual({ status: 'unreachable' });
  });
});

describe('fetchOrgOptions', () => {
  it('calls organizations.list with the Kilo bearer and lists personal first', async () => {
    const fetchImpl = fetchMock(() =>
      Response.json({
        result: {
          data: [
            { organizationId: 'org-1', organizationName: 'Acme' },
            { organizationId: 'org-2', organizationName: 'Nova' },
          ],
        },
      })
    );
    const options = await fetchOrgOptions({ webBaseUrl: WEB, fetchImpl }, 'kilo-tok-1');
    expect(options).toEqual([
      { id: PERSONAL_ORG_ID, name: 'Personal account' },
      { id: 'org-1', name: 'Acme' },
      { id: 'org-2', name: 'Nova' },
    ]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${WEB}/api/trpc/${ORG_LIST_QUERY_PATH}`);
    expect(((init?.headers ?? {}) as Record<string, string>).Authorization).toBe(
      'Bearer kilo-tok-1'
    );
  });

  it('returns only the personal context for an empty org list', async () => {
    const options = await fetchOrgOptions(
      { webBaseUrl: WEB, fetchImpl: fetchMock(() => Response.json({ result: { data: [] } })) },
      'k'
    );
    expect(options).toEqual([{ id: PERSONAL_ORG_ID, name: 'Personal account' }]);
  });

  it('dedupes ids and skips malformed rows', async () => {
    const options = await fetchOrgOptions(
      {
        webBaseUrl: WEB,
        fetchImpl: fetchMock(() =>
          Response.json({
            result: {
              data: [
                { organizationId: 'org-1', organizationName: 'Acme' },
                { organizationId: 'org-1', organizationName: 'dup' },
                { organizationName: 'no id' },
                'garbage',
              ],
            },
          })
        ),
      },
      'k'
    );
    expect(options.map(o => o.id)).toEqual([PERSONAL_ORG_ID, 'org-1']);
  });

  it('throws on a non-OK or unexpected upstream (caller renders a retry)', async () => {
    await expect(
      fetchOrgOptions(
        { webBaseUrl: WEB, fetchImpl: fetchMock(() => new Response('', { status: 500 })) },
        'k'
      )
    ).rejects.toThrow();
    await expect(
      fetchOrgOptions(
        { webBaseUrl: WEB, fetchImpl: fetchMock(() => Response.json({ nope: 1 })) },
        'k'
      )
    ).rejects.toThrow();
  });
});

describe('fetchUserIsAdmin', () => {
  function meFetch(isAdmin: unknown): typeof fetch & { mock: { calls: FetchCall[] } } {
    return fetchMock(() => Response.json({ result: { data: { isAdmin } } }));
  }

  it('calls user.getMe with the Kilo bearer and reads the trusted flag', async () => {
    const fetchImpl = meFetch(true);
    await expect(fetchUserIsAdmin({ webBaseUrl: WEB, fetchImpl }, 'kilo-tok-1')).resolves.toBe(
      true
    );
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${WEB}/api/trpc/${USER_ME_QUERY_PATH}`);
    expect(forwardedHeaders(init).Authorization).toBe('Bearer kilo-tok-1');
    await expect(
      fetchUserIsAdmin({ webBaseUrl: WEB, fetchImpl: meFetch(false) }, 'k')
    ).resolves.toBe(false);
  });

  it('answers false for a missing or mistyped flag, never a sentinel', async () => {
    await expect(
      fetchUserIsAdmin({ webBaseUrl: WEB, fetchImpl: meFetch(undefined) }, 'k')
    ).resolves.toBe(false);
    await expect(
      fetchUserIsAdmin({ webBaseUrl: WEB, fetchImpl: meFetch('true') }, 'k')
    ).resolves.toBe(false);
    await expect(
      fetchUserIsAdmin(
        { webBaseUrl: WEB, fetchImpl: fetchMock(() => Response.json({ nope: 1 })) },
        'k'
      )
    ).resolves.toBe(false);
  });

  it('throws on a non-OK status so the caller can tell it apart from false', async () => {
    await expect(
      fetchUserIsAdmin(
        { webBaseUrl: WEB, fetchImpl: fetchMock(() => new Response('', { status: 500 })) },
        'k'
      )
    ).rejects.toThrow();
    await expect(
      fetchUserIsAdmin(
        { webBaseUrl: WEB, fetchImpl: fetchMock(() => new Response('', { status: 401 })) },
        'k'
      )
    ).rejects.toThrow();
  });

  it('throws on a transport failure without leaking it as false', async () => {
    await expect(
      fetchUserIsAdmin(
        { webBaseUrl: WEB, fetchImpl: fetchMock(() => Promise.reject(new Error('down'))) },
        'k'
      )
    ).rejects.toThrow();
  });
});
