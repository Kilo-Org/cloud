import { describe, expect, it, vi } from 'vitest';
import { handleAuthorize } from './authorize';
import { codeChallengeFromVerifier, generateCodeVerifier } from './pkce';
import type { McpAnalytics, OAuthSignInInput } from '../analytics';
import type {
  NewOAuthCode,
  OAuthCodeRecord,
  OAuthStoreApi,
  StoredClient,
} from '../store/oauth-store';

/**
 * In-memory OAuthStoreApi for these endpoint tests. Methods these tests never
 * reach throw, so a new handler dependency fails loudly instead of silently.
 */
function createFakeOAuthStore(): OAuthStoreApi & {
  clients: Map<string, StoredClient>;
  codes: Map<string, OAuthCodeRecord>;
} {
  const clients = new Map<string, StoredClient>();
  const codes = new Map<string, OAuthCodeRecord>();
  const unused = (): never => {
    throw new Error('not reachable from these tests');
  };
  return {
    clients,
    codes,
    async registerClient(input) {
      clients.set(input.clientId, { ...input, redirectUris: [...input.redirectUris] });
      return true;
    },
    async getClient(clientId) {
      const client = clients.get(clientId);
      return client ? { ...client, redirectUris: [...client.redirectUris] } : null;
    },
    async createCode(input: NewOAuthCode) {
      codes.set(input.code, {
        ...input,
        status: 'pending',
        kiloUserId: null,
        organizationId: null,
        kiloToken: null,
      });
    },
    async getCode(code) {
      const record = codes.get(code);
      return record ? { ...record } : null;
    },
    recordPairingApproval: unused,
    denyCode: unused,
    markCodeExpired: unused,
    async approveCode(deviceAuthCode, identity, nowIso) {
      for (const [code, record] of codes) {
        if (
          record.deviceAuthCode === deviceAuthCode &&
          record.status === 'pending' &&
          record.expiresAt > nowIso
        ) {
          codes.set(code, {
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
    consumeCode: unused,
    createPendingAuthorization: unused,
    getPendingAuthorization: unused,
    denyPendingAuthorization: unused,
    expirePendingAuthorization: unused,
    approvePendingAuthorization: unused,
    completePendingAuthorization: unused,
    saveRefreshToken: unused,
    getRefreshTokenByHash: unused,
    rotateRefreshToken: unused,
    getKiloToken: unused,
    revokeGrant: unused,
    revokeJti: unused,
    async isJtiRevoked() {
      return false;
    },
    purgeExpired: unused,
  };
}

const ISSUER = 'https://kilo-mcp.test';
const WEB = 'https://app.kilo.test';
const CLIENT_ID = 'client-abc';
const REDIRECT = 'https://client.test/cb';
const RESOURCE = `${ISSUER}/mcp`;

const verifier = generateCodeVerifier();

function storeWithClient(): ReturnType<typeof createFakeOAuthStore> {
  const store = createFakeOAuthStore();
  store.clients.set(CLIENT_ID, {
    clientId: CLIENT_ID,
    redirectUris: [REDIRECT],
    clientName: 'Test Client',
    createdAt: '2026-09-09T00:00:00.000Z',
  });
  return store;
}

function authorizeUrl(params: Record<string, string | undefined>): string {
  const url = new URL(`${ISSUER}/authorize`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

function deviceAuthFetch(code = 'PAIR-1234') {
  return vi.fn(async () =>
    Response.json({
      code,
      user_code: code,
      device_code: 'dev-secret',
      verificationUrl: `${WEB}/device-auth?code=${code}`,
      expiresIn: 600,
    })
  );
}

/**
 * Fake emitter cast to the production `McpAnalytics` interface: the tests
 * assert exactly what the worker hands it, so a new field cannot slip past.
 */
function fakeAnalytics(): { analytics: McpAnalytics; calls: OAuthSignInInput[] } {
  const calls: OAuthSignInInput[] = [];
  const analytics = {
    oauthSignIn: vi.fn((input: OAuthSignInInput) => {
      calls.push(input);
    }),
  } as unknown as McpAnalytics;
  return { analytics, calls };
}

const OAUTH_EVENT_FIELDS = ['clientId', 'identity', 'phase', 'reason'];
const IDENTITY_FIELDS = ['kiloUserId', 'organizationId'];

/**
 * The sign-in events must carry no token, authorization code, PKCE verifier,
 * or state: every recorded event exposes only the documented fields.
 */
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

async function authorize(
  overrides: Record<string, string | undefined> = {},
  deps: { store?: OAuthStoreApi; fetchImpl?: typeof fetch; analytics?: McpAnalytics } = {}
): Promise<{ response: Response; store: ReturnType<typeof createFakeOAuthStore> }> {
  const store = deps.store ?? storeWithClient();
  const response = await handleAuthorize(
    new Request(
      authorizeUrl({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        response_type: 'code',
        scope: 'mcp',
        state: 'st-1',
        code_challenge: await codeChallengeFromVerifier(verifier),
        code_challenge_method: 'S256',
        resource: RESOURCE,
        ...overrides,
      })
    ),
    {
      store,
      webBaseUrl: WEB,
      fetchImpl: (deps.fetchImpl ?? deviceAuthFetch()) as typeof fetch,
      analytics: deps.analytics,
    }
  );
  return { response, store: store as ReturnType<typeof createFakeOAuthStore> };
}

describe('GET /authorize (happy)', () => {
  it('creates the pairing record and links the user to the Kilo device-auth page', async () => {
    const fetchImpl = deviceAuthFetch('PAIR-9999');
    const { response, store } = await authorize({}, { fetchImpl });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe(`${WEB}/api/device-auth/codes`);
    expect(init.method).toBe('POST');

    expect(store.codes.size).toBe(1);
    const record = [...store.codes.values()][0];
    expect(record).toMatchObject({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      resource: RESOURCE,
      scope: 'mcp',
      state: 'st-1',
      status: 'pending',
      deviceAuthCode: 'PAIR-9999',
    });
    expect(record.code.length).toBeGreaterThanOrEqual(43);
    expect(new Date(record.expiresAt).getTime() - Date.now()).toBeGreaterThan(9 * 60_000);

    const html = await response.text();
    expect(html).toContain(`${WEB}/device-auth?code=PAIR-9999`);
    expect(html).toContain('Test Client');
    expect(html).toContain('/authorize/status?code=');
    // s6: the page shows the requested scope and offers a restart (fresh
    // authorize) when the pairing fails.
    expect(html).toContain('Requested access');
    expect(html).toContain('mcp');
    const restart = new URL(
      html.match(/<a id="restart" class="secondary" href="([^"]+)"/)![1]!.replace(/&amp;/g, '&')
    );
    expect(restart.pathname).toBe('/authorize');
    expect(restart.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(restart.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(restart.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('forwards the client IP and user-agent to apps/web (pending-request rate limit)', async () => {
    const fetchImpl = deviceAuthFetch();
    const response = await handleAuthorize(
      new Request(
        authorizeUrl({
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT,
          response_type: 'code',
          code_challenge: await codeChallengeFromVerifier(verifier),
          code_challenge_method: 'S256',
        }),
        { headers: { 'CF-Connecting-IP': '203.0.113.7', 'user-agent': 'MCPTest/1.0' } }
      ),
      {
        store: storeWithClient(),
        webBaseUrl: WEB,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }
    );
    expect(response.status).toBe(200);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-forwarded-for']).toBe('203.0.113.7');
    expect(headers['user-agent']).toBe('MCPTest/1.0');
  });

  it('defaults the scope to mcp and the resource to this MCP when omitted', async () => {
    const { store } = await authorize({ scope: undefined, resource: undefined });
    const record = [...store.codes.values()][0];
    expect(record.scope).toBe('mcp');
    expect(record.resource).toBe(RESOURCE);
  });
});

describe('GET /authorize (non-retryable unhappy: explicit errors, no token path)', () => {
  it('unknown client_id renders an error page and never redirects', async () => {
    const { response } = await authorize({ client_id: 'ghost' });
    expect(response.status).toBe(400);
    expect(response.headers.get('Location')).toBeNull();
    const html = await response.text();
    expect(html).toMatch(/Unknown client_id/);
  });

  it('redirect_uri mismatch renders an error page (exact match required)', async () => {
    const { response } = await authorize({ redirect_uri: 'https://client.test/cb?next=1' });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toMatch(/does not exactly match/);
  });

  it('missing PKCE redirects the client with invalid_request', async () => {
    const { response } = await authorize({
      code_challenge: undefined,
      code_challenge_method: undefined,
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location')!);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('st-1');
  });

  it('plain (non-S256) PKCE is rejected', async () => {
    const { response } = await authorize({ code_challenge_method: 'plain' });
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('Location')!).searchParams.get('error')).toBe(
      'invalid_request'
    );
  });

  it('a foreign resource indicator redirects with invalid_target', async () => {
    const { response } = await authorize({ resource: 'https://other-mcp.test/mcp' });
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('Location')!).searchParams.get('error')).toBe(
      'invalid_target'
    );
  });

  it('an unknown scope redirects with invalid_scope', async () => {
    const { response } = await authorize({ scope: 'admin' });
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('Location')!).searchParams.get('error')).toBe(
      'invalid_scope'
    );
  });

  it('only response_type=code is supported', async () => {
    const { response } = await authorize({ response_type: 'token' });
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('Location')!).searchParams.get('error')).toBe(
      'unsupported_response_type'
    );
  });
});

describe('GET /authorize (retryable unhappy: Kilo pairing unavailable)', () => {
  it('a web rate-limit (429) renders a wait-and-retry message and stores no record', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: 'too many' }, { status: 429 }));
    const { response, store } = await authorize(
      {},
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    );
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toMatch(/Wait a few minutes/);
    expect(store.codes.size).toBe(0);
  });

  it('an unreachable web renders a retry message and stores no record', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const { response, store } = await authorize(
      {},
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    );
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toMatch(/could not be reached/);
    expect(store.codes.size).toBe(0);
  });
});

describe('GET /authorize analytics (s3)', () => {
  it('emits exactly one anonymous started event with the client_id on success', async () => {
    const { analytics, calls } = fakeAnalytics();
    const { response } = await authorize({}, { analytics });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ phase: 'started', identity: null, clientId: CLIENT_ID });
    expectNoCredentialLeak(calls);
  });

  it('reports a rate-limited pairing as failed with that reason', async () => {
    const { analytics, calls } = fakeAnalytics();
    const fetchImpl = vi.fn(async () => Response.json({ error: 'too many' }, { status: 429 }));
    const { response } = await authorize(
      {},
      { fetchImpl: fetchImpl as unknown as typeof fetch, analytics }
    );
    expect(response.status).toBe(503);
    expect(calls).toEqual([
      { phase: 'failed', identity: null, clientId: CLIENT_ID, reason: 'rate_limited' },
    ]);
    expectNoCredentialLeak(calls);
  });

  it('reports an unreachable pairing as failed with that reason', async () => {
    const { analytics, calls } = fakeAnalytics();
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    await authorize({}, { fetchImpl: fetchImpl as unknown as typeof fetch, analytics });
    expect(calls).toEqual([
      { phase: 'failed', identity: null, clientId: CLIENT_ID, reason: 'unreachable' },
    ]);
    expectNoCredentialLeak(calls);
  });

  it('reports a redirectable validation error as failed with the OAuth error code', async () => {
    const { analytics, calls } = fakeAnalytics();
    await authorize({ resource: 'https://other.test/mcp' }, { analytics });
    expect(calls).toEqual([
      { phase: 'failed', identity: null, clientId: CLIENT_ID, reason: 'invalid_target' },
    ]);
    expectNoCredentialLeak(calls);
  });

  it('reports a rendered validation error and omits clientId when it was not parsed', async () => {
    const { analytics, calls } = fakeAnalytics();
    // `authorizeUrl` drops undefined params, so this request has no client_id.
    await authorize({ client_id: undefined }, { analytics });
    expect(calls).toStrictEqual([{ phase: 'failed', identity: null, reason: 'invalid_request' }]);
    expectNoCredentialLeak(calls);
  });
});
