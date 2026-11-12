import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import { Hono } from 'hono';
import type { HonoContext } from '../hono-context.js';
import { handleVercelScmForward, registerVercelScmBrokerRoute } from './vercel-route.js';
import type { admitVercelScmForwardAtLocator } from './vercel-admission.js';

const env = {
  GIT_TOKEN_SERVICE: {
    redeemGitHubSessionCapability: vi.fn(async () => ({
      success: true,
      authorization: 'Bearer synthetic-upstream-token',
      source: 'installation',
      appType: 'standard',
    })),
  },
} as unknown as Env;

function forwarded(
  path = '/acme/repo.git/info/refs?service=git-upload-pack',
  init: RequestInit = {}
) {
  return new Request('https://worker.test/scm/vercel/sbx-test', {
    ...init,
    headers: {
      'vercel-forwarded-host': 'github.com',
      'vercel-forwarded-scheme': 'https',
      'vercel-forwarded-port': '443',
      'vercel-forwarded-path': path,
      'vercel-sandbox-oidc-token': 'synthetic-oidc-token',
      ...Object.fromEntries(new Headers(init.headers)),
    },
  });
}

const admitManaged = vi.fn<typeof admitVercelScmForwardAtLocator>(async () => ({
  ok: true,
  authority: {
    type: 'managed',
    provider: 'github',
    capability: 'kgh3.resolved',
    outboundContainerId: 'binding-test',
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('prepared Vercel forwarding route', () => {
  it.each([
    ['PATCH', '/repos/acme/repo/issues/1', null, 200],
    ['DELETE', '/repos/acme/repo/git/refs/heads/task', null, 200],
    [
      'POST',
      '/graphql',
      '{"query":"query { repository(owner: \\"acme\\", name: \\"repo\\") { id } }"}',
      200,
    ],
    ['GET', '/repos/foreign/private', null, 403],
    ['DELETE', '/orgs/acme/members/octocat', null, 403],
    [
      'POST',
      '/graphql',
      '{"query":"query { organization(login: \\"acme\\") { membersWithRole { totalCount } } }"}',
      403,
    ],
  ])(
    'routes %s %s while the synthetic upstream owns repository and organization denial',
    async (method, path, body, status) => {
      const fetch = vi.fn(async (request: Request) => {
        expect(request.headers.get('authorization')).toBe('Bearer synthetic-upstream-token');
        expect(request.method).toBe(method);
        const content = request.body ? await request.text() : '';
        const url = new URL(request.url);
        const allowed =
          url.pathname.startsWith('/repos/acme/repo/') ||
          (url.pathname === '/graphql' &&
            content.includes('repository(') &&
            !content.includes('organization('));
        return new Response(allowed ? 'selected repository' : 'upstream permission denied', {
          status: allowed ? 200 : 403,
        });
      });
      vi.stubGlobal('fetch', fetch);
      const response = await handleVercelScmForward(
        forwarded(path, {
          method,
          body,
          headers: {
            'vercel-forwarded-host': 'api.github.com',
            Authorization: 'Bearer kcp1.original-alias',
          },
        }),
        env,
        'sbx-test',
        admitManaged
      );
      expect(response.status).toBe(status);
      expect(fetch).toHaveBeenCalledOnce();
      expect(admitManaged).toHaveBeenCalledOnce();
    }
  );

  it.each([
    [
      '/scm/vercel/sbx-test',
      'github.com',
      '443',
      '/acme/repo.git/info/refs?service=git-upload-pack',
    ],
    [
      '/scm/vercel/sbx-test/acme/repo.git/info/refs?untrusted=1',
      'github.com',
      '443',
      '/acme/repo.git/info/refs?service=git-upload-pack',
    ],
    [
      '/scm/vercel/sbx-test/repos/acme/repo/issues?untrusted=1',
      'api.github.com',
      '443',
      '/repos/acme/repo/issues?state=open',
    ],
    [
      '/scm/vercel/sbx-test/gitlab/acme/repo.git/info/refs?untrusted=1',
      'gitlab.example',
      '8443',
      '/gitlab/acme/repo.git/info/refs?service=git-upload-pack',
    ],
  ])(
    'admits the configured locator through registered route %s',
    async (route, host, port, path) => {
      const admitScmForward = vi.fn(async () => ({ ok: true, authority: { type: 'unmanaged' } }));
      const getByName = vi.fn(() => ({ admitScmForward }));
      const bindings = { ...env, SANDBOX_CONTROL: { getByName } } as unknown as Env;
      const app = new Hono<HonoContext>();
      registerVercelScmBrokerRoute(app);
      const target = `https://${host}${port === '443' ? '' : `:${port}`}${path}`;
      const fetch = vi.fn(async (request: Request) => {
        expect(request.url).toBe(target);
        // A GitHub task read is rebuilt without the guest's headers, so fetch derives the host.
        if (host === 'gitlab.example')
          expect(request.headers.get('host')).toBe(new URL(target).host);
        return new Response('ok');
      });
      vi.stubGlobal('fetch', fetch);
      const request = new Request(
        `https://worker.test${route}`,
        forwarded(path, {
          headers: { 'vercel-forwarded-host': host, 'vercel-forwarded-port': port },
        })
      );
      const response = await app.fetch(request, bindings);
      expect(response.status).toBe(200);
      expect(getByName).toHaveBeenCalledWith('sbx-test');
      expect(admitScmForward).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          target: { url: target, method: 'GET' },
        })
      );
      expect(fetch).toHaveBeenCalledOnce();
    }
  );

  it('rejects caller-owned credentials for GitHub task destinations', async () => {
    const admit = vi.fn<typeof admitVercelScmForwardAtLocator>(async () => ({
      ok: true,
      authority: { type: 'unmanaged' },
    }));
    const fetch = vi.fn(async () => new Response('forwarded'));
    vi.stubGlobal('fetch', fetch);
    const response = await handleVercelScmForward(
      forwarded(undefined, {
        headers: { Authorization: 'Bearer caller-owned', Host: 'forged.test' },
      }),
      env,
      'sbx-test',
      admit
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Basic realm="GitHub task"');
    expect(fetch).not.toHaveBeenCalled();
    expect(env.GIT_TOKEN_SERVICE.redeemGitHubSessionCapability).not.toHaveBeenCalled();
  });

  it('forwards anonymous GitHub task reads without managed redemption', async () => {
    const admit = vi.fn<typeof admitVercelScmForwardAtLocator>(async () => ({
      ok: true,
      authority: { type: 'unmanaged' },
    }));
    const fetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe(
        'https://github.com/acme/repo.git/info/refs?service=git-upload-pack'
      );
      expect(request.headers.has('authorization')).toBe(false);
      expect([...request.headers.keys()].some(key => key.startsWith('vercel-'))).toBe(false);
      expect(request.headers.has('x-forwarded-host')).toBe(false);
      expect(request.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { Location: 'https://foreign.test' } });
    });
    vi.stubGlobal('fetch', fetch);
    const response = await handleVercelScmForward(
      forwarded(undefined, { headers: { 'x-forwarded-host': 'forged.test' } }),
      env,
      'sbx-test',
      admit
    );
    expect(response.status).toBe(302);
    expect(fetch).toHaveBeenCalledOnce();
    expect(env.GIT_TOKEN_SERVICE.redeemGitHubSessionCapability).not.toHaveBeenCalled();
    expect(admit.mock.calls[0]?.[1]).toBe('sbx-test');
  });

  it('uses the admitted capability, never the incoming alias, for upstream redemption', async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.headers.get('authorization')).toBe('Bearer synthetic-upstream-token');
      expect(request.headers.has('vercel-sandbox-oidc-token')).toBe(false);
      return new Response('ok');
    });
    vi.stubGlobal('fetch', fetch);
    const response = await handleVercelScmForward(
      forwarded('/acme/repo.git/git-receive-pack', {
        method: 'POST',
        body: 'synthetic-pack',
        headers: { Authorization: 'Bearer kcp1.original-alias' },
      }),
      env,
      'sbx-test',
      admitManaged
    );
    expect(response.status).toBe(200);
    expect(env.GIT_TOKEN_SERVICE.redeemGitHubSessionCapability).toHaveBeenCalledExactlyOnceWith({
      capability: 'kgh3.resolved',
      outboundContainerId: 'binding-test',
      requestMethod: 'POST',
      requestUrl: 'https://github.com/acme/repo.git/git-receive-pack',
      requestContentType: 'text/plain;charset=UTF-8',
    });
  });

  it('streams 2,097,169 bytes above the replay cap once, without reading the whole body before fetch', async () => {
    const size = 2_097_169;
    let generated = 0;
    let received = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (generated === size) return controller.close();
        const bytes = new Uint8Array(Math.min(64 * 1024, size - generated));
        bytes.fill(7);
        generated += bytes.length;
        controller.enqueue(bytes);
      },
    });
    const fetch = vi.fn(async (request: Request) => {
      expect(generated).toBeLessThan(size);
      const reader = request.body!.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new Error('Unexpected stream chunk');
        expect(value.every(byte => byte === 7)).toBe(true);
        received += value.byteLength;
      }
      return new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } });
    });
    vi.stubGlobal('fetch', fetch);
    const init = { method: 'POST', body, duplex: 'half' } as RequestInit;
    const app = new Hono<HonoContext>();
    registerVercelScmBrokerRoute(app);
    const bindings = {
      ...env,
      SANDBOX_CONTROL: {
        getByName: () => ({
          admitScmForward: async () => ({
            ok: true,
            authority: {
              type: 'managed',
              provider: 'github',
              capability: 'kgh3.resolved',
              outboundContainerId: 'binding-test',
            },
          }),
        }),
      },
    } as unknown as Env;
    const response = await app.fetch(
      new Request(
        'https://worker.test/scm/vercel/sbx-test/acme/repo.git/git-upload-pack',
        forwarded('/acme/repo.git/git-upload-pack', init)
      ),
      bindings
    );
    expect(response.status).toBe(429);
    expect(received).toBe(size);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('never fetches before admission and returns its specific failure', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const admit = vi.fn<typeof admitVercelScmForwardAtLocator>(async () => ({
      ok: false,
      status: 503,
      code: 'provider_identity_mismatch',
    }));
    const response = await handleVercelScmForward(forwarded(), env, 'sbx-test', admit);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'provider_identity_mismatch' });
    expect(fetch).not.toHaveBeenCalled();
    expect(env.GIT_TOKEN_SERVICE.redeemGitHubSessionCapability).not.toHaveBeenCalled();
  });

  it.each<Record<string, string>>([
    { 'vercel-forwarded-host': 'github.com@foreign.test' },
    { 'vercel-forwarded-host': '127.0.0.1:443' },
    { 'vercel-forwarded-scheme': 'http' },
    { 'vercel-forwarded-port': '0' },
    { 'vercel-forwarded-port': '65536' },
    { 'vercel-forwarded-port': '-1' },
    { 'vercel-forwarded-port': '0443' },
    { 'vercel-forwarded-port': '443,8443' },
    { 'vercel-forwarded-path': '/\\foreign.test' },
    { 'vercel-forwarded-path': '/repo#fragment' },
  ])('rejects malformed origin metadata: %j', async headers => {
    const response = await handleVercelScmForward(
      forwarded(undefined, { headers }),
      env,
      'sbx-test',
      admitManaged
    );
    expect(response.status).toBe(401);
    expect(admitManaged).not.toHaveBeenCalled();
  });
});
