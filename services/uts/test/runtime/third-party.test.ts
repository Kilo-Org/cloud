import { KILO_MCP_CATALOG_CONSENT_TEXT, KILO_MCP_CATALOG_READ_SCOPE } from '@kilocode/uts-contracts';
import { describe, expect, it } from 'vitest';
import type { PendingAuthorization } from '../../src/oauth/authorize';
import type { FeedEntry } from '../../src/revocation/entries';
import type { BrowserSession } from '../../src/signin/store';
import {
  type ClientResolution,
  type ThirdPartyClientsDeps,
  thirdPartyClients,
} from '../../src/third-party/clients';
import { consentStep, handleAppsPage } from '../../src/third-party/consent';
import type { MetadataFetcher } from '../../src/third-party/metadata';
import type {
  CachedClient,
  ThirdPartyAccess,
  ThirdPartyStore,
} from '../../src/third-party/store';
import { recordingPublisher, storeFailure, testScopes } from './oauth-support';
import { ORIGIN } from './signin-support';
import { config, noSignInMethods } from './test-env';

/**
 * Third-party clients (design 5.9): the metadata resolver with a fake store and fetcher, the
 * consent screen inside the sign-in hand-off, and the apps page that withdraws a consent.
 */

const CLIENT_ID = 'https://client.example.com/oauth/client.json';
const REDIRECT = 'https://client.example.com/callback';
const COOKIE = 'C'.repeat(43);
const CONSENT_ID = '7d0a4c2e-5b6f-4e1a-9c3d-2f8e1b7a6c50';
const session: BrowserSession = {
  sessionId: '0b8e6f2a-3c4d-4e5f-8a9b-1c2d3e4f5a6b',
  accountId: 'third-party/runtime-user',
  authTime: new Date(Date.now() - 60_000),
  amr: ['passkey'],
};

type Call = { method: keyof ThirdPartyStore; input: unknown };

/** A third-party store that answers with `implementation` and records every call. */
function fakeStore(implementation: Partial<ThirdPartyStore> = {}) {
  const calls: Call[] = [];
  const recorded =
    <Method extends keyof ThirdPartyStore>(method: Method) =>
    async (...input: Parameters<ThirdPartyStore[Method]>) => {
      calls.push({ method, input: input.length === 1 ? input[0] : input });
      const run = implementation[method] as
        | ((...args: Parameters<ThirdPartyStore[Method]>) => ReturnType<ThirdPartyStore[Method]>)
        | undefined;
      if (run === undefined) throw new Error(`unexpected ${method} call`);
      return await run(...input);
    };
  const store: ThirdPartyStore = {
    readClient: recorded('readClient'),
    saveClient: recorded('saveClient'),
    extendClient: recorded('extendClient'),
    findConsent: recorded('findConsent'),
    grantConsent: recorded('grantConsent'),
    listConsents: recorded('listConsents'),
    withdrawConsent: recorded('withdrawConsent'),
  };
  const access: ThirdPartyAccess = work => work(store);
  return { access, calls };
}

const activeClient = (fresh: boolean): CachedClient => ({
  status: 'active',
  record: { clientId: CLIENT_ID, name: 'Example', redirectUris: [REDIRECT] },
  etag: '"v1"',
  fresh,
});

const metadataDocument = {
  client_id: CLIENT_ID,
  client_name: 'Example',
  redirect_uris: [REDIRECT],
};

function resolverDeps(
  store: ThirdPartyAccess,
  fetcher: MetadataFetcher,
  now = () => 1_000_000
): ThirdPartyClientsDeps {
  return { store, fetcher, now, failures: new Map(), inFlight: new Map() };
}

describe('the third-party client resolver', () => {
  const unusedFetch: MetadataFetcher = async () => {
    throw new Error('unexpected fetch');
  };

  it('serves a fresh cached client without a fetch, and refuses a blocked one', async () => {
    const fresh = fakeStore({ readClient: async () => activeClient(true) });
    expect(await thirdPartyClients(resolverDeps(fresh.access, unusedFetch))(CLIENT_ID)).toEqual({
      kind: 'client',
      client: { clientId: CLIENT_ID, name: 'Example', redirectUris: [REDIRECT] },
    });
    const blocked = fakeStore({ readClient: async () => ({ status: 'blocked' }) });
    expect(await thirdPartyClients(resolverDeps(blocked.access, unusedFetch))(CLIENT_ID)).toEqual({
      kind: 'refused',
      reason: 'blocked',
    });
  });

  it('refuses a client id the URL guard refuses, with no statement and no fetch', async () => {
    const store = fakeStore();
    const resolve = thirdPartyClients(resolverDeps(store.access, unusedFetch));
    expect(await resolve('https://127.0.0.1/client.json')).toEqual({
      kind: 'refused',
      reason: 'client id names an IP address',
    });
    expect(store.calls).toEqual([]);
  });

  it('fetches and stores an unknown client, and revalidates a stale one with its ETag', async () => {
    const saved: unknown[] = [];
    const store = fakeStore({
      readClient: async () => null,
      saveClient: async input => {
        saved.push(input);
        return activeClient(true);
      },
    });
    const fetched = await thirdPartyClients(
      resolverDeps(store.access, async () =>
        Response.json(metadataDocument, { headers: { 'Cache-Control': 'max-age=600' } })
      )
    )(CLIENT_ID);
    expect(fetched.kind).toBe('client');
    expect(saved).toEqual([
      expect.objectContaining({ clientId: CLIENT_ID, cacheSeconds: 600, etag: null }),
    ]);

    const revalidated: string[] = [];
    const stale = fakeStore({
      readClient: async () => activeClient(false),
      extendClient: async (_clientId, seconds) => {
        revalidated.push(String(seconds));
      },
    });
    const fetcher: MetadataFetcher = async (_url, init) => {
      revalidated.push(new Headers(init.headers).get('If-None-Match') ?? 'none');
      return new Response(null, { status: 304 });
    };
    expect((await thirdPartyClients(resolverDeps(stale.access, fetcher))(CLIENT_ID)).kind).toBe(
      'client'
    );
    expect(revalidated).toEqual(['"v1"', '3600']);
  });

  it('keeps a blocked client blocked when a refetch finds its row blocked', async () => {
    const store = fakeStore({
      readClient: async () => null,
      saveClient: async () => ({ status: 'blocked' }),
    });
    expect(
      await thirdPartyClients(resolverDeps(store.access, async () => Response.json(metadataDocument)))(
        CLIENT_ID
      )
    ).toEqual({ kind: 'refused', reason: 'blocked' });
  });

  it('after a failed fetch, does not fetch the same id again for a minute', async () => {
    let now = 1_000_000;
    let fetches = 0;
    const store = fakeStore({ readClient: async () => null });
    const resolve = thirdPartyClients(
      resolverDeps(
        store.access,
        async () => {
          fetches += 1;
          return new Response('', { status: 503 });
        },
        () => now
      )
    );
    expect(await resolve(CLIENT_ID)).toEqual({ kind: 'unavailable' });
    now += 59_000;
    expect(await resolve(CLIENT_ID)).toEqual({ kind: 'unavailable' });
    expect(fetches).toBe(1);
    now += 1_000;
    await resolve(CLIENT_ID);
    expect(fetches).toBe(2);
  });

  it('runs one fetch for concurrent requests of one client id', async () => {
    let fetches = 0;
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const store = fakeStore({
      readClient: async () => null,
      saveClient: async () => activeClient(true),
    });
    const resolve = thirdPartyClients(
      resolverDeps(store.access, async () => {
        fetches += 1;
        await gate;
        return Response.json(metadataDocument);
      })
    );
    const results = Promise.all([resolve(CLIENT_ID), resolve(CLIENT_ID)]);
    await Promise.resolve();
    release();
    const outcomes: ClientResolution[] = await results;
    expect(outcomes.map(outcome => outcome.kind)).toEqual(['client', 'client']);
    expect(fetches).toBe(1);
  });

  it('answers unavailable when the store fails', async () => {
    const store = fakeStore({
      readClient: async () => {
        throw storeFailure('retryable');
      },
    });
    expect(await thirdPartyClients(resolverDeps(store.access, unusedFetch))(CLIENT_ID)).toEqual({
      kind: 'unavailable',
    });
  });
});

const authorizeUrl = `${config.endpoints.issuer}/authorize?client_id=${encodeURIComponent(CLIENT_ID)}`;

const pending: PendingAuthorization = {
  client: { kind: 'third_party', clientId: CLIENT_ID, name: 'Example <app>' },
  redirectUri: REDIRECT,
  scopes: [KILO_MCP_CATALOG_READ_SCOPE],
  audiences: ['kilo-mcp'],
  orgHint: null,
};

function consentPost(fields: Record<string, string | string[]>, origin = ORIGIN): Request {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(name, item);
  }
  return new Request(authorizeUrl, {
    method: 'POST',
    body: body.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: origin,
      Cookie: `__Host-uts_session=${COOKIE}`,
    },
  });
}

describe('the consent screen', () => {
  const step = (store: ThirdPartyAccess) =>
    consentStep({ config, thirdParty: store, scopes: testScopes }, noSignInMethods);

  it('approves at once with an active consent that covers the scopes', async () => {
    const store = fakeStore({ findConsent: async () => CONSENT_ID });
    const result = await step(store.access)(new Request(authorizeUrl), pending, session);
    expect(result).toEqual({
      status: 'approved',
      approval: {
        clientKind: 'third_party',
        consentId: CONSENT_ID,
        accountId: session.accountId,
        browserSessionId: session.sessionId,
        authTime: session.authTime,
        amr: session.amr,
        orgId: null,
      },
    });
    expect(store.calls).toEqual([
      {
        method: 'findConsent',
        input: {
          accountId: session.accountId,
          clientId: CLIENT_ID,
          orgId: null,
          scopes: [KILO_MCP_CATALOG_READ_SCOPE],
        },
      },
    ]);
  });

  it('shows the client, its metadata URL and one box per consent line, escaped, with the redirect in form-action', async () => {
    const store = fakeStore({ findConsent: async () => null });
    const result = await step(store.access)(new Request(authorizeUrl), pending, session);
    if (result.status !== 'interaction') throw new Error('expected the consent page');
    expect(result.response.status).toBe(200);
    const html = await result.response.text();
    expect(html).toContain('Example &lt;app&gt;');
    expect(html).not.toContain('Example <app>');
    expect(html).toContain(CLIENT_ID);
    expect(html).toContain(
      KILO_MCP_CATALOG_CONSENT_TEXT.replace("'", '&#39;')
    );
    expect(html).toContain(`name="consent" value="${KILO_MCP_CATALOG_READ_SCOPE}" required`);
    expect(result.response.headers.get('Content-Security-Policy')).toContain(
      "form-action 'self' https://client.example.com;"
    );
    expect(result.response.headers.get('Cache-Control')).toBe('no-store');
    expect(result.response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('writes the consent from a same-origin POST with every box ticked, and approves with it', async () => {
    const store = fakeStore({
      grantConsent: async () => ({ outcome: 'granted', consentId: CONSENT_ID }),
    });
    const result = await step(store.access)(
      consentPost({ decision: 'allow', consent: KILO_MCP_CATALOG_READ_SCOPE }),
      pending,
      session
    );
    expect(result).toMatchObject({ status: 'approved', approval: { consentId: CONSENT_ID } });
    expect(store.calls).toEqual([
      {
        method: 'grantConsent',
        input: expect.objectContaining({
          environment: 'development',
          clientId: CLIENT_ID,
          orgId: null,
          scopes: [KILO_MCP_CATALOG_READ_SCOPE],
        }),
      },
    ]);
  });

  it('denies on Deny, and shows the page again without a statement when a box is not ticked', async () => {
    const store = fakeStore();
    expect(await step(store.access)(consentPost({ decision: 'deny' }), pending, session)).toEqual({
      status: 'denied',
    });
    const unticked = await step(store.access)(consentPost({ decision: 'allow' }), pending, session);
    if (unticked.status !== 'interaction') throw new Error('expected the consent page');
    expect(unticked.response.status).toBe(400);
    const otherScope = await step(store.access)(
      consentPost({ decision: 'allow', consent: 'kilo-api:mcp.read' }),
      pending,
      session
    );
    expect(otherScope.status).toBe('interaction');
    expect(store.calls).toEqual([]);
  });

  it('refuses a POST from another origin before any statement', async () => {
    const store = fakeStore();
    const result = await step(store.access)(
      consentPost({ decision: 'allow', consent: KILO_MCP_CATALOG_READ_SCOPE }, 'https://evil.example'),
      pending,
      session
    );
    if (result.status !== 'interaction') throw new Error('expected a refusal page');
    expect(result.response.status).toBe(403);
    expect(store.calls).toEqual([]);
  });

  it('asks for the passkey check when the sign-in is older than 10 minutes', async () => {
    const store = fakeStore({ grantConsent: async () => ({ outcome: 'gate_required' }) });
    const result = await step(store.access)(
      consentPost({ decision: 'allow', consent: KILO_MCP_CATALOG_READ_SCOPE }),
      pending,
      session
    );
    if (result.status !== 'interaction') throw new Error('expected the consent page');
    expect(result.response.status).toBe(403);
    expect(await result.response.text()).toContain('data-step-up data-passkey');
  });

  it.each(['unknown_client', 'org_denied'] as const)('denies on %s', async outcome => {
    const store = fakeStore({ grantConsent: async () => ({ outcome }) });
    expect(
      await step(store.access)(
        consentPost({ decision: 'allow', consent: KILO_MCP_CATALOG_READ_SCOPE }),
        pending,
        session
      )
    ).toEqual({ status: 'denied' });
  });

  it('answers 503 with Retry-After when the consent read fails and a retry can succeed', async () => {
    const store = fakeStore({
      findConsent: async () => {
        throw storeFailure('retryable');
      },
    });
    const result = await step(store.access)(new Request(authorizeUrl), pending, session);
    if (result.status !== 'interaction') throw new Error('expected the error page');
    expect(result.response.status).toBe(503);
    expect(result.response.headers.get('Retry-After')).toBe('2');
  });

  it('denies a scope without a consent line', async () => {
    const store = fakeStore();
    expect(
      await step(store.access)(
        new Request(authorizeUrl),
        { ...pending, scopes: ['kilo-api:profile.read'] },
        session
      )
    ).toEqual({ status: 'denied' });
    expect(store.calls).toEqual([]);
  });
});

describe('the apps page', () => {
  const APPS_URL = `${config.endpoints.issuer}/signin/apps`;
  const entry = (): FeedEntry => {
    const now = Date.now();
    return {
      kind: 'third_party_family',
      id: crypto.randomUUID(),
      revokedBefore: null,
      revokedAt: now,
      expiresAt: now + 1_200_000,
    };
  };
  const listing = {
    consentId: CONSENT_ID,
    clientId: CLIENT_ID,
    clientName: 'Example',
    scopes: [KILO_MCP_CATALOG_READ_SCOPE],
    orgId: null,
    grantedAt: new Date('2026-11-26T10:00:00Z'),
  };
  const withdrawPost = (consentId: string, origin = ORIGIN) =>
    new Request(APPS_URL, {
      method: 'POST',
      body: new URLSearchParams({ consent_id: consentId }).toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: origin,
        Cookie: `__Host-uts_session=${COOKIE}`,
      },
    });
  const deps = (store: ThirdPartyAccess, publish = recordingPublisher()) => ({
    config,
    thirdParty: store,
    scopes: testScopes,
    methods: noSignInMethods,
    publish: publish.publish,
  });

  it('lists the apps with their consent lines, and shows sign-in without a session', async () => {
    const store = fakeStore({ listConsents: async () => [listing] });
    const page = await handleAppsPage(
      new Request(APPS_URL, { headers: { Cookie: `__Host-uts_session=${COOKIE}` } }),
      deps(store.access)
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Example');
    expect(html).toContain(`value="${CONSENT_ID}"`);
    expect(html).toContain('Withdraw access');
    const signedOut = await handleAppsPage(new Request(APPS_URL), deps(fakeStore().access));
    expect(await signedOut.text()).toContain('Sign in');
  });

  it('withdraws a consent, publishes its families feed entries, then lists the rest', async () => {
    const entries = [entry(), entry()];
    const publisher = recordingPublisher();
    const store = fakeStore({
      withdrawConsent: async () => ({ outcome: 'withdrawn', endedFamilies: 2, feedEntries: entries }),
      listConsents: async () => [],
    });
    const page = await handleAppsPage(withdrawPost(CONSENT_ID), deps(store.access, publisher));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Access withdrawn');
    expect(publisher.batches).toEqual([entries]);
    expect(store.calls.map(call => call.method)).toEqual(['withdrawConsent', 'listConsents']);
  });

  it('says so when no vouching feed object took the entries, and the withdrawal stands', async () => {
    const store = fakeStore({
      withdrawConsent: async () => ({ outcome: 'withdrawn', endedFamilies: 1, feedEntries: [entry()] }),
      listConsents: async () => [],
    });
    const page = await handleAppsPage(
      withdrawPost(CONSENT_ID),
      deps(store.access, recordingPublisher('unpublished'))
    );
    expect(page.status).toBe(202);
    expect(await page.text()).toContain('few minutes');
  });

  it('refuses a withdrawal from another origin or with a malformed id, before any statement', async () => {
    const store = fakeStore();
    expect((await handleAppsPage(withdrawPost(CONSENT_ID, 'https://evil.example'), deps(store.access))).status).toBe(403);
    expect((await handleAppsPage(withdrawPost('not-a-uuid'), deps(store.access))).status).toBe(400);
    expect(store.calls).toEqual([]);
  });

  it('tells the user when the consent was already gone', async () => {
    const publisher = recordingPublisher();
    const store = fakeStore({
      withdrawConsent: async () => ({ outcome: 'not_found' }),
      listConsents: async () => [],
    });
    const page = await handleAppsPage(withdrawPost(CONSENT_ID), deps(store.access, publisher));
    expect(await page.text()).toContain('no access left');
    expect(publisher.batches).toEqual([]);
  });
});
