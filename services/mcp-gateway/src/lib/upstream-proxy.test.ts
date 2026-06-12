import { describe, expect, it } from 'vitest';
import { proxyUpstream } from './upstream-proxy';

describe('proxyUpstream', () => {
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
});
