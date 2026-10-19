import { beforeEach, describe, expect, it, vi } from 'vitest';
import { proxyUpstream } from './upstream-proxy';
import { clearDnsCacheForTests, validateResolvedPublicUrl } from './url-policy';

describe('proxyUpstream', () => {
  beforeEach(() => {
    clearDnsCacheForTests();
  });

  it('streams to a validated upstream with credential-safe headers', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
        return new Response(JSON.stringify({ Answer: [{ data: '8.8.8.8' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      calls.push({ url, headers: new Headers(init?.headers) });
      return new Response('upstream-body', {
        status: 200,
        headers: {
          'Content-Type': 'text/plain',
          'Set-Cookie': 'upstream-session=value; Path=/',
          'Set-Cookie2': 'legacy-session=value; Path=/',
        },
      });
    };
    const response = await proxyUpstream({
      env: {} as Env,
      request: new Request('https://mcp.kilosessions.ai/mcp-connect/user/u/c/r?mode=test', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer gateway-token',
          Cookie: 'session=value',
          'MCP-Session-Id': 'session-1',
        },
        body: 'request-body',
      }),
      remoteUrl: 'https://remote.example/mcp',
      descendantPath: '/tools/list',
      pathPassthrough: true,
      staticHeaders: { 'X-API-Key': 'static-secret' },
      providerAuthorization: 'Bearer provider-token',
      fetchImpl,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('set-cookie2')).toBeNull();
    await expect(response.text()).resolves.toBe('upstream-body');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://remote.example/mcp/tools/list?mode=test');
    expect(calls[0].headers.get('authorization')).toBe('Bearer provider-token');
    expect(calls[0].headers.get('x-api-key')).toBe('static-secret');
    expect(calls[0].headers.get('cookie')).toBeNull();
    expect(calls[0].headers.get('mcp-session-id')).toBe('session-1');
  });

  it('does not follow upstream redirects with injected credentials', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async input => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
        return new Response(JSON.stringify({ Answer: [{ data: '8.8.8.8' }] }), {
          status: 200,
        });
      }
      calls.push(url);
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://other.example/redirected' },
      });
    };
    const response = await proxyUpstream({
      env: {} as Env,
      request: new Request('https://mcp.kilosessions.ai/mcp-connect/user/u/c/r'),
      remoteUrl: 'https://remote.example/mcp',
      descendantPath: null,
      pathPassthrough: false,
      providerAuthorization: 'Bearer provider-token',
      fetchImpl,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://other.example/redirected');
    expect(calls).toEqual(['https://remote.example/mcp']);
  });

  it('rejects encoded dot-segment descendants', async () => {
    const fetchImpl: typeof fetch = async input => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
        return new Response(JSON.stringify({ Answer: [{ data: '8.8.8.8' }] }), {
          status: 200,
        });
      }
      return new Response('upstream-body', { status: 200 });
    };
    await expect(
      proxyUpstream({
        env: {} as Env,
        request: new Request('https://mcp.kilosessions.ai/mcp-connect/user/u/c/r'),
        remoteUrl: 'https://remote.example/base',
        descendantPath: '/%2e%2e/admin',
        pathPassthrough: true,
        fetchImpl,
      })
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects an upstream with a private AAAA answer even when A is public', async () => {
    const fetchImpl: typeof fetch = async input => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('type=AAAA')) {
        return new Response(JSON.stringify({ Answer: [{ data: 'fd00::1' }] }), { status: 200 });
      }
      if (url.includes('type=A')) {
        return new Response(JSON.stringify({ Answer: [{ data: '8.8.8.8' }] }), {
          status: 200,
        });
      }
      return new Response('upstream-body', { status: 200 });
    };
    await expect(
      proxyUpstream({
        env: {} as Env,
        request: new Request('https://mcp.kilosessions.ai/mcp-connect/user/u/c/r'),
        remoteUrl: 'https://remote.example/mcp',
        descendantPath: null,
        pathPassthrough: false,
        fetchImpl,
      })
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('validates one hostname through DNS once within the cache window', async () => {
    let dnsCalls = 0;
    const fetchImpl: typeof fetch = async input => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
        dnsCalls += 1;
        return new Response(JSON.stringify({ Answer: [{ data: '8.8.8.8' }] }), { status: 200 });
      }
      return new Response('upstream-body', { status: 200 });
    };
    const baseParams = {
      env: {} as Env,
      request: new Request('https://mcp.kilosessions.ai/mcp-connect/user/u/c/r'),
      descendantPath: null,
      pathPassthrough: false,
      fetchImpl,
    } as const;

    const first = await proxyUpstream({ ...baseParams, remoteUrl: 'https://cached.example/mcp' });
    const second = await proxyUpstream({
      ...baseParams,
      remoteUrl: 'https://cached.example/other',
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(dnsCalls).toBe(2);
  });

  it('re-validates a hostname after the DNS cache entry expires', async () => {
    let dnsCalls = 0;
    const fetchImpl: typeof fetch = async input => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
        dnsCalls += 1;
        return new Response(JSON.stringify({ Answer: [{ data: '8.8.8.8' }] }), { status: 200 });
      }
      return new Response('upstream-body', { status: 200 });
    };
    const baseParams = {
      env: {} as Env,
      request: new Request('https://mcp.kilosessions.ai/mcp-connect/user/u/c/r'),
      descendantPath: null,
      pathPassthrough: false,
      fetchImpl,
    } as const;

    await proxyUpstream({ ...baseParams, remoteUrl: 'https://expiring.example/mcp' });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 31_000);
    try {
      await proxyUpstream({ ...baseParams, remoteUrl: 'https://expiring.example/mcp' });
    } finally {
      vi.useRealTimers();
    }

    expect(dnsCalls).toBe(4);
  });

  it('caches a failed validation for the hostname within the window', async () => {
    let dnsCalls = 0;
    const fetchImpl: typeof fetch = async input => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
        dnsCalls += 1;
        if (url.includes('type=AAAA')) {
          return new Response(JSON.stringify({ Answer: [{ data: 'fd00::1' }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ Answer: [{ data: '8.8.8.8' }] }), { status: 200 });
      }
      return new Response('upstream-body', { status: 200 });
    };
    const baseParams = {
      env: {} as Env,
      request: new Request('https://mcp.kilosessions.ai/mcp-connect/user/u/c/r'),
      descendantPath: null,
      pathPassthrough: false,
      fetchImpl,
    } as const;

    await expect(
      proxyUpstream({ ...baseParams, remoteUrl: 'https://blocked.example/mcp' })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      proxyUpstream({ ...baseParams, remoteUrl: 'https://blocked.example/other' })
    ).rejects.toMatchObject({ code: 'invalid_request' });

    expect(dnsCalls).toBe(2);
  });

  it('rethrows the specific failure reason on a cached failed validation', async () => {
    clearDnsCacheForTests();
    let dnsCalls = 0;
    const fetchImpl: typeof fetch = async input => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
        dnsCalls += 1;
        if (url.includes('type=AAAA')) {
          return new Response(JSON.stringify({ Answer: [{ data: 'fd00::1' }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ Answer: [{ data: '8.8.8.8' }] }), { status: 200 });
      }
      return new Response('upstream-body', { status: 200 });
    };

    await expect(
      validateResolvedPublicUrl('https://reason.example/mcp', fetchImpl)
    ).rejects.toMatchObject({ message: 'Upstream resolves to a private destination' });
    await expect(
      validateResolvedPublicUrl('https://reason.example/other', fetchImpl)
    ).rejects.toMatchObject({ message: 'Upstream resolves to a private destination' });

    expect(dnsCalls).toBe(2);
  });
});
