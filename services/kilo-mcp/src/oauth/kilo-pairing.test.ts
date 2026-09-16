import { describe, expect, it, vi } from 'vitest';
import {
  ORG_LIST_QUERY_PATH,
  createKiloPairing,
  fetchOrgOptions,
  pollKiloPairing,
} from './kilo-pairing';
import { PERSONAL_ORG_ID } from './pages';

const WEB = 'https://app.kilo.test';

type FetchCall = [string, RequestInit | undefined];

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

describe('createKiloPairing', () => {
  it('POSTs to apps/web and returns the pairing code', async () => {
    const fetchImpl = fetchMock(() => Response.json({ code: 'PAIR-1' }));
    const result = await createKiloPairing({ webBaseUrl: WEB, fetchImpl }, authorizeRequest());
    expect(result).toEqual({ ok: true, pairingCode: 'PAIR-1' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${WEB}/api/device-auth/codes`);
    expect(init?.method).toBe('POST');
    expect(forwardedHeaders(init)['content-type']).toBe('application/json');
    expect(init?.body).toBe('{}');
  });

  it('forwards the Cloudflare client IP and user-agent to apps/web', async () => {
    const fetchImpl = fetchMock(() => Response.json({ code: 'PAIR-1' }));
    await createKiloPairing(
      { webBaseUrl: WEB, fetchImpl },
      authorizeRequest({
        'CF-Connecting-IP': '203.0.113.7',
        'x-forwarded-for': '198.51.100.2',
        'user-agent': 'claude-ai/0.1.0',
      })
    );
    const headers = forwardedHeaders(fetchImpl.mock.calls[0]![1]);
    // CF-Connecting-IP is authoritative when present.
    expect(headers['x-forwarded-for']).toBe('203.0.113.7');
    expect(headers['user-agent']).toBe('claude-ai/0.1.0');
  });

  it('falls back to x-forwarded-for when CF-Connecting-IP is absent', async () => {
    const fetchImpl = fetchMock(() => Response.json({ code: 'PAIR-1' }));
    await createKiloPairing(
      { webBaseUrl: WEB, fetchImpl },
      authorizeRequest({ 'x-forwarded-for': '198.51.100.2' })
    );
    expect(forwardedHeaders(fetchImpl.mock.calls[0]![1])['x-forwarded-for']).toBe('198.51.100.2');
  });

  it('drops a header that fails validation without dropping the rest', async () => {
    const fetchImpl = fetchMock(() => Response.json({ code: 'PAIR-1' }));
    await createKiloPairing(
      { webBaseUrl: WEB, fetchImpl },
      authorizeRequest({
        'CF-Connecting-IP': '203.0.113.7',
        'user-agent': 'a'.repeat(2000),
      })
    );
    const headers = forwardedHeaders(fetchImpl.mock.calls[0]![1]);
    expect(headers['x-forwarded-for']).toBe('203.0.113.7');
    expect(headers['user-agent']).toBeUndefined();
  });

  it('maps 429 to rate_limited and any other failure to unreachable', async () => {
    await expect(
      createKiloPairing(
        { webBaseUrl: WEB, fetchImpl: fetchMock(() => new Response('', { status: 429 })) },
        authorizeRequest()
      )
    ).resolves.toEqual({ ok: false, kind: 'rate_limited' });
    await expect(
      createKiloPairing(
        { webBaseUrl: WEB, fetchImpl: fetchMock(() => new Response('', { status: 500 })) },
        authorizeRequest()
      )
    ).resolves.toEqual({ ok: false, kind: 'unreachable' });
  });

  it('treats a transport failure or malformed body as unreachable, never a crash', async () => {
    await expect(
      createKiloPairing(
        { webBaseUrl: WEB, fetchImpl: fetchMock(() => Promise.reject(new Error('down'))) },
        authorizeRequest()
      )
    ).resolves.toEqual({ ok: false, kind: 'unreachable' });
    await expect(
      createKiloPairing(
        { webBaseUrl: WEB, fetchImpl: fetchMock(() => Response.json({ nope: 1 })) },
        authorizeRequest()
      )
    ).resolves.toEqual({ ok: false, kind: 'unreachable' });
    await expect(
      createKiloPairing(
        { webBaseUrl: WEB, fetchImpl: fetchMock(() => Response.json({ code: '' })) },
        authorizeRequest()
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

  it('returns token + userId on an approved pairing', async () => {
    const fetchImpl = fetchMock(() =>
      Response.json({ status: 'approved', token: 'kilo-jwt', userId: 'u-7' })
    );
    await expect(pollKiloPairing({ ...deps, fetchImpl }, 'PAIR-9')).resolves.toEqual({
      status: 'approved',
      token: 'kilo-jwt',
      userId: 'u-7',
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${WEB}/api/device-auth/codes/PAIR-9`);
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
