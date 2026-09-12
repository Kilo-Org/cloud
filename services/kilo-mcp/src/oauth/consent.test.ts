import { describe, expect, it, vi } from 'vitest';
import type {
  AuthRequest,
  ClientInfo,
  CompleteAuthorizationOptions,
  OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';
import { createDefaultHandler } from './consent';
import type { McpAnalytics, OAuthSignInInput } from '../analytics';
import type {
  NewPendingAuthorization,
  OAuthStoreApi,
  PendingAuthorization,
} from '../store/oauth-store';

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
 * In-memory OAuthStoreApi. The methods the consent routes reach are real; the
 * rest throw so a new dependency fails loudly.
 */
function createFakeStore(): OAuthStoreApi & { pending: Map<string, PendingAuthorization> } {
  const pending = new Map<string, PendingAuthorization>();
  const unused = (): never => {
    throw new Error('not reachable from these tests');
  };
  return {
    pending,
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
    purgeExpired: unused,
  };
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
}): { helpers: OAuthHelpers; completes: CompleteAuthorizationOptions[] } {
  const completes: CompleteAuthorizationOptions[] = [];
  const helpers = {
    async parseAuthRequest() {
      if (config.parseError !== undefined) throw config.parseError;
      if (!config.authRequest) throw new Error('no authRequest configured');
      return config.authRequest;
    },
    async lookupClient() {
      return config.client ?? null;
    },
    async completeAuthorization(options: CompleteAuthorizationOptions) {
      completes.push(options);
      return { redirectTo: config.redirectTo ?? `${REDIRECT}?code=lib-code` };
    },
  } as unknown as OAuthHelpers;
  return { helpers, completes };
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
  store: OAuthStoreApi,
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

/** A fetch fake routed by URL for the whole device-auth + org-list flow. */
function flowFetch(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    for (const [suffix, response] of Object.entries(overrides)) {
      if (url.endsWith(suffix)) return response();
    }
    if (url.endsWith('/api/device-auth/codes')) return Response.json({ code: 'PAIR-1' });
    if (url.endsWith('/api/device-auth/codes/PAIR-1')) {
      return Response.json({ status: 'approved', token: 'kilo-tok-1', userId: 'u-1' });
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
