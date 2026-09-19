import { describe, expect, it, vi } from 'vitest';
import type {
  AuthRequest,
  ClientInfo,
  CompleteAuthorizationOptions,
  OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';
import { createDefaultHandler, type ConsentDeps } from './consent';
import type { McpAnalytics, OAuthSignInInput } from '../analytics';
import type {
  NewPendingAuthorization,
  OAuthStoreApi,
  PendingAuthorization,
} from '../store/oauth-store';
import type { AuthenticatorEnrollmentApi } from '../types';
import { totpCode } from '../otp/totp';

/**
 * The library throws this at /authorize for an invalid request; reproduce its
 * shape (name + fields) without importing the provider at runtime.
 */
function authError(options: {
  code?: string;
  description: string;
  redirectUri?: string;
  state?: string;
  issuer?: string;
}): Error {
  const error = new Error(options.description);
  error.name = 'AuthorizationError';
  return Object.assign(error, { code: options.code ?? 'invalid_request', ...options });
}

const ISSUER = 'https://kilo-mcp.test';
const WEB = 'https://app.kilo.test';
const CLIENT_ID = 'client-abc';
const REDIRECT = 'https://client.test/cb';
const STATE = 'st-1';
const NOW = new Date('2026-09-11T00:00:00.000Z');

/** The RFC 6238 Appendix B shared secret, so a test code is deterministic. */
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

/** The code the seeded secret produces at NOW. */
function currentCode(): Promise<string> {
  return totpCode(SECRET, NOW.getTime());
}

/** A six-digit code that is provably not the current one. */
async function wrongCode(): Promise<string> {
  return (await currentCode()) === '000000' ? '111111' : '000000';
}

function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

function authRequest(): AuthRequest {
  return {
    responseType: 'code',
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    scope: ['mcp'],
    state: STATE,
    codeChallenge: 'challenge-value-000000000000000000000000000000',
    codeChallengeMethod: 'S256',
    resource: `${ISSUER}/mcp`,
    issuer: ISSUER,
  };
}

function clientInfo(): ClientInfo {
  return {
    clientId: CLIENT_ID,
    clientName: 'Test Client',
    redirectUris: [REDIRECT],
    tokenEndpointAuthMethod: 'none',
  };
}

/**
 * In-memory OAuthStoreApi plus the authenticator enrolment the picker's opt-in
 * reads. The methods the consent routes reach are real; the rest throw so a new
 * dependency fails loudly.
 */
function createFakeStore(): OAuthStoreApi &
  AuthenticatorEnrollmentApi & {
    pending: Map<string, PendingAuthorization>;
    authenticators: Map<string, { secret: string; verified: boolean }>;
    ensureCalls: number;
    confirmCalls: number;
  } {
  const pending = new Map<string, PendingAuthorization>();
  const authenticators = new Map<string, { secret: string; verified: boolean }>();
  const counters = { ensureCalls: 0, confirmCalls: 0 };
  const unused = (): never => {
    throw new Error('not reachable from these tests');
  };
  return {
    pending,
    authenticators,
    get ensureCalls() {
      return counters.ensureCalls;
    },
    get confirmCalls() {
      return counters.confirmCalls;
    },
    recordPairingApproval: async (deviceAuthCode, identity, nowIso) => {
      for (const [id, record] of pending) {
        if (
          record.deviceAuthCode === deviceAuthCode &&
          record.status === 'pending' &&
          record.kiloUserId === null &&
          record.expiresAt > nowIso
        ) {
          pending.set(id, {
            ...record,
            kiloUserId: identity.kiloUserId,
            kiloToken: identity.kiloToken,
          });
          return true;
        }
      }
      return false;
    },
    createPendingAuthorization: async (input: NewPendingAuthorization) => {
      pending.set(input.id, {
        id: input.id,
        authRequest: input.authRequest,
        deviceAuthCode: input.deviceAuthCode,
        status: 'pending',
        kiloUserId: null,
        organizationId: null,
        kiloToken: null,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      });
    },
    getPendingAuthorization: async id => {
      const record = pending.get(id);
      return record ? { ...record } : null;
    },
    denyPendingAuthorization: async (deviceAuthCode, nowIso) => {
      for (const [id, record] of pending) {
        if (
          record.deviceAuthCode === deviceAuthCode &&
          record.status === 'pending' &&
          record.expiresAt > nowIso
        ) {
          pending.set(id, { ...record, status: 'denied' });
          return true;
        }
      }
      return false;
    },
    expirePendingAuthorization: async (deviceAuthCode, nowIso) => {
      for (const [id, record] of pending) {
        if (
          record.deviceAuthCode === deviceAuthCode &&
          record.status === 'pending' &&
          record.expiresAt > nowIso
        ) {
          pending.set(id, { ...record, status: 'expired' });
          return true;
        }
      }
      return false;
    },
    approvePendingAuthorization: async (deviceAuthCode, identity, nowIso) => {
      for (const [id, record] of pending) {
        if (
          record.deviceAuthCode === deviceAuthCode &&
          record.status === 'pending' &&
          record.expiresAt > nowIso
        ) {
          pending.set(id, {
            ...record,
            status: 'approved',
            kiloUserId: identity.kiloUserId,
            organizationId: identity.organizationId,
          });
          return true;
        }
      }
      return false;
    },
    completePendingAuthorization: async (id, nowIso) => {
      const record = pending.get(id);
      if (!record || record.status !== 'approved' || record.expiresAt <= nowIso) return false;
      pending.set(id, { ...record, status: 'completed' });
      return true;
    },
    releasePendingAuthorization: async (id, nowIso) => {
      const record = pending.get(id);
      if (!record || record.status !== 'approved' || record.expiresAt <= nowIso) return false;
      pending.set(id, { ...record, status: 'pending', organizationId: null });
      return true;
    },
    purgeExpired: unused,
    ensureAuthenticator: async kiloUserId => {
      counters.ensureCalls += 1;
      let row = authenticators.get(kiloUserId);
      if (!row) {
        row = { secret: SECRET, verified: false };
        authenticators.set(kiloUserId, row);
      }
      return { secret: row.secret, verified: row.verified };
    },
    confirmAuthenticator: async (kiloUserId, code, nowIso) => {
      counters.confirmCalls += 1;
      const row = authenticators.get(kiloUserId);
      if (!row || code !== (await totpCode(row.secret, Date.parse(nowIso)))) {
        return false;
      }
      row.verified = true;
      return true;
    },
  };
}

/** Seed a known authenticator for the paired identity (a prior GET enrolled it). */
function seedAuthenticator(
  store: ReturnType<typeof createFakeStore>,
  kiloUserId: string,
  options: { verified?: boolean } = {}
): string {
  store.authenticators.set(kiloUserId, { secret: SECRET, verified: options.verified === true });
  return SECRET;
}

async function seedPending(
  store: ReturnType<typeof createFakeStore>,
  overrides: { id?: string; deviceAuthCode?: string; expiresAt?: string } = {}
): Promise<string> {
  const id = overrides.id ?? 'pa-1';
  await store.createPendingAuthorization({
    id,
    authRequest: authRequest(),
    deviceAuthCode: overrides.deviceAuthCode ?? 'PAIR-1',
    createdAt: iso(-1000),
    expiresAt: overrides.expiresAt ?? iso(600_000),
  });
  return id;
}

async function seedPaired(store: ReturnType<typeof createFakeStore>): Promise<string> {
  const id = await seedPending(store);
  await store.recordPairingApproval(
    'PAIR-1',
    { kiloUserId: 'u-1', kiloToken: 'kilo-tok-1' },
    iso(0)
  );
  return id;
}

function fakeHelpers(config: {
  authRequest?: AuthRequest;
  client?: ClientInfo | null;
  parseError?: unknown;
  redirectTo?: string;
  /** Injected provider-completion failure (the library owns that call). */
  completeError?: unknown;
  /** Injected client-record renewal failure (the consent completion owns that call). */
  updateError?: unknown;
}): {
  helpers: OAuthHelpers;
  completes: CompleteAuthorizationOptions[];
  updates: string[];
} {
  const completes: CompleteAuthorizationOptions[] = [];
  const updates: string[] = [];
  const helpers = {
    async parseAuthRequest() {
      if (config.parseError !== undefined) throw config.parseError;
      if (!config.authRequest) throw new Error('no authRequest configured');
      return config.authRequest;
    },
    async lookupClient() {
      return config.client ?? null;
    },
    async updateClient(clientId: string) {
      if (config.updateError !== undefined) throw config.updateError;
      updates.push(clientId);
      return null;
    },
    async completeAuthorization(options: CompleteAuthorizationOptions) {
      if (config.completeError !== undefined) throw config.completeError;
      completes.push(options);
      return { redirectTo: config.redirectTo ?? `${REDIRECT}?code=lib-code` };
    },
  } as unknown as OAuthHelpers;
  return { helpers, completes, updates };
}

function envWith(helpers: OAuthHelpers): Env {
  return { OAUTH_PROVIDER: helpers, WEB_BASE_URL: WEB } as unknown as Env;
}

function fakeAnalytics(): { analytics: McpAnalytics; calls: OAuthSignInInput[] } {
  const calls: OAuthSignInInput[] = [];
  return {
    calls,
    analytics: {
      oauthSignIn: vi.fn((input: OAuthSignInInput) => {
        calls.push(input);
      }),
    } as unknown as McpAnalytics,
  };
}

function deps(
  store: ConsentDeps['store'],
  fetchImpl: typeof fetch | undefined,
  extra: { analytics?: McpAnalytics } = {}
) {
  return {
    store,
    webBaseUrl: WEB,
    ...(fetchImpl ? { fetchImpl } : {}),
    now: () => NOW,
    ...(extra.analytics ? { analytics: extra.analytics } : {}),
  };
}

type CfRequest = Parameters<NonNullable<ExportedHandler<Env>['fetch']>>[0];

async function run(handler: ExportedHandler<Env>, request: Request, env: Env): Promise<Response> {
  return handler.fetch!(request as unknown as CfRequest, env, {} as ExecutionContext);
}

/**
 * A fetch fake routed by URL for the whole device-auth + org-list + admin
 * flow. `isAdmin` answers the paired identity's `user.getMe` read.
 */
function flowFetch(
  overrides: Record<string, () => Response | Promise<Response>> = {},
  options: { isAdmin?: boolean } = {}
) {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    for (const [suffix, response] of Object.entries(overrides)) {
      if (url.endsWith(suffix)) return response();
    }
    if (url.endsWith('/api/device-auth/codes')) return Response.json({ code: 'PAIR-1' });
    if (url.endsWith('/api/device-auth/codes/PAIR-1')) {
      return Response.json({ status: 'approved', token: 'kilo-tok-1', userId: 'u-1' });
    }
    if (url.includes('/api/trpc/user.getMe')) {
      return Response.json({ result: { data: { isAdmin: options.isAdmin ?? false } } });
    }
    if (url.includes('/api/trpc/organizations.list')) {
      return Response.json({
        result: { data: [{ organizationId: 'org-2', organizationName: 'Nova' }] },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
}

function authorizeRequestFor(clientId = CLIENT_ID): Request {
  const url = new URL(`${ISSUER}/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', REDIRECT);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', 'challenge-value-000000000000000000000000000000');
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', 'mcp');
  url.searchParams.set('state', STATE);
  return new Request(url);
}

const OAUTH_EVENT_FIELDS = ['clientId', 'identity', 'phase', 'reason'];
const IDENTITY_FIELDS = ['kiloUserId', 'organizationId'];

function expectNoCredentialLeak(calls: OAuthSignInInput[]): void {
  for (const call of calls) {
    for (const key of Object.keys(call)) {
      expect(OAUTH_EVENT_FIELDS).toContain(key);
    }
    if (call.identity) {
      for (const key of Object.keys(call.identity)) {
        expect(IDENTITY_FIELDS).toContain(key);
      }
    }
  }
}

describe('GET /authorize (consent)', () => {
  function expectPrivateStatusUrl(html: string, id: string): void {
    const serializedUrl = html.match(/var u=("[^"]*");/)?.[1];
    expect(serializedUrl).toBeDefined();
    const statusUrl = JSON.parse(serializedUrl ?? '""') as string;
    expect(statusUrl).not.toContain('PAIR-1');
    expect(statusUrl).toBe(`/authorize/status?id=${id}`);
  }

  it('parses the request, opens a pairing, emits started, and points at the status id', async () => {
    const store = createFakeStore();
    const { helpers } = fakeHelpers({ authRequest: authRequest(), client: clientInfo() });
    const { analytics, calls } = fakeAnalytics();
    const handler = createDefaultHandler(deps(store, flowFetch(), { analytics }));

    const response = await run(handler, authorizeRequestFor(), envWith(helpers));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Connect to Kilo MCP');
    expect(html).toContain('Test Client');
    const id = [...store.pending.keys()][0]!;
    // The status URL carries the internal pending id, never the device-auth code.
    expect(html).toContain(`/authorize/status?id=${id}`);
    expectPrivateStatusUrl(html, id);
    // A leaked query parameter must fail the invariant, not just visible text.
    expect(() =>
      expectPrivateStatusUrl(
        html.replace(`/authorize/status?id=${id}`, `/authorize/status?id=${id}&code=PAIR-1`),
        id
      )
    ).toThrow();
    expect(store.pending.get(id)).toMatchObject({ deviceAuthCode: 'PAIR-1', status: 'pending' });
    expect(calls).toEqual([{ phase: 'started', identity: null, clientId: CLIENT_ID }]);
    expectNoCredentialLeak(calls);
  });

  it('renders missing/unknown client errors locally instead of redirecting', async () => {
    const store = createFakeStore();
    const { helpers } = fakeHelpers({
      authRequest: authRequest(),
      client: null,
    });
    const handler = createDefaultHandler(deps(store, flowFetch()));
    // parseAuthRequest throws without a redirectUri: local render.
    const viaParse = fakeHelpers({
      parseError: authError({
        description: 'Missing client_id.',
      }),
    });
    const local = await run(
      createDefaultHandler(deps(createFakeStore(), flowFetch())),
      authorizeRequestFor(),
      envWith(viaParse.helpers)
    );
    expect(local.status).toBe(400);
    expect(await local.text()).toContain('Missing client_id.');

    // Unknown client (lookupClient null): local render too.
    const unknown = await run(handler, authorizeRequestFor(), envWith(helpers));
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain('Unknown OAuth client');
  });

  it('redirects with the OAuth error params (and iss) only when redirectUri is present', async () => {
    const store = createFakeStore();
    const { helpers } = fakeHelpers({
      parseError: authError({
        code: 'access_denied',
        description: 'The user denied the request.',
        redirectUri: REDIRECT,
        state: STATE,
        issuer: ISSUER,
      }),
    });
    const response = await run(
      createDefaultHandler(deps(store, flowFetch())),
      authorizeRequestFor(),
      envWith(helpers)
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location')!);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('error_description')).toBe('The user denied the request.');
    expect(location.searchParams.get('state')).toBe(STATE);
    expect(location.searchParams.get('iss')).toBe(ISSUER);
  });

  it('returns a retryable 503 when apps/web pairing cannot be reached', async () => {
    const store = createFakeStore();
    const { helpers } = fakeHelpers({ authRequest: authRequest(), client: clientInfo() });
    const { analytics, calls } = fakeAnalytics();
    const fetchImpl = vi.fn(async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    const handler = createDefaultHandler(deps(store, fetchImpl, { analytics }));
    const response = await run(handler, authorizeRequestFor(), envWith(helpers));
    expect(response.status).toBe(503);
    expect(await response.text()).toMatch(/Kilo sign-in could not be reached/);
    expect(store.pending.size).toBe(0);
    expect(calls).toEqual([
      { phase: 'failed', identity: null, clientId: CLIENT_ID, reason: 'unreachable' },
    ]);
    expectNoCredentialLeak(calls);
  });

  it('returns a retryable 503 with rate-limit copy when apps/web answers 429', async () => {
    const store = createFakeStore();
    const { helpers } = fakeHelpers({ authRequest: authRequest(), client: clientInfo() });
    const { analytics, calls } = fakeAnalytics();
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 429 })
    ) as unknown as typeof fetch;
    const response = await run(
      createDefaultHandler(deps(store, fetchImpl, { analytics })),
      authorizeRequestFor(),
      envWith(helpers)
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toMatch(/Too many pending Kilo sign-in requests/);
    expect(calls).toEqual([
      { phase: 'failed', identity: null, clientId: CLIENT_ID, reason: 'rate_limited' },
    ]);
  });
});

describe('GET /authorize/status', () => {
  it('reports pending while the user has not approved upstream, and keeps the next poll alive', async () => {
    const store = createFakeStore();
    await seedPending(store);
    const fetchImpl = flowFetch({
      '/api/device-auth/codes/PAIR-1': () => new Response('', { status: 202 }),
    });
    const handler = createDefaultHandler(deps(store, fetchImpl));
    const response = await run(
      handler,
      new Request(`${ISSUER}/authorize/status?id=pa-1`),
      envWith(fakeHelpers({}).helpers)
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'pending' });
  });

  it('persists an approved pairing once and answers with the org picker', async () => {
    const store = createFakeStore();
    await seedPending(store);
    let polls = 0;
    const fetchImpl = flowFetch({
      '/api/device-auth/codes/PAIR-1': () => {
        polls += 1;
        // Single-use upstream: only the first poll ever sees approved.
        return polls === 1
          ? Response.json({ status: 'approved', token: 'kilo-tok-1', userId: 'u-1' })
          : new Response('', { status: 410 });
      },
    });
    const handler = createDefaultHandler(deps(store, fetchImpl));
    const env = envWith(fakeHelpers({}).helpers);
    await expect(
      run(handler, new Request(`${ISSUER}/authorize/status?id=pa-1`), env).then(r => r.json())
    ).resolves.toEqual({ status: 'needs_org', picker_url: '/authorize/org?id=pa-1' });
    expect(store.pending.get('pa-1')).toMatchObject({
      kiloUserId: 'u-1',
      kiloToken: 'kilo-tok-1',
      status: 'pending',
    });
    // The token is held locally; apps/web is never asked again.
    await expect(
      run(handler, new Request(`${ISSUER}/authorize/status?id=pa-1`), env).then(r => r.json())
    ).resolves.toEqual({ status: 'needs_org', picker_url: '/authorize/org?id=pa-1' });
    expect(polls).toBe(1);
  });

  it('treats an unreachable upstream as pending so the page retries', async () => {
    const store = createFakeStore();
    await seedPending(store);
    const fetchImpl = vi.fn(async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    const handler = createDefaultHandler(deps(store, fetchImpl));
    await expect(
      run(
        handler,
        new Request(`${ISSUER}/authorize/status?id=pa-1`),
        envWith(fakeHelpers({}).helpers)
      ).then(r => r.json())
    ).resolves.toEqual({ status: 'pending' });
  });

  it('persists a denial and reports it exactly once across repeated polls', async () => {
    const store = createFakeStore();
    await seedPending(store);
    const fetchImpl = flowFetch({
      '/api/device-auth/codes/PAIR-1': () => new Response('', { status: 403 }),
    });
    const { analytics, calls } = fakeAnalytics();
    const handler = createDefaultHandler(deps(store, fetchImpl, { analytics }));
    const env = envWith(fakeHelpers({}).helpers);
    await expect(
      run(handler, new Request(`${ISSUER}/authorize/status?id=pa-1`), env).then(r => r.json())
    ).resolves.toEqual({ status: 'denied' });
    expect(store.pending.get('pa-1')?.status).toBe('denied');
    await expect(
      run(handler, new Request(`${ISSUER}/authorize/status?id=pa-1`), env).then(r => r.json())
    ).resolves.toEqual({ status: 'denied' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      { phase: 'failed', identity: null, clientId: CLIENT_ID, reason: 'denied' },
    ]);
    expectNoCredentialLeak(calls);
  });

  it('persists an upstream expiry and reports it exactly once', async () => {
    const store = createFakeStore();
    await seedPending(store);
    const fetchImpl = flowFetch({
      '/api/device-auth/codes/PAIR-1': () => new Response('', { status: 410 }),
    });
    const { analytics, calls } = fakeAnalytics();
    const handler = createDefaultHandler(deps(store, fetchImpl, { analytics }));
    const env = envWith(fakeHelpers({}).helpers);
    await expect(
      run(handler, new Request(`${ISSUER}/authorize/status?id=pa-1`), env).then(r => r.json())
    ).resolves.toEqual({ status: 'expired' });
    expect(store.pending.get('pa-1')?.status).toBe('expired');
    await expect(
      run(handler, new Request(`${ISSUER}/authorize/status?id=pa-1`), env).then(r => r.json())
    ).resolves.toEqual({ status: 'expired' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      { phase: 'failed', identity: null, clientId: CLIENT_ID, reason: 'expired' },
    ]);
    expectNoCredentialLeak(calls);
  });

  it('answers unknown for a missing id, an unknown record, and an expired record', async () => {
    const store = createFakeStore();
    const handler = createDefaultHandler(deps(store, flowFetch()));
    const env = envWith(fakeHelpers({}).helpers);
    await expect(
      run(handler, new Request(`${ISSUER}/authorize/status`), env).then(r => r.json())
    ).resolves.toEqual({ status: 'unknown' });
    await expect(
      run(handler, new Request(`${ISSUER}/authorize/status?id=ghost`), env).then(r => r.json())
    ).resolves.toEqual({ status: 'unknown' });
    await seedPending(store, { expiresAt: iso(-1) });
    await expect(
      run(handler, new Request(`${ISSUER}/authorize/status?id=pa-1`), env).then(r => r.json())
    ).resolves.toEqual({ status: 'unknown' });
  });

  it('answers unknown once the org is chosen (the POST owns the redirect)', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    await store.approvePendingAuthorization(
      'PAIR-1',
      { kiloUserId: 'u-1', organizationId: 'org-1' },
      iso(0)
    );
    const handler = createDefaultHandler(deps(store, flowFetch()));
    await expect(
      run(
        handler,
        new Request(`${ISSUER}/authorize/status?id=${id}`),
        envWith(fakeHelpers({}).helpers)
      ).then(r => r.json())
    ).resolves.toEqual({ status: 'unknown' });
  });

  it('rejects non-GET', async () => {
    const store = createFakeStore();
    const handler = createDefaultHandler(deps(store, flowFetch()));
    const response = await run(
      handler,
      new Request(`${ISSUER}/authorize/status?id=pa-1`, { method: 'POST' }),
      envWith(fakeHelpers({}).helpers)
    );
    expect(response.status).toBe(405);
  });
});

describe('GET/POST /authorize/org', () => {
  it('renders the personal context plus each of the user organizations', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    const handler = createDefaultHandler(deps(store, flowFetch()));
    const response = await run(
      handler,
      new Request(`${ISSUER}/authorize/org?id=${id}`),
      envWith(fakeHelpers({ client: clientInfo() }).helpers)
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Choose a Kilo organization');
    expect(html).toContain('Test Client');
    expect(html).toContain('Personal account');
    expect(html).toContain('Nova');
    expect(html).toContain('value="org-2"');
  });

  it('offers only the personal context when the org list is empty', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    const fetchImpl = flowFetch({
      '/api/trpc/organizations.list': () => Response.json({ result: { data: [] } }),
    });
    const handler = createDefaultHandler(deps(store, fetchImpl));
    const response = await run(
      handler,
      new Request(`${ISSUER}/authorize/org?id=${id}`),
      envWith(fakeHelpers({ client: clientInfo() }).helpers)
    );
    const html = await response.text();
    expect(html).toContain('Personal account');
    expect(html).not.toMatch(/value="org-/);
  });

  it('renders a retryable personal-only page when the org list read fails', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    const fetchImpl = vi.fn(async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    const handler = createDefaultHandler(deps(store, fetchImpl));
    const response = await run(
      handler,
      new Request(`${ISSUER}/authorize/org?id=${id}`),
      envWith(fakeHelpers({ client: clientInfo() }).helpers)
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/Could not load your organizations/);
    expect(html).toContain('Personal account');
  });

  it('sends an unpaired record back through the consent page for the same pairing', async () => {
    const store = createFakeStore();
    await seedPending(store);
    const handler = createDefaultHandler(deps(store, flowFetch()));
    const response = await run(
      handler,
      new Request(`${ISSUER}/authorize/org?id=pa-1`),
      envWith(fakeHelpers({ client: clientInfo() }).helpers)
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Connect to Kilo MCP');
    expect(html).toContain(`${WEB}/device-auth?code=PAIR-1`);
  });

  it('binds a member organization and completes the authorization with the library', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    const redirectTo = `${REDIRECT}?code=lib-code&state=${STATE}&iss=${encodeURIComponent(ISSUER)}`;
    const { helpers, completes } = fakeHelpers({
      client: clientInfo(),
      redirectTo,
    });
    const handler = createDefaultHandler(deps(store, flowFetch()));
    const env = envWith(helpers);
    const response = await run(
      handler,
      new Request(`${ISSUER}/authorize/org?id=${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ organization_id: 'org-2' }).toString(),
      }),
      env
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(redirectTo);
    expect(completes).toHaveLength(1);
    expect(completes[0]).toMatchObject({
      request: authRequest(),
      userId: 'u-1',
      metadata: { clientName: 'Test Client' },
      scope: ['mcp'],
      props: { kiloUserId: 'u-1', organizationId: 'org-2', kiloToken: 'kilo-tok-1' },
    });
    expect(store.pending.get(id)?.status).toBe('completed');
  });

  it('re-anchors the DCR client record to the grant it completes', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    const { helpers, completes, updates } = fakeHelpers({ client: clientInfo() });
    const response = await run(
      createDefaultHandler(deps(store, flowFetch())),
      new Request(`${ISSUER}/authorize/org?id=${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ organization_id: 'personal' }).toString(),
      }),
      envWith(helpers)
    );
    expect(response.status).toBe(302);
    // The record's TTL is anchored at registration; re-putting it here anchors
    // the session+margin lifetime to the grant this completion mints.
    expect(updates).toEqual([CLIENT_ID]);
    expect(completes).toHaveLength(1);
    expect(store.pending.get(id)?.status).toBe('completed');
  });

  it('keeps a failed client-record renewal retryable instead of promising the year', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    const failing = fakeHelpers({ client: clientInfo(), updateError: new Error('kv down') });
    const response = await run(
      createDefaultHandler(deps(store, flowFetch())),
      new Request(`${ISSUER}/authorize/org?id=${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ organization_id: 'personal' }).toString(),
      }),
      envWith(failing.helpers)
    );
    // Nothing was minted and the record is released, so the same user can retry
    // rather than being stranded on a terminal 'approved'.
    expect(failing.completes).toHaveLength(0);
    expect(store.pending.get(id)?.status).toBe('pending');
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/Could not finish connecting/);
  });

  it('emits exactly one succeeded event bound to the chosen member organization', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    const { helpers } = fakeHelpers({ client: clientInfo() });
    const { analytics, calls } = fakeAnalytics();
    const response = await run(
      createDefaultHandler(deps(store, flowFetch(), { analytics })),
      new Request(`${ISSUER}/authorize/org?id=${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ organization_id: 'org-2' }).toString(),
      }),
      envWith(helpers)
    );
    expect(response.status).toBe(302);
    const succeeded = calls.filter(call => call.phase === 'succeeded');
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]).toEqual({
      phase: 'succeeded',
      identity: { kiloUserId: 'u-1', organizationId: 'org-2' },
      clientId: CLIENT_ID,
    });
    expectNoCredentialLeak(calls);
  });

  it('emits exactly one succeeded event with a null organization for the personal context', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    const { helpers } = fakeHelpers({ client: clientInfo() });
    const { analytics, calls } = fakeAnalytics();
    const fetchImpl = vi.fn(async () => {
      throw new Error('membership must not be read for personal');
    }) as unknown as typeof fetch;
    const response = await run(
      createDefaultHandler(deps(store, fetchImpl, { analytics })),
      new Request(`${ISSUER}/authorize/org?id=${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ organization_id: 'personal' }).toString(),
      }),
      envWith(helpers)
    );
    expect(response.status).toBe(302);
    const succeeded = calls.filter(call => call.phase === 'succeeded');
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]).toEqual({
      phase: 'succeeded',
      identity: { kiloUserId: 'u-1', organizationId: null },
      clientId: CLIENT_ID,
    });
  });

  it('the personal context completes with a null organization and no membership read', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    const { helpers, completes } = fakeHelpers({ client: clientInfo() });
    const fetchImpl = vi.fn(async () => {
      throw new Error('membership must not be read for personal');
    }) as unknown as typeof fetch;
    const response = await run(
      createDefaultHandler(deps(store, fetchImpl)),
      new Request(`${ISSUER}/authorize/org?id=${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ organization_id: 'personal' }).toString(),
      }),
      envWith(helpers)
    );
    expect(response.status).toBe(302);
    expect(completes[0]?.props).toMatchObject({ organizationId: null });
    expect(store.pending.get(id)?.status).toBe('completed');
  });

  it('refuses an organization the user is not a member of (edited form)', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    const { helpers, completes } = fakeHelpers({ client: clientInfo() });
    const response = await run(
      createDefaultHandler(deps(store, flowFetch())),
      new Request(`${ISSUER}/authorize/org?id=${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ organization_id: 'org-victim' }).toString(),
      }),
      envWith(helpers)
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/not available for this account/);
    expect(completes).toHaveLength(0);
    expect(store.pending.get(id)?.status).toBe('pending');
  });

  it('guards a double complete: the second submit cannot complete twice', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    const { helpers, completes } = fakeHelpers({ client: clientInfo() });
    const { analytics, calls } = fakeAnalytics();
    const handler = createDefaultHandler(deps(store, flowFetch(), { analytics }));
    const env = envWith(helpers);
    const post = () =>
      run(
        handler,
        new Request(`${ISSUER}/authorize/org?id=${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ organization_id: 'org-2' }).toString(),
        }),
        env
      );
    const first = await post();
    expect(first.status).toBe(302);
    const second = await post();
    expect(second.status).toBe(400);
    expect(completes).toHaveLength(1);
    expect(store.pending.get(id)?.status).toBe('completed');
    // The success event fires once, after the approved guard: the lost second
    // submit emits nothing.
    expect(calls.filter(call => call.phase === 'succeeded')).toHaveLength(1);
  });

  it('reverts an approved record to pending when the provider completion fails (retryable)', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    const failing = fakeHelpers({ client: clientInfo(), completeError: new Error('kv down') });
    const { analytics, calls } = fakeAnalytics();
    const handler = createDefaultHandler(deps(store, flowFetch(), { analytics }));
    const submit = (env: Env) =>
      run(
        handler,
        new Request(`${ISSUER}/authorize/org?id=${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ organization_id: 'org-2' }).toString(),
        }),
        env
      );

    const failed = await submit(envWith(failing.helpers));
    // The record is released, never stranded in a terminal 'approved' state.
    expect(store.pending.get(id)?.status).toBe('pending');
    expect(store.pending.get(id)?.kiloToken).toBe('kilo-tok-1');
    expect(calls.filter(call => call.phase === 'succeeded')).toHaveLength(0);
    expect(failed.status).toBe(200);
    expect(await failed.text()).toMatch(/Could not finish connecting/);

    // The consent poll sends the same tab back to the picker, so the user can
    // retry without restarting from the MCP client.
    const status = await run(
      handler,
      new Request(`${ISSUER}/authorize/status?id=${id}`),
      envWith(fakeHelpers({}).helpers)
    );
    await expect(status.json()).resolves.toEqual({
      status: 'needs_org',
      picker_url: `/authorize/org?id=${id}`,
    });

    const { helpers, completes } = fakeHelpers({ client: clientInfo() });
    const retried = await submit(envWith(helpers));
    expect(retried.status).toBe(302);
    expect(retried.headers.get('Location')).toBe(`${REDIRECT}?code=lib-code`);
    expect(completes).toHaveLength(1);
    expect(store.pending.get(id)?.status).toBe('completed');
  });

  it('does not redirect or emit success when the terminal transition is rejected', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    // The store's expiry/race guard rejects the transition after the library
    // already issued the code: the response must not claim success.
    store.completePendingAuthorization = async () => false;
    const { helpers } = fakeHelpers({ client: clientInfo() });
    const { analytics, calls } = fakeAnalytics();
    const response = await run(
      createDefaultHandler(deps(store, flowFetch(), { analytics })),
      new Request(`${ISSUER}/authorize/org?id=${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ organization_id: 'org-2' }).toString(),
      }),
      envWith(helpers)
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('Location')).toBeNull();
    expect(calls.filter(call => call.phase === 'succeeded')).toHaveLength(0);
  });

  it('rejects unknown/expired/denied records with an error page', async () => {
    const store = createFakeStore();
    const handler = createDefaultHandler(deps(store, flowFetch()));
    const env = envWith(fakeHelpers({ client: clientInfo() }).helpers);
    await expect(
      run(handler, new Request(`${ISSUER}/authorize/org?id=ghost`), env).then(r => r.status)
    ).resolves.toBe(400);
    const id = await seedPending(store);
    store.pending.set(id, { ...store.pending.get(id)!, status: 'denied' });
    await expect(
      run(handler, new Request(`${ISSUER}/authorize/org?id=${id}`), env).then(r => r.status)
    ).resolves.toBe(400);
    await expect(
      run(handler, new Request(`${ISSUER}/authorize/org?id=`), env).then(r => r.status)
    ).resolves.toBe(400);
  });

  it('shows the admin opt-in unchecked, with the hidden authenticator subsection', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    const handler = createDefaultHandler(deps(store, flowFetch({}, { isAdmin: true })));
    const response = await run(
      handler,
      new Request(`${ISSUER}/authorize/org?id=${id}`),
      envWith(fakeHelpers({ client: clientInfo() }).helpers)
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('name="admin_enabled"');
    expect(html).toContain('Enable admin and debug actions');
    expect(html).toContain(
      'Off by default. Admin and debug actions stay hidden until enabled, and each one needs a code from your authenticator app.'
    );
    // Off by default, in every render: the option never arrives pre-checked.
    expect(html).not.toMatch(/<input[^>]*name="admin_enabled"[^>]*checked/);
    // The subsection is hidden by default and carries the enrolment material
    // (the secret the store just minted) plus the code field.
    expect(html).toContain('<div id="otp-section" hidden>');
    expect(html).toContain('Add an authenticator');
    expect(html).toContain(`<code>${store.authenticators.get('u-1')?.secret}</code>`);
    expect(html).toContain('<code>otpauth://totp/');
    expect(html).toContain(
      '<label for="otp_code">Code from your authenticator app</label>' +
        '<input id="otp_code" name="otp_code" inputmode="numeric" autocomplete="one-time-code">'
    );
    // Nothing on the page names the dropped approval queue.
    expect(html).not.toContain('queue');
  });

  it('reuses the stored authenticator on a re-render instead of minting a new secret', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    const handler = createDefaultHandler(deps(store, flowFetch({}, { isAdmin: true })));
    const env = envWith(fakeHelpers({ client: clientInfo() }).helpers);
    const first = await run(handler, new Request(`${ISSUER}/authorize/org?id=${id}`), env);
    const secret = store.authenticators.get('u-1')?.secret;
    const second = await run(handler, new Request(`${ISSUER}/authorize/org?id=${id}`), env);
    expect(store.authenticators.get('u-1')?.secret).toBe(secret);
    expect(await second.text()).toContain(`<code>${secret}</code>`);
    expect(first.status).toBe(200);
    expect(store.ensureCalls).toBe(2);
  });

  it('fails closed like a failed admin check when the authenticator read throws', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    store.ensureAuthenticator = async () => {
      throw new Error('do storage down');
    };
    const handler = createDefaultHandler(deps(store, flowFetch({}, { isAdmin: true })));
    const response = await run(
      handler,
      new Request(`${ISSUER}/authorize/org?id=${id}`),
      envWith(fakeHelpers({ client: clientInfo() }).helpers)
    );
    // A throw is an internal failure of the admin option, never a reason to
    // block a plain connection: org list and Connect stay, nothing admin shows.
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(
      'We could not check admin access for this account. Reload this page to try again.'
    );
    expect(html).toContain('Nova');
    expect(html).toContain('Connect');
    expect(html).not.toContain('admin_enabled');
    expect(html).not.toContain('id="otp-section"');
    expect(html.match(/We could not check admin access/g)).toHaveLength(1);
  });

  it('shows the notice without a grant when the authenticator read throws on the ticked submit', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    store.ensureAuthenticator = async () => {
      throw new Error('do storage down');
    };
    const { helpers, completes } = fakeHelpers({ client: clientInfo() });
    const response = await run(
      createDefaultHandler(deps(store, flowFetch({}, { isAdmin: true }))),
      new Request(`${ISSUER}/authorize/org?id=${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ organization_id: 'org-2', admin_enabled: 'on' }).toString(),
      }),
      envWith(helpers)
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(
      'We could not check admin access for this account. Reload this page to try again.'
    );
    expect(html).toContain('Connect');
    expect(html).not.toContain('name="admin_enabled"');
    expect(completes).toHaveLength(0);
    expect(store.pending.get(id)?.status).toBe('pending');
  });

  it('still connects without the box when the authenticator read throws', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    store.ensureAuthenticator = async () => {
      throw new Error('do storage down');
    };
    const { helpers, completes } = fakeHelpers({ client: clientInfo() });
    const response = await run(
      createDefaultHandler(deps(store, flowFetch({}, { isAdmin: true }))),
      new Request(`${ISSUER}/authorize/org?id=${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ organization_id: 'org-2' }).toString(),
      }),
      envWith(helpers)
    );
    expect(response.status).toBe(302);
    expect(completes).toHaveLength(1);
    expect(completes[0]?.props).toMatchObject({ adminEnabled: false, adminEligible: false });
    expect(store.pending.get(id)?.status).toBe('completed');
  });

  it('omits the admin opt-in for a non-admin and does not raise the notice', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    const handler = createDefaultHandler(deps(store, flowFetch({}, { isAdmin: false })));
    const response = await run(
      handler,
      new Request(`${ISSUER}/authorize/org?id=${id}`),
      envWith(fakeHelpers({ client: clientInfo() }).helpers)
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    // Empty state: nothing else on the page changes.
    expect(html).toContain('Personal account');
    expect(html).toContain('Connect');
    expect(html).not.toContain('admin_enabled');
    expect(html).not.toContain('Enable admin and debug actions');
    expect(html).not.toContain('Code from your authenticator app');
    expect(html).not.toContain('id="otp-section"');
    expect(html).not.toContain('queue');
    // A valid `false` is not a failed check: no reload notice.
    expect(html).not.toContain('We could not check admin access');
    // A non-admin's page never touches the authenticator store.
    expect(store.ensureCalls).toBe(0);
  });

  it('grants adminEnabled: true and a sessionId only when the code verifies', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    seedAuthenticator(store, 'u-1');
    const { helpers, completes } = fakeHelpers({ client: clientInfo() });
    const response = await run(
      createDefaultHandler(deps(store, flowFetch({}, { isAdmin: true }))),
      new Request(`${ISSUER}/authorize/org?id=${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          organization_id: 'org-2',
          admin_enabled: 'on',
          otp_code: await currentCode(),
        }).toString(),
      }),
      envWith(helpers)
    );
    expect(response.status).toBe(302);
    expect(completes).toHaveLength(1);
    expect(completes[0]?.props).toMatchObject({ adminEnabled: true, adminEligible: true });
    const sessionId = completes[0]?.props.sessionId;
    expect(typeof sessionId).toBe('string');
    expect((sessionId as string).length).toBeGreaterThan(0);
  });

  it('re-renders asking for a code when the opt-in is submitted empty, minting nothing', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    seedAuthenticator(store, 'u-1');
    const { helpers, completes } = fakeHelpers({ client: clientInfo() });
    const response = await run(
      createDefaultHandler(deps(store, flowFetch({}, { isAdmin: true }))),
      new Request(`${ISSUER}/authorize/org?id=${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ organization_id: 'org-2', admin_enabled: 'on' }).toString(),
      }),
      envWith(helpers)
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Enter the code from your authenticator app.');
    // The prompt survives the re-render even though the box is never pre-ticked.
    expect(html).toContain('<div id="otp-section">');
    expect(html).toContain('id="otp_code"');
    expect(html).toContain('value="org-2"');
    expect(completes).toHaveLength(0);
    expect(store.pending.get(id)?.status).toBe('pending');
    // An unknown code is never even checked against the authenticator.
    expect(store.confirmCalls).toBe(0);
  });

  it('re-renders with the invalid-code error and mints no grant for a wrong code', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    seedAuthenticator(store, 'u-1');
    const { helpers, completes } = fakeHelpers({ client: clientInfo() });
    const response = await run(
      createDefaultHandler(deps(store, flowFetch({}, { isAdmin: true }))),
      new Request(`${ISSUER}/authorize/org?id=${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          organization_id: 'org-2',
          admin_enabled: 'on',
          otp_code: await wrongCode(),
        }).toString(),
      }),
      envWith(helpers)
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('That code is not valid. Check your authenticator app and try again.');
    // The code field is still shown so the same submit can be retried.
    expect(html).toContain('<div id="otp-section">');
    expect(html).toContain('id="otp_code"');
    // No grant, no approval, and the pending record is untouched.
    expect(completes).toHaveLength(0);
    expect(store.pending.get(id)?.status).toBe('pending');
    expect(store.confirmCalls).toBe(1);
  });

  it('lets the same pending request complete once the code is corrected', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    seedAuthenticator(store, 'u-1');
    const { helpers, completes } = fakeHelpers({ client: clientInfo() });
    const handler = createDefaultHandler(deps(store, flowFetch({}, { isAdmin: true })));
    const env = envWith(helpers);
    const post = (code: string) =>
      run(
        handler,
        new Request(`${ISSUER}/authorize/org?id=${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            organization_id: 'org-2',
            admin_enabled: 'on',
            otp_code: code,
          }).toString(),
        }),
        env
      );

    const refused = await post(await wrongCode());
    expect(refused.status).toBe(200);

    const accepted = await post(await currentCode());
    expect(accepted.status).toBe(302);
    expect(completes).toHaveLength(1);
    expect(completes[0]?.props).toMatchObject({ adminEnabled: true, adminEligible: true });
    expect(store.pending.get(id)?.status).toBe('completed');
  });

  it('renders the ticked checkbox and no code prompt for an already enrolled admin', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    seedAuthenticator(store, 'u-1', { verified: true });
    const handler = createDefaultHandler(deps(store, flowFetch({}, { isAdmin: true })));
    const response = await run(
      handler,
      new Request(`${ISSUER}/authorize/org?id=${id}`),
      envWith(fakeHelpers({ client: clientInfo() }).helpers)
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    // The tick is the enrolled state; there is nothing else to show.
    expect(html).toContain('name="admin_enabled" value="on" checked');
    expect(html).not.toContain('Code from your authenticator app');
    expect(html).not.toContain('Enter the code');
    expect(html).not.toContain('id="otp-section"');
    expect(html).not.toContain(SECRET);
  });

  it('mints with no code when an already enrolled admin ticks the box', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    seedAuthenticator(store, 'u-1', { verified: true });
    const { helpers, completes } = fakeHelpers({ client: clientInfo() });
    const response = await run(
      createDefaultHandler(deps(store, flowFetch({}, { isAdmin: true }))),
      new Request(`${ISSUER}/authorize/org?id=${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        // No otp_code at all: the verified authenticator's checkbox is the gate.
        body: new URLSearchParams({ organization_id: 'org-2', admin_enabled: 'on' }).toString(),
      }),
      envWith(helpers)
    );
    expect(response.status).toBe(302);
    expect(completes).toHaveLength(1);
    expect(completes[0]?.props).toMatchObject({ adminEnabled: true, adminEligible: true });
    const sessionId = completes[0]?.props.sessionId;
    expect(typeof sessionId).toBe('string');
    expect((sessionId as string).length).toBeGreaterThan(0);
    // The already-verified path never checks a code again.
    expect(store.confirmCalls).toBe(0);
  });

  it('connects with admin disabled when an already enrolled admin leaves the box unticked', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    seedAuthenticator(store, 'u-1', { verified: true });
    const { helpers, completes } = fakeHelpers({ client: clientInfo() });
    const response = await run(
      createDefaultHandler(deps(store, flowFetch({}, { isAdmin: true }))),
      new Request(`${ISSUER}/authorize/org?id=${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ organization_id: 'org-2' }).toString(),
      }),
      envWith(helpers)
    );
    expect(response.status).toBe(302);
    expect(completes).toHaveLength(1);
    expect(completes[0]?.props).toMatchObject({ adminEnabled: false, adminEligible: true });
    const sessionId = completes[0]?.props.sessionId;
    expect(typeof sessionId).toBe('string');
    expect((sessionId as string).length).toBeGreaterThan(0);
    expect(store.confirmCalls).toBe(0);
  });

  it('never grants admin to a non-admin who submits the checkbox (fail-closed)', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    const { helpers, completes } = fakeHelpers({ client: clientInfo() });
    const response = await run(
      createDefaultHandler(deps(store, flowFetch({}, { isAdmin: false }))),
      new Request(`${ISSUER}/authorize/org?id=${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          organization_id: 'org-2',
          admin_enabled: 'on',
          otp_code: await currentCode(),
        }).toString(),
      }),
      envWith(helpers)
    );
    expect(response.status).toBe(302);
    expect(completes).toHaveLength(1);
    expect(completes[0]?.props).toMatchObject({ adminEnabled: false, adminEligible: false });
    // A non-admin's code is never verified.
    expect(store.confirmCalls).toBe(0);
  });

  it('connects with adminEnabled: false and a sessionId when the box is left unticked', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    seedAuthenticator(store, 'u-1');
    const { helpers, completes } = fakeHelpers({ client: clientInfo() });
    const response = await run(
      createDefaultHandler(deps(store, flowFetch({}, { isAdmin: true }))),
      new Request(`${ISSUER}/authorize/org?id=${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        // Even a valid code is ignored without the opt-in.
        body: new URLSearchParams({
          organization_id: 'org-2',
          otp_code: await currentCode(),
        }).toString(),
      }),
      envWith(helpers)
    );
    expect(response.status).toBe(302);
    expect(completes).toHaveLength(1);
    expect(completes[0]?.props).toMatchObject({ adminEnabled: false, adminEligible: true });
    const sessionId = completes[0]?.props.sessionId;
    expect(typeof sessionId).toBe('string');
    expect((sessionId as string).length).toBeGreaterThan(0);
    expect(store.confirmCalls).toBe(0);
  });

  it('shows the reload notice and keeps the org list on the GET when the admin check is unreachable', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    const fetchImpl = flowFetch({
      '/api/trpc/user.getMe': () => {
        throw new Error('down');
      },
    });
    const handler = createDefaultHandler(deps(store, fetchImpl));
    // Retryable unhappy: the org list and the Connect CTA still render, the
    // checkbox is absent, and the notice tells the user to reload.
    const page = await run(
      handler,
      new Request(`${ISSUER}/authorize/org?id=${id}`),
      envWith(fakeHelpers({ client: clientInfo() }).helpers)
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(
      'We could not check admin access for this account. Reload this page to try again.'
    );
    expect(html).toContain('Nova');
    expect(html).toContain('Connect');
    expect(html).not.toContain('admin_enabled');
    // Never render the notice twice in one response.
    expect(html.match(/We could not check admin access/g)).toHaveLength(1);
  });

  it('re-renders the picker with the notice instead of silently dropping a submitted admin opt-in', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    const fetchImpl = flowFetch({
      '/api/trpc/user.getMe': () => {
        throw new Error('down');
      },
    });
    const handler = createDefaultHandler(deps(store, fetchImpl));
    const { helpers, completes } = fakeHelpers({ client: clientInfo() });
    const response = await run(
      handler,
      new Request(`${ISSUER}/authorize/org?id=${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ organization_id: 'org-2', admin_enabled: 'on' }).toString(),
      }),
      envWith(helpers)
    );
    // Retryable unhappy, never a silent downgrade to the happy path: no
    // redirect, no grant minted, and the pending record stays retryable.
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(
      'We could not check admin access for this account. Reload this page to try again.'
    );
    expect(html).toContain('value="org-2"');
    expect(html).toContain('Connect');
    expect(html).not.toContain('name="admin_enabled"');
    expect(html.match(/We could not check admin access/g)).toHaveLength(1);
    expect(completes).toHaveLength(0);
    expect(store.pending.get(id)?.status).toBe('pending');
  });

  it('connects with adminEnabled: true when the retried submit carries a valid code', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    seedAuthenticator(store, 'u-1');
    const downFetch = flowFetch({
      '/api/trpc/user.getMe': () => {
        throw new Error('down');
      },
    });
    const code = await currentCode();
    const post = (env: Env, fetchImpl: typeof fetch) =>
      run(
        createDefaultHandler(deps(store, fetchImpl)),
        new Request(`${ISSUER}/authorize/org?id=${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            organization_id: 'org-2',
            admin_enabled: 'on',
            otp_code: code,
          }).toString(),
        }),
        env
      );

    const blocked = await post(envWith(fakeHelpers({ client: clientInfo() }).helpers), downFetch);
    expect(blocked.status).toBe(200);
    expect(await blocked.text()).toContain('We could not check admin access');

    // Recovery: the same submit retries against a reachable check and connects.
    const { helpers, completes } = fakeHelpers({ client: clientInfo() });
    const recovered = await post(envWith(helpers), flowFetch({}, { isAdmin: true }));
    expect(recovered.status).toBe(302);
    expect(completes).toHaveLength(1);
    expect(completes[0]?.props).toMatchObject({ adminEnabled: true, adminEligible: true });
  });

  it('still completes a submit without the box while the admin check is unreachable', async () => {
    const store = createFakeStore();
    const id = await seedPaired(store);
    const fetchImpl = flowFetch({
      '/api/trpc/user.getMe': () => {
        throw new Error('down');
      },
    });
    const { helpers, completes } = fakeHelpers({ client: clientInfo() });
    const response = await run(
      createDefaultHandler(deps(store, fetchImpl)),
      new Request(`${ISSUER}/authorize/org?id=${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ organization_id: 'org-2' }).toString(),
      }),
      envWith(helpers)
    );
    // Required absence: leaving the box unticked always connects.
    expect(response.status).toBe(302);
    expect(completes).toHaveLength(1);
    expect(completes[0]?.props).toMatchObject({ adminEnabled: false, adminEligible: false });
    expect(store.pending.get(id)?.status).toBe('completed');
  });

  it('ignores an absent or junk admin_enabled value without failing the form', async () => {
    for (const adminEnabled of [undefined, 'junk', 'true', 'off']) {
      const store = createFakeStore();
      const id = await seedPaired(store);
      const { helpers, completes } = fakeHelpers({ client: clientInfo() });
      const body = new URLSearchParams({ organization_id: 'org-2' });
      if (adminEnabled !== undefined) body.set('admin_enabled', adminEnabled);
      const response = await run(
        createDefaultHandler(deps(store, flowFetch({}, { isAdmin: true }))),
        new Request(`${ISSUER}/authorize/org?id=${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        }),
        envWith(helpers)
      );
      expect(response.status).toBe(302);
      expect(completes).toHaveLength(1);
      expect(completes[0]?.props).toMatchObject({ adminEnabled: false });
    }
  });
});

describe('routing', () => {
  it('404s any other path', async () => {
    const store = createFakeStore();
    const handler = createDefaultHandler(deps(store, flowFetch()));
    const response = await run(
      handler,
      new Request(`${ISSUER}/nope`),
      envWith(fakeHelpers({}).helpers)
    );
    expect(response.status).toBe(404);
  });
});
