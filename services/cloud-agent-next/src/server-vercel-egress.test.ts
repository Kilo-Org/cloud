import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxEgressAdmissionResult } from './egress/egress-admission.js';
import {
  createRuntimeProxyGrant,
  issueRuntimeCredentialProxyHandle,
} from './runtime-credential-proxy.js';
import worker from './server.js';
import type { Env } from './types.js';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

// The real Worker entry: its global middlewares run before the egress route.
const WORKER_URL = 'https://worker.example.com';
const NEXTAUTH_SECRET = 'server-vercel-egress-test-secret';
const SANDBOX_ID = 'sbx-entry-test';
const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

function workerEnv(admission: SandboxEgressAdmissionResult) {
  const admitEgressForward = vi.fn(async () => admission);
  const env = {
    WORKER_URL,
    NEXTAUTH_SECRET,
    SANDBOX_CONTROL: { getByName: () => ({ admitEgressForward }) },
  } as unknown as Env;
  return { env, admitEgressForward };
}

/** A request as Vercel forwards it: the target path and query follow the route path. */
function forwardedRequest(target: URL, oidcToken: string, authorization: string): Request {
  return new Request(`${WORKER_URL}/scm/vercel/${SANDBOX_ID}${target.pathname}${target.search}`, {
    headers: {
      authorization,
      'vercel-sandbox-oidc-token': oidcToken,
      'vercel-forwarded-scheme': 'https',
      'vercel-forwarded-host': target.hostname,
      'vercel-forwarded-port': '443',
      'vercel-forwarded-path': `${target.pathname}${target.search}`,
    },
  });
}

/** Every line the logger writes, as text. The logger writes each line with `console.log`. */
function captureLogs(): () => string {
  const lines: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(arg => JSON.stringify(arg) ?? String(arg)).join(' '));
    });
  return () => lines.join('\n');
}

function stubUpstream() {
  const upstream = vi.fn(async (_request: Request) => new Response('upstream'));
  vi.stubGlobal('fetch', upstream);
  return upstream;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fetchSecretTarget(admission: SandboxEgressAdmissionResult) {
  stubUpstream();
  const { env, admitEgressForward } = workerEnv(admission);
  const oidcToken = `oidc-secret-${crypto.randomUUID()}`;
  const target = new URL(
    'https://hooks.example.com/services/T0/B0/path-secret-4f2a?key=query-secret-9c1d'
  );
  const response = await worker.fetch(
    forwardedRequest(target, oidcToken, 'Bearer header-secret-7b3e'),
    env,
    executionContext
  );
  expect(admitEgressForward).toHaveBeenCalledOnce();
  return { response, oidcToken };
}

describe('Vercel egress through the Worker entry', () => {
  it('logs a refused request with the route, not its target, query or credentials', async () => {
    const logs = captureLogs();

    const { response, oidcToken } = await fetchSecretTarget({
      ok: false,
      status: 403,
      code: 'allocation_unavailable',
    });

    expect(response.status).toBe(403);
    const text = logs();
    expect(text).toContain('/scm/vercel/:sandboxId');
    for (const secret of [
      'path-secret-4f2a',
      'query-secret-9c1d',
      'header-secret-7b3e',
      oidcToken,
      '/services/',
      'key=',
    ])
      expect(text).not.toContain(secret);
  });

  it('writes no log line for a forwarded request', async () => {
    const logs = captureLogs();

    const { response } = await fetchSecretTarget({
      ok: true,
      policy: { allowlist: ['hooks.example.com'] },
      expiresAt: Date.now() + 60_000,
    });

    expect(response.status).toBe(200);
    expect(logs()).toBe('');
  });

  it('writes no routine log line for a request outside the egress route', async () => {
    const logs = captureLogs();
    const { env } = workerEnv({ ok: false, status: 403, code: 'allocation_unavailable' });

    const response = await worker.fetch(new Request(`${WORKER_URL}/health`), env, executionContext);

    expect(response.status).toBe(200);
    expect(logs()).toBe('');
  });

  it('sends a forwarded request with a runtime proxy handle to the egress route', async () => {
    const upstream = stubUpstream();
    const { env, admitEgressForward } = workerEnv({
      ok: true,
      policy: { allowlist: ['api.example.com'] },
      expiresAt: Date.now() + 60_000,
    });
    const handle = await issueRuntimeCredentialProxyHandle(
      { NEXTAUTH_SECRET },
      createRuntimeProxyGrant({
        plane: 'legacy',
        authorizationId: '11111111-1111-4111-8111-111111111111',
        sessionId: 'agent_1',
        kiloSessionId: 'kilo_1',
        userId: 'user_1',
        mode: 'contained',
        allocationId: 'allocation_1',
        instanceGeneration: 1,
        leaseExpiresAt: Date.now() + 60_000,
        state: 'active',
      })
    );

    const response = await worker.fetch(
      forwardedRequest(
        new URL('https://api.example.com/v1/items'),
        `oidc-${crypto.randomUUID()}`,
        `Bearer ${handle}`
      ),
      env,
      executionContext
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('upstream');
    expect(admitEgressForward).toHaveBeenCalledOnce();
    expect(upstream.mock.calls.map(([request]) => request.url)).toEqual([
      'https://api.example.com/v1/items',
    ]);
  });
});
