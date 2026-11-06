import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeProxyGrant,
  issueRuntimeCredentialProxyHandle,
} from './runtime-credential-proxy.js';
import { handleVercelRuntimeCredentialProxy } from './runtime-credential-proxy-vercel.js';
import { RUNTIME_PROXY_ORIGIN_REQUIRED } from './runtime-credential-proxy-forwarding.js';
import type { Env } from './types.js';

const secret = 'test-secret';
const sessionId = 'workspace_11111111-1111-4111-8111-111111111111';
const kiloSessionId = 'ses_12345678901234567890123456';
const sandboxId = 'ses-abcdef';
const backingToken = 'https://api.kilo.ai:backing-token';
const runtimeAuthorization = {
  userId: 'usr_proxy',
  authorizationId: '11111111-1111-4111-8111-111111111111',
  resourceId: sessionId,
};

function createEnv(resolve: ReturnType<typeof vi.fn>): Env {
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

function vercelRequest(
  authorization: string,
  headers: Record<string, string> = {},
  url = `https://worker.test/runtime-credential-proxy/vercel/${sandboxId}`
): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'vercel-sandbox-oidc-token': 'oidc-token',
      'vercel-forwarded-host': 'worker.test',
      'vercel-forwarded-scheme': 'https',
      'vercel-forwarded-port': '443',
      'vercel-forwarded-path': '/api/gateway/chat/completions?stream=true',
      'vercel-forwarded-proto': 'spoof-me',
      'x-forwarded-for': '203.0.113.1',
      ...headers,
    },
    body: '{}',
  });
}

describe('Vercel runtime proxy route', () => {
  it('admits the OIDC origin and forwards to the original request URL', async () => {
    const resolve = vi.fn().mockResolvedValue({
      token: backingToken,
      organizationId: 'org_proxy',
      runtimeAuthorization,
    });
    const env = createEnv(resolve);
    const upstream = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', upstream);
    try {
      const response = await handleVercelRuntimeCredentialProxy(
        vercelRequest(`Bearer ${await handle()}`),
        env,
        sandboxId
      );
      expect(response.status).toBe(200);
      expect(resolve).toHaveBeenCalledWith({
        handle: expect.any(String),
        origin: {
          type: 'vercel',
          oidcToken: 'oidc-token',
          logicalSandboxId: sandboxId,
        },
      });
      const [request] = upstream.mock.calls[0] as [Request];
      expect(new URL(request.url).href).toBe(
        'https://api.kilo.ai/api/gateway/chat/completions?stream=true'
      );
      expect(request.headers.get('Authorization')).toBe(`Bearer ${backingToken}`);
      expect(request.headers.get('vercel-sandbox-oidc-token')).toBeNull();
      expect(request.headers.get('vercel-forwarded-host')).toBeNull();
      expect(request.headers.get('vercel-forwarded-proto')).toBeNull();
      expect(request.headers.get('x-forwarded-for')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('requires the exact configured Worker authority', async () => {
    const resolve = vi.fn();
    const env = createEnv(resolve);
    const response = await handleVercelRuntimeCredentialProxy(
      vercelRequest(
        `Bearer ${await handle()}`,
        {},
        `https://foreign.test/runtime-credential-proxy/vercel/${sandboxId}`
      ),
      env,
      sandboxId
    );
    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe(RUNTIME_PROXY_ORIGIN_REQUIRED);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects a missing OIDC token with the origin-required marker', async () => {
    const resolve = vi.fn();
    const env = createEnv(resolve);
    const request = vercelRequest(`Bearer ${await handle()}`, {
      'vercel-sandbox-oidc-token': '',
    });
    const response = await handleVercelRuntimeCredentialProxy(request, env, sandboxId);
    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe(RUNTIME_PROXY_ORIGIN_REQUIRED);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects a foreign original host before resolving a credential', async () => {
    const resolve = vi.fn();
    const env = createEnv(resolve);
    const response = await handleVercelRuntimeCredentialProxy(
      vercelRequest(`Bearer ${await handle()}`, {
        'vercel-forwarded-host': 'evil.example.com',
      }),
      env,
      sandboxId
    );
    expect(response.status).toBe(404);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects malformed forward headers', async () => {
    const resolve = vi.fn();
    const env = createEnv(resolve);
    const malformed = await handleVercelRuntimeCredentialProxy(
      vercelRequest(`Bearer ${await handle()}`, { 'vercel-forwarded-path': '/api/\\evil' }),
      env,
      sandboxId
    );
    expect(malformed.status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('returns 401 when origin-bound admission denies the request', async () => {
    const resolve = vi.fn().mockResolvedValue(null);
    const env = createEnv(resolve);
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    try {
      const response = await handleVercelRuntimeCredentialProxy(
        vercelRequest(`Bearer ${await handle()}`),
        env,
        sandboxId
      );
      expect(response.status).toBe(401);
      expect(resolve).toHaveBeenCalledWith({
        handle: expect.any(String),
        origin: {
          type: 'vercel',
          oidcToken: 'oidc-token',
          logicalSandboxId: sandboxId,
        },
      });
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
