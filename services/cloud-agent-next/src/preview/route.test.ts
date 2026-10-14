import jwt from 'jsonwebtoken';
import { TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { getSandbox } from '@cloudflare/sandbox';
import { mintPreviewSessionToken, type PreviewClaims } from '../auth.js';
import type {
  PreviewProviderCoordinates,
  ResolvedPreviewTarget,
} from '../control-plane/sandbox/preview-target.js';
import { PREVIEW_COOKIE_NAME, PREVIEW_HOST_COOKIE_NAME } from '../shared/preview-headers.js';
import type { Env } from '../types.js';
import { PREVIEW_SESSION_MISSING_TEXT } from './container-port-fetch.js';
import {
  PREVIEW_ENTER_PATH,
  PREVIEW_TICKET_USED_TEXT,
  defaultFetchUpstream,
  handlePreviewOpen,
  handlePreviewRequest,
  type PreviewRouteDeps,
  type PreviewSessionStub,
} from './route.js';

const SECRET = 'test-secret';
const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const HEX = '11111111111141118111111111111111';
const PORT = 5173;
const LABEL = `p${PORT}-${HEX}`;
const SUFFIX = 'preview.test';
const HOST = `${LABEL}.${SUFFIX}`;
const ORIGIN = `http://${HOST}`;

const env = { NEXTAUTH_SECRET: SECRET, PREVIEW_HOST_SUFFIX: SUFFIX } as unknown as Env;

const CLOUDFLARE_TARGET: ResolvedPreviewTarget = {
  status: 'ok',
  coordinates: {
    provider: 'cloudflare',
    allocationName: 'ses-11111111111141118111111111111111',
    containment: false,
  },
};

const CONTAINERS_TARGET: ResolvedPreviewTarget = {
  status: 'ok',
  coordinates: {
    provider: 'cloudflare-containers',
    logicalSandboxId: 'workspace-container',
    allocationRef: 'allocation-ref',
  },
};

function entryTicket(overrides: Record<string, unknown> = {}): string {
  return jwt.sign(
    {
      type: 'stream_ticket',
      purpose: 'preview',
      userId: 'user-1',
      cloudAgentSessionId: SESSION_ID,
      port: PORT,
      nonce: 'nonce-1',
      ...overrides,
    },
    SECRET,
    { algorithm: 'HS256', expiresIn: 3600, audience: 'cloud-agent-preview' }
  );
}

function sessionToken(overrides: Partial<PreviewClaims> = {}): string {
  return mintPreviewSessionToken(
    {
      userId: 'user-1',
      cloudAgentSessionId: SESSION_ID,
      port: PORT,
      ...overrides,
    },
    SECRET
  );
}

function fixture(input: { target?: ResolvedPreviewTarget; accessError?: unknown } = {}) {
  const validateAccess = vi.fn(async () => {
    if (input.accessError !== undefined) throw input.accessError;
  });
  const resolvePreviewTarget = vi.fn(async () => input.target ?? CLOUDFLARE_TARGET);
  const stub: PreviewSessionStub = { resolvePreviewTarget };
  const getSessionStub = vi.fn(() => stub);
  const usedNonces = new Set<string>();
  const consumeTicketNonce = vi.fn(async (_env: Env, nonce: string, _expiresAtMs: number) => {
    if (usedNonces.has(nonce)) return false;
    usedNonces.add(nonce);
    return true;
  });
  const fetchUpstream = vi.fn(
    async () =>
      new Response('<h1>app</h1>', { status: 200, headers: { 'Content-Type': 'text/html' } })
  );
  const deps: PreviewRouteDeps = {
    validateAccess,
    getSessionStub,
    consumeTicketNonce,
    fetchUpstream,
  };
  return {
    deps,
    validateAccess,
    resolvePreviewTarget,
    getSessionStub,
    consumeTicketNonce,
    fetchUpstream,
  };
}

function entryRequest(ticket: string | null, init: RequestInit = {}): Request {
  const url =
    ticket === null
      ? `${ORIGIN}${PREVIEW_ENTER_PATH}`
      : `${ORIGIN}${PREVIEW_ENTER_PATH}?ticket=${ticket}`;
  return new Request(url, init);
}

function proxyRequest(
  token: string | null,
  init: RequestInit & { cookieName?: string } = {}
): Request {
  const secure = ORIGIN.startsWith('https:');
  const cookieName = init.cookieName ?? (secure ? PREVIEW_HOST_COOKIE_NAME : PREVIEW_COOKIE_NAME);
  const headers = new Headers(init.headers);
  if (token !== null) headers.set('Cookie', `${cookieName}=${token}`);
  return new Request(`${ORIGIN}/page?q=1`, { ...init, headers });
}

function coordinatesOf(
  fetchUpstream: ReturnType<typeof vi.fn>,
  index = 0
): PreviewProviderCoordinates {
  const args = fetchUpstream.mock.calls[index] ?? [];
  return args[1] as PreviewProviderCoordinates;
}

function upstreamRequestOf(fetchUpstream: ReturnType<typeof vi.fn>, index = 0): Request {
  const args = fetchUpstream.mock.calls[index] ?? [];
  return args[2] as Request;
}

function withMethod(request: Request, method: string): Request {
  Object.defineProperty(request, 'method', { value: method, configurable: true });
  return request;
}

describe('preview host dispatch', () => {
  it('answers 404 for a non-preview hostname', async () => {
    const { deps } = fixture();
    const response = await handlePreviewRequest(new Request('http://worker.test/page'), env, deps);
    expect(response.status).toBe(404);
  });
});

describe('preview entry', () => {
  it('303-redirects to / and mints a host cookie bound to the label', async () => {
    const { deps, validateAccess } = fixture();
    const response = await handlePreviewRequest(entryRequest(entryTicket()), env, deps);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${PREVIEW_COOKIE_NAME}=`);
    expect(cookie).not.toContain(`${PREVIEW_HOST_COOKIE_NAME}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=Lax');
    expect(validateAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', cloudAgentSessionId: SESSION_ID })
    );
  });

  it('keeps the session cookie for the session lifetime, not the 60 s entry ticket lifetime', async () => {
    const { deps } = fixture();
    const shortTicket = jwt.sign(
      {
        type: 'stream_ticket',
        purpose: 'preview',
        userId: 'user-1',
        cloudAgentSessionId: SESSION_ID,
        port: PORT,
        nonce: 'nonce-1',
      },
      SECRET,
      { algorithm: 'HS256', expiresIn: 60, audience: 'cloud-agent-preview' }
    );
    const response = await handlePreviewRequest(entryRequest(shortTicket), env, deps);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=3600');
  });

  it('uses the __Host cookie on https and does not put the ticket in the response', async () => {
    const { deps } = fixture();
    const ticket = entryTicket();
    const response = await handlePreviewRequest(
      new Request(`https://${HOST}${PREVIEW_ENTER_PATH}?ticket=${ticket}`),
      env,
      deps
    );
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${PREVIEW_HOST_COOKIE_NAME}=`);
    expect(cookie).toContain('Secure');
    expect(cookie).not.toContain(ticket);
    expect(response.headers.get('location')).toBe('/');
  });

  it('redirects to the requested path on the preview host', async () => {
    const { deps } = fixture();
    const query = new URLSearchParams({ ticket: entryTicket(), path: '/app/page?tab=2#top' });
    const response = await handlePreviewRequest(
      new Request(`${ORIGIN}${PREVIEW_ENTER_PATH}?${query.toString()}`),
      env,
      deps
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/app/page?tab=2#top');
  });

  it('redirects to / when the requested path leaves the preview host', async () => {
    const { deps } = fixture();
    const query = new URLSearchParams({ ticket: entryTicket(), path: '//evil.example/' });
    const response = await handlePreviewRequest(
      new Request(`${ORIGIN}${PREVIEW_ENTER_PATH}?${query.toString()}`),
      env,
      deps
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');
  });

  it.each([
    ['missing ticket', null],
    ['wrong purpose', entryTicket({ purpose: 'stream' })],
    [
      'wrong audience',
      jwt.sign(
        {
          type: 'stream_ticket',
          purpose: 'preview',
          userId: 'u',
          cloudAgentSessionId: SESSION_ID,
          port: PORT,
        },
        SECRET,
        { algorithm: 'HS256', expiresIn: 3600, audience: 'other' }
      ),
    ],
    [
      'wrong type',
      jwt.sign(
        {
          type: 'preview_session',
          purpose: 'preview',
          userId: 'u',
          cloudAgentSessionId: SESSION_ID,
          port: PORT,
        },
        SECRET,
        { algorithm: 'HS256', expiresIn: 3600, audience: 'cloud-agent-preview' }
      ),
    ],
    ['missing nonce', entryTicket({ nonce: undefined })],
    [
      'missing exp',
      jwt.sign(
        {
          type: 'stream_ticket',
          purpose: 'preview',
          userId: 'u',
          cloudAgentSessionId: SESSION_ID,
          port: PORT,
          nonce: 'nonce-1',
        },
        SECRET,
        { algorithm: 'HS256', noTimestamp: true, audience: 'cloud-agent-preview' }
      ),
    ],
    [
      'expired',
      jwt.sign(
        {
          type: 'stream_ticket',
          purpose: 'preview',
          userId: 'u',
          cloudAgentSessionId: SESSION_ID,
          port: PORT,
        },
        SECRET,
        { algorithm: 'HS256', expiresIn: -1, audience: 'cloud-agent-preview' }
      ),
    ],
    ['session token instead of ticket', sessionToken()],
  ])('rejects a %s with 401 before any RPC', async (_label, ticket) => {
    const { deps, validateAccess } = fixture();
    const response = await handlePreviewRequest(entryRequest(ticket), env, deps);
    expect(response.status).toBe(401);
    expect(validateAccess).not.toHaveBeenCalled();
  });

  it('rejects a label mismatch with 401 before any RPC', async () => {
    const { deps, validateAccess } = fixture();
    const response = await handlePreviewRequest(
      entryRequest(entryTicket({ port: 9999 })),
      env,
      deps
    );
    expect(response.status).toBe(401);
    expect(validateAccess).not.toHaveBeenCalled();
  });

  it('rejects a non-workspace session as a host mismatch before any RPC', async () => {
    const { deps, validateAccess } = fixture();
    const response = await handlePreviewRequest(
      entryRequest(
        entryTicket({ cloudAgentSessionId: 'agent_11111111-1111-4111-8111-111111111111' })
      ),
      env,
      deps
    );
    expect(response.status).toBe(401);
    expect(validateAccess).not.toHaveBeenCalled();
  });

  it('accepts a ticket once and answers a reuse with 401 and no cookie', async () => {
    const { deps, consumeTicketNonce } = fixture();
    const ticket = entryTicket();
    expect((await handlePreviewRequest(entryRequest(ticket), env, deps)).status).toBe(303);
    const reuse = await handlePreviewRequest(entryRequest(ticket), env, deps);
    expect(reuse.status).toBe(401);
    expect(await reuse.text()).toBe(PREVIEW_TICKET_USED_TEXT);
    expect(reuse.headers.get('set-cookie')).toBeNull();
    const { exp } = jwt.decode(ticket) as { exp: number };
    expect(consumeTicketNonce).toHaveBeenCalledWith(env, 'nonce-1', exp * 1000);
  });

  it('checks access before it consumes the ticket', async () => {
    const { deps, consumeTicketNonce } = fixture({
      accessError: new TRPCError({ code: 'FORBIDDEN' }),
    });
    expect((await handlePreviewRequest(entryRequest(entryTicket()), env, deps)).status).toBe(403);
    expect(consumeTicketNonce).not.toHaveBeenCalled();
  });

  it('answers 503 with Retry-After and no cookie when the nonce store fails', async () => {
    const { deps, consumeTicketNonce } = fixture();
    consumeTicketNonce.mockRejectedValueOnce(new Error('nonce DO down'));
    const response = await handlePreviewRequest(entryRequest(entryTicket()), env, deps);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('maps an access denial to 403 and an access outage to 503', async () => {
    const denied = fixture({ accessError: new TRPCError({ code: 'FORBIDDEN' }) });
    expect((await handlePreviewRequest(entryRequest(entryTicket()), env, denied.deps)).status).toBe(
      403
    );
    const outage = fixture({
      accessError: new TRPCError({ code: 'SERVICE_UNAVAILABLE' }),
    });
    expect((await handlePreviewRequest(entryRequest(entryTicket()), env, outage.deps)).status).toBe(
      503
    );
  });
});

describe('preview proxy denials that never reach the resolver or stub', () => {
  it('rejects TRACE and CONNECT with 405', async () => {
    const { deps, resolvePreviewTarget } = fixture();
    for (const method of ['TRACE', 'CONNECT']) {
      const response = await handlePreviewRequest(
        withMethod(proxyRequest(sessionToken()), method),
        env,
        deps
      );
      expect(response.status).toBe(405);
    }
    expect(resolvePreviewTarget).not.toHaveBeenCalled();
  });

  it('rejects oversized headers with 431 before any RPC', async () => {
    const { deps, validateAccess } = fixture();
    const headers = new Headers();
    for (let i = 0; i < 41; i += 1) headers.set(`x-h-${i}`, 'v');
    const response = await handlePreviewRequest(
      proxyRequest(sessionToken(), { headers }),
      env,
      deps
    );
    expect(response.status).toBe(431);
    expect(validateAccess).not.toHaveBeenCalled();
  });

  it('does not count dropped platform headers toward the cap', async () => {
    const { deps, fetchUpstream } = fixture();
    const headers = new Headers();
    for (let i = 0; i < 60; i += 1) headers.set(`cf-client-${i}`, 'v');
    headers.set('x-forwarded-for', '1.2.3.4');
    headers.set('x-kilo-preview-port', '9999');
    for (let i = 0; i < 20; i += 1) headers.set(`x-h-${i}`, 'v');
    const response = await handlePreviewRequest(
      proxyRequest(sessionToken(), { headers }),
      env,
      deps
    );
    expect(response.status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
  });

  it('maps an access denial on a proxied request to 403 and an outage to 503 before upstream', async () => {
    const denied = fixture({ accessError: new TRPCError({ code: 'FORBIDDEN' }) });
    const deniedResponse = await handlePreviewRequest(
      proxyRequest(sessionToken()),
      env,
      denied.deps
    );
    expect(deniedResponse.status).toBe(403);
    await expect(deniedResponse.text()).resolves.toBe('Session access denied');
    expect(denied.fetchUpstream).not.toHaveBeenCalled();

    const outage = fixture({ accessError: new TRPCError({ code: 'SERVICE_UNAVAILABLE' }) });
    const outageResponse = await handlePreviewRequest(
      proxyRequest(sessionToken()),
      env,
      outage.deps
    );
    expect(outageResponse.status).toBe(503);
    await expect(outageResponse.text()).resolves.toBe('Session access is temporarily unavailable');
    expect(outage.fetchUpstream).not.toHaveBeenCalled();
  });

  it('answers 404 under the reserved preview path', async () => {
    const { deps } = fixture();
    const response = await handlePreviewRequest(
      new Request(`${ORIGIN}/.kilo-preview/other`, {
        headers: { Cookie: `${PREVIEW_COOKIE_NAME}=${sessionToken()}` },
      }),
      env,
      deps
    );
    expect(response.status).toBe(404);
  });

  it('requires a valid session cookie and rejects an entry ticket as the cookie', async () => {
    const { deps } = fixture();
    expect((await handlePreviewRequest(proxyRequest(null), env, deps)).status).toBe(401);
    expect((await handlePreviewRequest(proxyRequest(entryTicket()), env, deps)).status).toBe(401);
    expect((await handlePreviewRequest(proxyRequest('not-a-jwt'), env, deps)).status).toBe(401);
  });

  it('tells a visitor without the cookie to open the preview from the chat', async () => {
    const { deps } = fixture();
    const response = await handlePreviewRequest(proxyRequest(null), env, deps);
    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe(PREVIEW_SESSION_MISSING_TEXT);
  });

  it('rejects a cookie whose label does not match the host', async () => {
    const { deps } = fixture();
    const token = sessionToken({ port: 9999 });
    expect((await handlePreviewRequest(proxyRequest(token), env, deps)).status).toBe(401);
  });

  it.each([
    ['ineligible', { status: 'ineligible' } as const, 409],
    ['unsupported_provider', { status: 'unsupported_provider' } as const, 409],
    ['not_ready', { status: 'not_ready' } as const, 503],
    ['not_running', { status: 'not_running' } as const, 503],
  ])('maps resolver %s to %i and never fetches upstream', async (_name, target, status) => {
    const { deps, fetchUpstream } = fixture({ target });
    const response = await handlePreviewRequest(proxyRequest(sessionToken()), env, deps);
    expect(response.status).toBe(status);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it('maps a resolver RPC failure to a retryable 503', async () => {
    const { deps, resolvePreviewTarget, fetchUpstream } = fixture();
    resolvePreviewTarget.mockRejectedValueOnce(new Error('rpc down'));
    const response = await handlePreviewRequest(proxyRequest(sessionToken()), env, deps);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it('leaves the reserved-port refusal to the physical DO', async () => {
    const { deps, fetchUpstream } = fixture();
    const host = `p3000-${HEX}.${SUFFIX}`;
    await handlePreviewRequest(
      new Request(`http://${host}/page`, {
        headers: { Cookie: `${PREVIEW_COOKIE_NAME}=${sessionToken({ port: 3000 })}` },
      }),
      env,
      deps
    );
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    expect(upstreamRequestOf(fetchUpstream).headers.get('x-kilo-preview-port')).toBe('3000');
  });
});

describe('preview open hop on the worker host', () => {
  function openRequest(ticket: string | null, base = 'http://localhost:8794'): Request {
    const query = ticket === null ? '' : `?ticket=${encodeURIComponent(ticket)}`;
    return new Request(`${base}/preview/open${query}`);
  }

  it('redirects to the preview entry on the same scheme and port', async () => {
    const ticket = entryTicket();
    const response = await handlePreviewOpen(openRequest(ticket), {
      ...env,
      PREVIEW_HOST_SUFFIX: 'localhost',
    } as Env);
    expect(response.status).toBe(303);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin).toBe(`http://${LABEL}.localhost:8794`);
    expect(location.pathname).toBe(PREVIEW_ENTER_PATH);
    expect(location.searchParams.get('ticket')).toBe(ticket);
  });

  it('passes the requested path on to the entry unchanged', async () => {
    const ticket = entryTicket();
    const path = '/app page?q=a&b=c#top';
    const query = new URLSearchParams({ ticket, path });
    const response = await handlePreviewOpen(
      new Request(`http://localhost:8794/preview/open?${query.toString()}`),
      { ...env, PREVIEW_HOST_SUFFIX: 'localhost' } as Env
    );
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('ticket')).toBe(ticket);
    expect(location.searchParams.get('path')).toBe(path);
  });

  it('adds no path to the entry when none is requested', async () => {
    const response = await handlePreviewOpen(openRequest(entryTicket()), {
      ...env,
      PREVIEW_HOST_SUFFIX: 'localhost',
    } as Env);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.has('path')).toBe(false);
  });

  it('keeps https and the default port on a hosted worker', async () => {
    const response = await handlePreviewOpen(
      openRequest(entryTicket(), 'https://cloud-agent-next.example.test'),
      env
    );
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get('location') ?? '').origin).toBe(`https://${HOST}`);
  });

  it.each([
    ['missing ticket', null],
    ['session token instead of ticket', sessionToken()],
    ['non-workspace session', entryTicket({ cloudAgentSessionId: 'agent_x' })],
    ['port out of range', entryTicket({ port: 80 })],
  ])('rejects a %s with 401', async (_label, ticket) => {
    const response = await handlePreviewOpen(openRequest(ticket), env);
    expect(response.status).toBe(401);
    expect(response.headers.get('location')).toBeNull();
  });

  it('answers 404 when preview is not configured', async () => {
    const response = await handlePreviewOpen(openRequest(entryTicket()), {
      ...env,
      PREVIEW_HOST_SUFFIX: '',
    } as Env);
    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe('Preview is not configured');
  });

  it('rejects a non-GET method with 405', async () => {
    const response = await handlePreviewOpen(
      new Request(`http://localhost:8794/preview/open?ticket=${entryTicket()}`, { method: 'POST' }),
      env
    );
    expect(response.status).toBe(405);
  });
});

describe('preview Origin policy', () => {
  it('rejects a WebSocket upgrade with a missing or foreign Origin before RPC', async () => {
    const { deps, validateAccess, resolvePreviewTarget } = fixture();
    for (const origin of [undefined, 'https://evil.test', 'null']) {
      const headers: Record<string, string> = { Upgrade: 'websocket', Connection: 'Upgrade' };
      if (origin !== undefined) headers.Origin = origin;
      const response = await handlePreviewRequest(
        proxyRequest(sessionToken(), { headers }),
        env,
        deps
      );
      expect(response.status).toBe(403);
    }
    expect(validateAccess).not.toHaveBeenCalled();
    expect(resolvePreviewTarget).not.toHaveBeenCalled();
  });

  it('rejects a non-GET request with a missing or foreign Origin using the cross-origin text', async () => {
    const { deps } = fixture();
    for (const headers of [{}, { Origin: 'https://evil.test' }] as Record<string, string>[]) {
      const response = await handlePreviewRequest(
        proxyRequest(sessionToken(), { method: 'POST', body: 'x', headers }),
        env,
        deps
      );
      expect(response.status).toBe(403);
      await expect(response.text()).resolves.toBe('Cross-origin preview request rejected');
    }
  });

  it('admits a same-origin WebSocket upgrade and forwards the upgrade headers', async () => {
    const { deps, fetchUpstream } = fixture();
    const response = await handlePreviewRequest(
      proxyRequest(sessionToken(), {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade', Origin: ORIGIN },
      }),
      env,
      deps
    );
    expect(response.status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    const upstream = upstreamRequestOf(fetchUpstream);
    expect(upstream.headers.get('Upgrade')).toBe('websocket');
    expect(upstream.headers.get('Connection')).toBe('Upgrade');
  });

  it('passes a same-origin WebSocket upgrade 101 and its socket through from the stub', async () => {
    const { deps, fetchUpstream } = fixture();
    const socket = {} as WebSocket;
    const upstream = new Response(null, { status: 200 });
    Object.defineProperty(upstream, 'status', { value: 101 });
    Object.defineProperty(upstream, 'webSocket', { value: socket });
    fetchUpstream.mockResolvedValueOnce(upstream);

    const RealResponse = globalThis.Response;
    type PreviewResponseInit = ResponseInit & { webSocket?: WebSocket | null };
    class PreviewResponse extends RealResponse {
      constructor(body?: BodyInit | null, init?: PreviewResponseInit) {
        super(body, init?.status === 101 ? { ...init, status: 200 } : init);
        if (init?.status === 101) Object.defineProperty(this, 'status', { value: 101 });
        if (init?.webSocket != null) {
          Object.defineProperty(this, 'webSocket', { value: init.webSocket });
        }
      }
    }
    vi.stubGlobal('Response', PreviewResponse);
    try {
      const response = await handlePreviewRequest(
        proxyRequest(sessionToken(), {
          headers: { Upgrade: 'websocket', Connection: 'Upgrade', Origin: ORIGIN },
        }),
        env,
        deps
      );
      expect(response.status).toBe(101);
      expect(response.webSocket).toBe(socket);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('allows a same-origin non-GET request', async () => {
    const { deps, fetchUpstream } = fixture();
    const response = await handlePreviewRequest(
      proxyRequest(sessionToken(), {
        method: 'POST',
        body: 'x',
        headers: { Origin: ORIGIN },
      }),
      env,
      deps
    );
    expect(response.status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
  });

  it('allows an ordinary GET with a foreign Origin', async () => {
    const { deps, fetchUpstream } = fixture();
    const response = await handlePreviewRequest(
      proxyRequest(sessionToken(), { headers: { Origin: 'https://evil.test' } }),
      env,
      deps
    );
    expect(response.status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
  });

  it('rewrites the upstream Origin to the loopback port only after admission', async () => {
    const { deps, fetchUpstream } = fixture();
    await handlePreviewRequest(
      proxyRequest(sessionToken(), { headers: { Origin: 'https://evil.test' } }),
      env,
      deps
    );
    const upstream = upstreamRequestOf(fetchUpstream);
    expect(upstream.headers.get('Origin')).toBe(`http://localhost:${PORT}`);
    expect(upstream.headers.get('Host')).toBe(`localhost:${PORT}`);
    expect(upstream.url).toBe(`http://localhost:${PORT}/page?q=1`);
  });
});

describe('preview upstream forwarding', () => {
  it('sends the cloudflare marker without a client marker', async () => {
    const { deps, fetchUpstream } = fixture();
    await handlePreviewRequest(
      proxyRequest(sessionToken(), {
        headers: { 'x-kilo-preview-port': '9999', 'x-kilo-preview-allocation': 'evil' },
      }),
      env,
      deps
    );
    const upstream = upstreamRequestOf(fetchUpstream);
    expect(upstream.headers.get('x-kilo-preview-port')).toBe(String(PORT));
    expect(upstream.headers.get('x-kilo-preview-allocation')).toBeNull();
    expect(coordinatesOf(fetchUpstream)).toEqual(CLOUDFLARE_TARGET.coordinates);
  });

  it('adds the allocation marker for a cloudflare-containers target', async () => {
    const { deps, fetchUpstream } = fixture({ target: CONTAINERS_TARGET });
    await handlePreviewRequest(proxyRequest(sessionToken()), env, deps);
    const upstream = upstreamRequestOf(fetchUpstream);
    expect(upstream.headers.get('x-kilo-preview-allocation')).toBe('allocation-ref');
    expect(coordinatesOf(fetchUpstream)).toEqual(CONTAINERS_TARGET.coordinates);
  });

  it('streams a large body without a cap', async () => {
    const { deps, fetchUpstream } = fixture();
    const bytes = new Uint8Array(3 * 1024 * 1024);
    fetchUpstream.mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    const response = await handlePreviewRequest(proxyRequest(sessionToken()), env, deps);
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.byteLength).toBe(bytes.byteLength);
  });

  it('forwards a request body larger than 2 MiB intact', async () => {
    const { deps, fetchUpstream } = fixture();
    const bytes = new Uint8Array(3 * 1024 * 1024);
    const response = await handlePreviewRequest(
      proxyRequest(sessionToken(), {
        method: 'POST',
        body: bytes,
        headers: { Origin: ORIGIN },
      }),
      env,
      deps
    );
    expect(response.status).toBe(200);
    const upstream = upstreamRequestOf(fetchUpstream);
    const forwarded = new Uint8Array(await upstream.arrayBuffer());
    expect(forwarded.byteLength).toBe(bytes.byteLength);
  });

  it('rewrites Location and adds frame headers while dropping hop-by-hop headers', async () => {
    const { deps, fetchUpstream } = fixture();
    fetchUpstream.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          Location: `http://localhost:${PORT}/login`,
          Connection: 'close',
          'Content-Length': '5',
          'Set-Cookie': `a=1; Domain=example.com; Secure; Path=/`,
        },
      })
    );
    const response = await handlePreviewRequest(proxyRequest(sessionToken()), env, deps);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/login`);
    expect(response.headers.get('connection')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('set-cookie')).toBe('a=1; Path=/');
  });

  it('drops the preview cookie the app tries to set', async () => {
    const { deps, fetchUpstream } = fixture();
    fetchUpstream.mockResolvedValueOnce(
      new Response('ok', {
        status: 200,
        headers: { 'Set-Cookie': `${PREVIEW_COOKIE_NAME}=stolen; Path=/` },
      })
    );
    const response = await handlePreviewRequest(proxyRequest(sessionToken()), env, deps);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('passes through a fixed upstream refusal status unchanged', async () => {
    const { deps, fetchUpstream } = fixture();
    fetchUpstream.mockResolvedValueOnce(
      new Response('Nothing is listening on that port', { status: 502 })
    );
    const response = await handlePreviewRequest(proxyRequest(sessionToken()), env, deps);
    expect(response.status).toBe(502);
  });

  it('maps a thrown upstream fetch to a retryable 503', async () => {
    const { deps, fetchUpstream } = fixture();
    fetchUpstream.mockRejectedValueOnce(new Error('boom'));
    const response = await handlePreviewRequest(proxyRequest(sessionToken()), env, deps);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    await expect(response.text()).resolves.toBe('Preview is temporarily unavailable');
  });

  it('reads the scheme-appropriate cookie name on https', async () => {
    const { deps, fetchUpstream } = fixture();
    const token = sessionToken();
    const response = await handlePreviewRequest(
      new Request(`https://${HOST}/page`, {
        headers: { Cookie: `${PREVIEW_HOST_COOKIE_NAME}=${token}` },
      }),
      env,
      deps
    );
    expect(response.status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
  });
});

describe('default upstream namespace', () => {
  const namespaces = {
    Sandbox: { name: 'Sandbox' },
    SandboxContainment: { name: 'SandboxContainment' },
    SandboxSmallContainment: { name: 'SandboxSmallContainment' },
    SandboxCodeReviewContainment: { name: 'SandboxCodeReviewContainment' },
    SandboxDIND: { name: 'SandboxDIND' },
  };
  const namespaceEnv = { ...env, ...namespaces } as unknown as Env;
  const PLACED_KEY = `sbx-${'a'.repeat(48)}`;

  async function namespaceFor(coordinates: PreviewProviderCoordinates): Promise<unknown> {
    const sandboxFetch = vi.fn(async () => new Response('ok'));
    const mocked = vi.mocked(getSandbox);
    mocked.mockReset();
    mocked.mockReturnValue({ fetch: sandboxFetch } as unknown as ReturnType<typeof getSandbox>);
    const response = await defaultFetchUpstream(
      namespaceEnv,
      coordinates,
      new Request(`${ORIGIN}/`)
    );
    expect(response.status).toBe(200);
    expect(sandboxFetch).toHaveBeenCalledTimes(1);
    const [namespace, sandboxId] = mocked.mock.calls[0] ?? [];
    expect(sandboxId).toBe(
      coordinates.provider === 'cloudflare' ? coordinates.allocationName : undefined
    );
    return namespace;
  }

  it('routes a placed contained key through its pinned kind', async () => {
    await expect(
      namespaceFor({
        provider: 'cloudflare',
        allocationName: PLACED_KEY,
        containment: true,
        sandboxKind: 'isolated',
      })
    ).resolves.toBe(namespaces.SandboxSmallContainment);
    await expect(
      namespaceFor({
        provider: 'cloudflare',
        allocationName: PLACED_KEY,
        containment: true,
        sandboxKind: 'shared',
      })
    ).resolves.toBe(namespaces.SandboxContainment);
  });

  it('routes a placed key without containment to the standard pool', async () => {
    await expect(
      namespaceFor({
        provider: 'cloudflare',
        allocationName: PLACED_KEY,
        containment: false,
        sandboxKind: 'isolated',
      })
    ).resolves.toBe(namespaces.Sandbox);
  });

  it('keeps routing a legacy prefixed key by its prefix', async () => {
    await expect(
      namespaceFor({
        provider: 'cloudflare',
        allocationName: 'ses-11111111111141118111111111111111',
        containment: false,
      })
    ).resolves.toBe(namespaces.Sandbox);
    await expect(
      namespaceFor({
        provider: 'cloudflare',
        allocationName: 'ses-11111111111141118111111111111111',
        containment: true,
      })
    ).resolves.toBe(namespaces.SandboxSmallContainment);
  });
});
