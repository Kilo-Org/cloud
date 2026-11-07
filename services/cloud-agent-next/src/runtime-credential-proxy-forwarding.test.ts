import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeProxyGrant,
  issueRuntimeCredentialProxyHandle,
} from './runtime-credential-proxy.js';
import type { RuntimeCredentialProxyOrigin } from './runtime-credential-proxy-origin.js';
import {
  forwardRuntimeCredentialProxy,
  matchRuntimeCredentialProxyRequest,
  RUNTIME_PROXY_ORIGIN_REQUIRED,
  runtimeProxyOriginRequiredResponse,
} from './runtime-credential-proxy-forwarding.js';
import { RUNTIME_PROXY_ATTESTATION_HEADER } from '@kilocode/worker-utils/runtime-proxy-attestation';
import type { Env } from './types.js';

const secret = 'test-secret';
const sessionId = 'workspace_11111111-1111-4111-8111-111111111111';
const kiloSessionId = 'ses_12345678901234567890123456';
const child = 'ses_abcdefghijklmnopqrstuvwxyz';
const backingToken = 'https://api.kilo.ai:backing-token';
const runtimeAuthorization = {
  userId: 'usr_proxy',
  authorizationId: '11111111-1111-4111-8111-111111111111',
  resourceId: sessionId,
};

type Resolve = ReturnType<typeof vi.fn>;

function createEnv(resolve: Resolve): Env {
  return {
    NEXTAUTH_SECRET: secret,
    WORKER_URL: 'https://worker.test',
    KILOCODE_BACKEND_BASE_URL: 'https://backend.example.test',
    KILO_OPENROUTER_BASE: 'https://api.kilo.ai',
    KILO_SESSION_INGEST_URL: 'https://ingest.example.test',
    SANDBOX_SESSION: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ resolveOriginBoundRuntimeCredentialProxyGrant: resolve })),
    },
    INTERNAL_API_SECRET_PROD: { get: vi.fn().mockResolvedValue('internal-secret') },
    SESSION_INGEST: { fetch: vi.fn() },
  } as unknown as Env;
}

async function handle(): Promise<string> {
  return issueRuntimeCredentialProxyHandle(
    { NEXTAUTH_SECRET: secret } as never,
    createRuntimeProxyGrant({
      plane: 'control',
      authorizationId: runtimeAuthorization.authorizationId,
      sessionId,
      kiloSessionId,
      userId: runtimeAuthorization.userId,
      orgId: 'org_proxy',
      mode: 'contained',
      allocationId: 'allocation_proxy',
      providerInstanceId: 'provider_proxy',
      connectionId: 'connection_proxy',
      wrapperInstanceId: 'wrapper_proxy',
      leaseExpiresAt: Date.now() + 60_000,
      state: 'active',
    })
  );
}

function resolveImpl() {
  return vi.fn().mockResolvedValue({
    token: backingToken,
    organizationId: 'org_proxy',
    runtimeAuthorization,
  });
}

function nativeOrigin(): RuntimeCredentialProxyOrigin {
  return {
    type: 'cloudflare-containers',
    containerId: 'container_1',
    allocationRef: 'provider_proxy',
  };
}

describe('native runtime proxy request matching', () => {
  it('matches only the configured facade authority and strips its prefix', async () => {
    const env = createEnv(resolveImpl());
    await expect(
      matchRuntimeCredentialProxyRequest(
        new Request('https://worker.test/runtime/api/profile?x=1'),
        { WORKER_URL: 'https://worker.test/runtime' }
      )
    ).resolves.toEqual({ route: 'backend', path: '/api/profile', search: '?x=1' });
    await expect(
      matchRuntimeCredentialProxyRequest(new Request('https://foreign.test/api/profile'), {
        WORKER_URL: 'https://worker.test/runtime',
      })
    ).resolves.toBeNull();
    await expect(
      matchRuntimeCredentialProxyRequest(new Request('https://worker.test/api/profile'), {
        WORKER_URL: 'https://worker.test/runtime',
      })
    ).resolves.toBeNull();
    await expect(
      matchRuntimeCredentialProxyRequest(new Request('https://worker.test/not-api'), {
        WORKER_URL: 'https://worker.test',
      })
    ).resolves.toBeNull();
    void env;
  });

  it('uses the reserved default-port client authority only for a local HTTP Worker', async () => {
    await expect(
      matchRuntimeCredentialProxyRequest(
        new Request('http://runtime-credential-proxy.invalid/runtime/api/openrouter/models'),
        { WORKER_URL: 'http://localhost:8794/runtime' }
      )
    ).resolves.toEqual({
      route: 'provider',
      path: '/api/openrouter/models',
      search: '',
    });
    await expect(
      matchRuntimeCredentialProxyRequest(
        new Request('http://localhost:8794/runtime/api/openrouter/models'),
        { WORKER_URL: 'http://localhost:8794/runtime' }
      )
    ).resolves.toBeNull();
    await expect(
      matchRuntimeCredentialProxyRequest(
        new Request('http://runtime-credential-proxy.invalid/api/profile'),
        { WORKER_URL: 'https://worker.test' }
      )
    ).resolves.toBeNull();
  });
});

describe('authenticated runtime proxy forwarding', () => {
  it('admits the origin and replaces provider proofs with the backing credential', async () => {
    const resolve = resolveImpl();
    const env = createEnv(resolve);
    const upstream = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', upstream);
    try {
      const response = await forwardRuntimeCredentialProxy(
        new Request('https://worker.test/api/gateway/chat/completions?x=1', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await handle()}`,
            'content-type': 'application/json',
            'vercel-sandbox-oidc-token': 'forged-oidc',
            'vercel-forwarded-host': 'worker.test',
            'x-forwarded-for': '1.2.3.4',
            'x-kilo-unknown': 'drop',
            'x-kilocode-feature': 'chat',
            Connection: 'x-hop',
            'x-hop': 'drop',
          },
          body: '{}',
        }),
        env,
        { route: 'provider', path: '/api/gateway/chat/completions', search: '?x=1' },
        nativeOrigin()
      );
      expect(response.status).toBe(200);
      expect(resolve).toHaveBeenCalledWith({
        handle: expect.any(String),
        origin: nativeOrigin(),
      });
      const [request] = upstream.mock.calls[0] as [Request];
      expect(new URL(request.url).href).toBe(
        'https://api.kilo.ai/api/gateway/chat/completions?x=1'
      );
      expect(request.headers.get('Authorization')).toBe(`Bearer ${backingToken}`);
      expect(request.headers.get('X-Kilocode-OrganizationId')).toBe('org_proxy');
      expect(request.headers.get('vercel-sandbox-oidc-token')).toBeNull();
      expect(request.headers.get('vercel-forwarded-host')).toBeNull();
      expect(request.headers.get('x-forwarded-for')).toBeNull();
      expect(request.headers.get('x-kilo-unknown')).toBeNull();
      expect(request.headers.get('x-kilocode-feature')).toBe('chat');
      expect(request.headers.get('x-hop')).toBeNull();
      expect(request.headers.get(RUNTIME_PROXY_ATTESTATION_HEADER)).toBeTruthy();
      expect(await request.text()).toBe('{}');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never falls back to an unbound resolver', async () => {
    const resolve = vi.fn().mockResolvedValue(null);
    const legacy = vi.fn();
    const env = createEnv(resolve);
    (env.SANDBOX_SESSION.get as Resolve).mockReturnValue({
      resolveOriginBoundRuntimeCredentialProxyGrant: resolve,
      resolveRuntimeCredentialProxyGrant: legacy,
    });
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    try {
      const response = await forwardRuntimeCredentialProxy(
        new Request('https://worker.test/api/profile', {
          headers: { Authorization: `Bearer ${await handle()}` },
        }),
        env,
        { route: 'backend', path: '/api/profile', search: '' },
        nativeOrigin()
      );
      expect(response.status).toBe(401);
      expect(legacy).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects invalid handles and endpoint allowlist violations before resolving', async () => {
    const resolve = resolveImpl();
    const env = createEnv(resolve);
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    try {
      const invalid = await forwardRuntimeCredentialProxy(
        new Request('https://worker.test/api/profile', {
          headers: { Authorization: 'Bearer invalid' },
        }),
        env,
        { route: 'backend', path: '/api/profile', search: '' },
        nativeOrigin()
      );
      expect(invalid.status).toBe(401);
      const forbidden = await forwardRuntimeCredentialProxy(
        new Request('https://worker.test/api/not-allowed', {
          headers: { Authorization: `Bearer ${await handle()}` },
        }),
        env,
        { route: 'backend', path: '/api/not-allowed', search: '' },
        nativeOrigin()
      );
      expect(forbidden.status).toBe(404);
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('bounds the ingest create body and preserves its exact payload', async () => {
    const resolve = resolveImpl();
    const env = createEnv(resolve);
    const upstream = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', upstream);
    try {
      const tooLarge = await forwardRuntimeCredentialProxy(
        new Request('https://worker.test/api/session', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await handle()}`,
            'content-type': 'application/json',
          },
          body: ' '.repeat(8193),
        }),
        env,
        { route: 'ingest', path: '/api/session', search: '' },
        nativeOrigin()
      );
      expect(tooLarge.status).toBe(404);
      expect(upstream).not.toHaveBeenCalled();
      const body = JSON.stringify({ sessionId: kiloSessionId });
      const accepted = await forwardRuntimeCredentialProxy(
        new Request('https://worker.test/api/session', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await handle()}`,
            'content-type': 'application/json',
          },
          body,
        }),
        env,
        { route: 'ingest', path: '/api/session', search: '' },
        nativeOrigin()
      );
      expect(accepted.status).toBe(200);
      const [request] = upstream.mock.calls[0] as [Request];
      expect(await request.text()).toBe(body);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the v1 scope forwarder for an authorized child ingest', async () => {
    const resolve = vi.fn().mockResolvedValue({
      token: backingToken,
      organizationId: 'org_proxy',
      runtimeAuthorization,
    });
    const env = createEnv(resolve);
    const ingest = vi.fn().mockResolvedValue(new Response('scoped'));
    env.SESSION_INGEST.fetch = ingest;
    const response = await forwardRuntimeCredentialProxy(
      new Request(`https://worker.test/api/session/${child}/ingest`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await handle()}`,
          'content-type': 'application/json',
        },
        body: '{}',
      }),
      env,
      { route: 'ingest', path: `/api/session/${child}/ingest`, search: '?v=1' },
      nativeOrigin()
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('scoped');
    const [request] = ingest.mock.calls[0] as [Request];
    expect(new URL(request.url).href).toBe(
      `https://ingest.example.test/internal/cloud-agent/v1/session/${child}/ingest?v=1`
    );
    expect(request.headers.get('X-Internal-Secret')).toBe('internal-secret');
    expect(request.headers.get('Authorization')).toBe(`Bearer ${backingToken}`);
  });

  it('uses the v2 scope forwarder when the adopted scope view is present', async () => {
    const scopeId = 'worktree_11111111-1111-4111-8111-111111111111';
    const resolve = vi.fn().mockResolvedValue({
      token: backingToken,
      organizationId: 'org_proxy',
      runtimeAuthorization,
      scopeView: {
        scopeId,
        expectedOrganizationId: '22222222-2222-4222-8222-222222222222',
        memberRootKiloSessionIds: [kiloSessionId],
      },
    });
    const env = createEnv(resolve);
    const ingest = vi.fn().mockResolvedValue(new Response('scoped-v2'));
    env.SESSION_INGEST.fetch = ingest;
    const response = await forwardRuntimeCredentialProxy(
      new Request(`https://worker.test/api/session/${child}/title`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await handle()}` },
        body: '{}',
      }),
      env,
      { route: 'ingest', path: `/api/session/${child}/title`, search: '' },
      nativeOrigin()
    );
    expect(response.status).toBe(200);
    const [request] = ingest.mock.calls[0] as [Request];
    expect(new URL(request.url).href).toBe(
      `https://ingest.example.test/internal/cloud-agent/v1/session/${child}/title`
    );
    expect(request.headers.get('X-Internal-Secret')).toBe('internal-secret');
  });

  it('streams the upstream response and strips provider/hop-by-hop response headers', async () => {
    const resolve = resolveImpl();
    const env = createEnv(resolve);
    const encoder = new TextEncoder();
    const upstream = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('first'));
            controller.enqueue(encoder.encode('second'));
            controller.close();
          },
        }),
        {
          headers: {
            'content-type': 'text/plain',
            'set-cookie': 'session=secret',
            'x-vercel-id': 'iad1::abc',
            connection: 'x-response-hop',
            'x-response-hop': 'drop',
            [RUNTIME_PROXY_ATTESTATION_HEADER]: 'upstream-proof',
          },
        }
      )
    );
    vi.stubGlobal('fetch', upstream);
    try {
      const response = await forwardRuntimeCredentialProxy(
        new Request('https://worker.test/api/profile', {
          headers: { Authorization: `Bearer ${await handle()}` },
        }),
        env,
        { route: 'backend', path: '/api/profile', search: '' },
        nativeOrigin()
      );
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('x-response-hop')).toBeNull();
      expect(response.headers.get(RUNTIME_PROXY_ATTESTATION_HEADER)).toBeNull();
      await expect(response.text()).resolves.toBe('firstsecond');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('preserves manual redirects and request aborts', async () => {
    const resolve = resolveImpl();
    const env = createEnv(resolve);
    const redirect = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: '/next' } }));
    vi.stubGlobal('fetch', redirect);
    try {
      const response = await forwardRuntimeCredentialProxy(
        new Request('https://worker.test/api/profile', {
          headers: { Authorization: `Bearer ${await handle()}` },
        }),
        env,
        { route: 'backend', path: '/api/profile', search: '' },
        nativeOrigin()
      );
      expect(response.status).toBe(302);
      expect(redirect.mock.calls[0]?.[1]).toEqual({ redirect: 'manual' });
    } finally {
      vi.unstubAllGlobals();
    }

    const controller = new AbortController();
    controller.abort();
    const aborted = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    vi.stubGlobal('fetch', aborted);
    try {
      const response = await forwardRuntimeCredentialProxy(
        new Request('https://worker.test/api/profile', {
          headers: { Authorization: `Bearer ${await handle()}` },
          signal: controller.signal,
        }),
        env,
        { route: 'backend', path: '/api/profile', search: '' },
        nativeOrigin()
      );
      expect(response.status).toBe(502);
      const [request] = aborted.mock.calls[0] as [Request];
      expect(request.signal.aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns 503 when origin-bound admission is unavailable', async () => {
    const resolve = vi.fn().mockRejectedValue(new Error('unavailable'));
    const env = createEnv(resolve);
    const response = await forwardRuntimeCredentialProxy(
      new Request('https://worker.test/api/profile', {
        headers: { Authorization: `Bearer ${await handle()}` },
      }),
      env,
      { route: 'backend', path: '/api/profile', search: '' },
      nativeOrigin()
    );
    expect(response.status).toBe(503);
  });

  it('keeps the exact exa allowlist on the backend target', async () => {
    const resolve = resolveImpl();
    const env = createEnv(resolve);
    const upstream = vi.fn().mockResolvedValue(new Response('exa'));
    vi.stubGlobal('fetch', upstream);
    try {
      const response = await forwardRuntimeCredentialProxy(
        new Request('https://worker.test/api/exa/search', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await handle()}`,
            'content-type': 'application/json',
          },
          body: '{}',
        }),
        env,
        { route: 'exa', path: '/api/exa/search', search: '' },
        nativeOrigin()
      );
      expect(response.status).toBe(200);
      const [request] = upstream.mock.calls[0] as [Request];
      expect(new URL(request.url).href).toBe('https://backend.example.test/api/exa/search');
      const rejected = await forwardRuntimeCredentialProxy(
        new Request('https://worker.test/api/exa/unknown', {
          method: 'POST',
          headers: { Authorization: `Bearer ${await handle()}` },
        }),
        env,
        { route: 'exa', path: '/api/exa/unknown', search: '' },
        nativeOrigin()
      );
      expect(rejected.status).toBe(404);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to the loopback facade targets for a local Worker', async () => {
    const resolve = vi.fn().mockResolvedValue({
      token: 'backing-token',
      runtimeAuthorization,
    });
    const env = {
      ...createEnv(resolve),
      WORKER_URL: 'http://host.docker.internal:8794',
      KILOCODE_BACKEND_BASE_URL: 'http://host.docker.internal:8794',
      KILO_OPENROUTER_BASE: 'http://host.docker.internal:8794',
      KILO_SESSION_INGEST_URL: 'http://host.docker.internal:8794',
    } as Env;
    const upstream = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', upstream);
    try {
      const response = await forwardRuntimeCredentialProxy(
        new Request('http://runtime-credential-proxy.invalid/api/profile', {
          headers: { Authorization: `Bearer ${await handle()}` },
        }),
        env,
        { route: 'backend', path: '/api/profile', search: '' },
        nativeOrigin()
      );
      expect(response.status).toBe(200);
      const [request] = upstream.mock.calls[0] as [Request];
      expect(new URL(request.url).href).toBe('http://127.0.0.1:8794/api/profile');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('origin-required response', () => {
  it('is an exact 403 marker', async () => {
    const response = runtimeProxyOriginRequiredResponse();
    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe(RUNTIME_PROXY_ORIGIN_REQUIRED);
  });
});
