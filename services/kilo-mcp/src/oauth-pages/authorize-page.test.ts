import { describe, expect, it, vi } from 'vitest';
import { consentPage, handlePairingStatus, pollKiloPairing } from './authorize-page';
import type { McpAnalytics, OAuthSignInInput } from '../analytics';
import type {
  NewOAuthCode,
  OAuthCodeRecord,
  OAuthStoreApi,
  StoredClient,
} from '../store/oauth-store';

/**
 * In-memory OAuthStoreApi for the consent-page pairing endpoint. Methods these
 * tests never reach throw, so a new handler dependency fails loudly.
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
    registerClient: unused,
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
    async recordPairingApproval(deviceAuthCode, identity, nowIso) {
      for (const [code, record] of codes) {
        if (
          record.deviceAuthCode === deviceAuthCode &&
          record.status === 'pending' &&
          record.kiloUserId === null &&
          record.expiresAt > nowIso
        ) {
          codes.set(code, {
            ...record,
            kiloUserId: identity.kiloUserId,
            kiloToken: identity.kiloToken,
          });
          return true;
        }
      }
      return false;
    },
    async denyCode(deviceAuthCode, nowIso) {
      for (const [code, record] of codes) {
        if (
          record.deviceAuthCode === deviceAuthCode &&
          record.status === 'pending' &&
          record.expiresAt > nowIso
        ) {
          codes.set(code, { ...record, status: 'denied' });
          return true;
        }
      }
      return false;
    },
    async markCodeExpired(deviceAuthCode, nowIso) {
      for (const [code, record] of codes) {
        if (
          record.deviceAuthCode === deviceAuthCode &&
          record.status === 'pending' &&
          record.expiresAt > nowIso
        ) {
          codes.set(code, { ...record, status: 'expired' });
          return true;
        }
      }
      return false;
    },
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
const REDIRECT = 'https://client.test/cb';

function seedPendingCode(store: ReturnType<typeof createFakeOAuthStore>): OAuthCodeRecord {
  const input: NewOAuthCode = {
    code: 'auth-code-value-00000000000000000000000000000000000',
    clientId: 'client-abc',
    redirectUri: REDIRECT,
    codeChallenge: 'challenge-value-000000000000000000000000000000',
    resource: `${ISSUER}/mcp`,
    scope: 'mcp',
    state: 'st-1',
    deviceAuthCode: 'PAIR-1',
    createdAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  void store.createCode(input);
  return { ...input, status: 'pending', kiloUserId: null, organizationId: null, kiloToken: null };
}

function statusRequest(code: string): Request {
  return new Request(`${ISSUER}/authorize/status?code=${encodeURIComponent(code)}`);
}

/** apps/web poll response factory (statuses per codes/[code]/route.ts). */
function upstreamFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return vi.fn(async (input: string | URL) => handler(String(input))) as unknown as typeof fetch;
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

describe('pollKiloPairing (apps/web relay)', () => {
  const deps = { webBaseUrl: WEB };

  it('maps 202/403/410 to pending/denied/expired and calls the poll URL', async () => {
    const calls: string[] = [];
    const outcomes = [
      {
        response: Response.json({ status: 'pending' }, { status: 202 }),
        expect: { status: 'pending' },
      },
      {
        response: Response.json({ status: 'denied' }, { status: 403 }),
        expect: { status: 'denied' },
      },
      {
        response: Response.json({ status: 'expired' }, { status: 410 }),
        expect: { status: 'expired' },
      },
    ];
    for (const { response, expect: expected } of outcomes) {
      const fetchImpl = upstreamFetch(url => {
        calls.push(url);
        return response;
      });
      await expect(pollKiloPairing({ ...deps, fetchImpl }, 'PAIR-9')).resolves.toEqual(expected);
    }
    expect(calls).toEqual([
      `${WEB}/api/device-auth/codes/PAIR-9`,
      `${WEB}/api/device-auth/codes/PAIR-9`,
      `${WEB}/api/device-auth/codes/PAIR-9`,
    ]);
  });

  it('returns token + userId on an approved pairing', async () => {
    const fetchImpl = upstreamFetch(() =>
      Response.json({ status: 'approved', token: 'kilo-jwt', userId: 'u-7', userEmail: 'a@b.c' })
    );
    await expect(pollKiloPairing({ ...deps, fetchImpl }, 'PAIR-9')).resolves.toEqual({
      status: 'approved',
      token: 'kilo-jwt',
      userId: 'u-7',
    });
  });

  it('a transport failure or a malformed approved body is unreachable, never a crash', async () => {
    await expect(
      pollKiloPairing(
        { ...deps, fetchImpl: upstreamFetch(() => Promise.reject(new Error('down'))) },
        'P'
      )
    ).resolves.toEqual({ status: 'unreachable' });
    await expect(
      pollKiloPairing(
        { ...deps, fetchImpl: upstreamFetch(() => Response.json({ status: 'approved' })) },
        'P'
      )
    ).resolves.toEqual({ status: 'unreachable' });
    await expect(
      pollKiloPairing(
        { ...deps, fetchImpl: upstreamFetch(() => Response.json({}, { status: 500 })) },
        'P'
      )
    ).resolves.toEqual({ status: 'unreachable' });
  });
});

describe('GET /authorize/status (consent-page pairing poll)', () => {
  it('reports pending while the user has not approved upstream, and keeps the next poll alive', async () => {
    const store = createFakeOAuthStore();
    const record = seedPendingCode(store);
    const fetchImpl = upstreamFetch(() => Response.json({ status: 'pending' }, { status: 202 }));
    const response = await handlePairingStatus(statusRequest(record.code), {
      store,
      webBaseUrl: WEB,
      fetchImpl,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'pending' });
  });

  it('an approved pairing is persisted once and answered with the org picker', async () => {
    const store = createFakeOAuthStore();
    const record = seedPendingCode(store);
    let approvedAnswers = 0;
    const fetchImpl = upstreamFetch(() => {
      approvedAnswers += 1;
      // Single-use upstream: only the first poll ever sees `approved`.
      if (approvedAnswers === 1) {
        return Response.json({ status: 'approved', token: 'kilo-tok-1', userId: 'u-1' });
      }
      return Response.json({ status: 'expired' }, { status: 410 });
    });
    const deps = { store, webBaseUrl: WEB, fetchImpl };

    await expect(
      handlePairingStatus(statusRequest(record.code), deps).then(r => r.json())
    ).resolves.toEqual({
      status: 'needs_org',
      picker_url: `/authorize/org?code=${record.code}`,
    });
    const stored = store.codes.get(record.code);
    expect(stored).toMatchObject({ kiloUserId: 'u-1', kiloToken: 'kilo-tok-1', status: 'pending' });

    // Second poll: the token is held locally; apps/web is never asked again.
    await expect(
      handlePairingStatus(statusRequest(record.code), deps).then(r => r.json())
    ).resolves.toEqual({
      status: 'needs_org',
      picker_url: `/authorize/org?code=${record.code}`,
    });
    // Exactly one upstream poll per pending record: the single-use approved
    // answer is never replayed against the (now consumed) pairing.
    expect(approvedAnswers).toBe(1);
  });

  it('a denied pairing is persisted and reported as denied', async () => {
    const store = createFakeOAuthStore();
    const record = seedPendingCode(store);
    const fetchImpl = upstreamFetch(() => Response.json({ status: 'denied' }, { status: 403 }));
    await expect(
      handlePairingStatus(statusRequest(record.code), { store, webBaseUrl: WEB, fetchImpl }).then(
        r => r.json()
      )
    ).resolves.toEqual({ status: 'denied' });
    expect(store.codes.get(record.code)?.status).toBe('denied');
    // Terminal: no further upstream polls.
    await handlePairingStatus(statusRequest(record.code), { store, webBaseUrl: WEB, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('concurrent denied polls emit the failure only once', async () => {
    const store = createFakeOAuthStore();
    const record = seedPendingCode(store);
    const fetchImpl = upstreamFetch(() => Response.json({ status: 'denied' }, { status: 403 }));
    const { analytics, calls } = fakeAnalytics();
    const deps = { store, webBaseUrl: WEB, fetchImpl, analytics };
    // Both requests read the same pending record before either persists the
    // denial; only the transition winner may emit.
    const responses = await Promise.all([
      handlePairingStatus(statusRequest(record.code), deps).then(r => r.json()),
      handlePairingStatus(statusRequest(record.code), deps).then(r => r.json()),
    ]);
    expect(responses).toEqual([{ status: 'denied' }, { status: 'denied' }]);
    expect(store.codes.get(record.code)?.status).toBe('denied');
    expect(calls).toHaveLength(1);
  });

  it('an expired upstream pairing reports expired once and persists the terminal state', async () => {
    const store = createFakeOAuthStore();
    const record = seedPendingCode(store);
    const fetchImpl = upstreamFetch(() => Response.json({ status: 'expired' }, { status: 410 }));
    const { analytics, calls } = fakeAnalytics();
    const deps = { store, webBaseUrl: WEB, fetchImpl, analytics };
    await expect(
      handlePairingStatus(statusRequest(record.code), deps).then(r => r.json())
    ).resolves.toEqual({ status: 'expired' });
    // The terminal expiry is persisted so repeated polls answer from the
    // record instead of re-emitting the failure.
    expect(store.codes.get(record.code)?.status).toBe('expired');
    expect(calls).toHaveLength(1);
    await expect(
      handlePairingStatus(statusRequest(record.code), deps).then(r => r.json())
    ).resolves.toEqual({ status: 'expired' });
    expect(calls).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('an unreachable upstream keeps the page waiting instead of failing the flow', async () => {
    const store = createFakeOAuthStore();
    const record = seedPendingCode(store);
    const fetchImpl = upstreamFetch(() => Promise.reject(new Error('network')));
    await expect(
      handlePairingStatus(statusRequest(record.code), { store, webBaseUrl: WEB, fetchImpl }).then(
        r => r.json()
      )
    ).resolves.toEqual({ status: 'pending' });
  });

  it('returns the client redirect (code + state) once the org is chosen', async () => {
    const store = createFakeOAuthStore();
    const record = seedPendingCode(store);
    await store.recordPairingApproval(
      record.deviceAuthCode,
      { kiloUserId: 'u1', kiloToken: 'k' },
      new Date().toISOString()
    );
    await store.approveCode(
      record.deviceAuthCode,
      { kiloUserId: 'u1', organizationId: 'o1' },
      new Date().toISOString()
    );
    const response = await handlePairingStatus(statusRequest(record.code), {
      store,
      webBaseUrl: WEB,
      fetchImpl: upstreamFetch(() => Promise.reject(new Error('must not poll'))),
    });
    const body = (await response.json()) as { status: string; redirect_url: string };
    expect(body.status).toBe('approved');
    const redirect = new URL(body.redirect_url);
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
    expect(redirect.searchParams.get('code')).toBe(record.code);
    expect(redirect.searchParams.get('state')).toBe('st-1');
  });

  it('expired, used, and unknown codes answer identically (no probing oracle)', async () => {
    const store = createFakeOAuthStore();
    const record = seedPendingCode(store);
    const future = new Date(Date.now() + 600_000).toISOString();
    for (const probe of [record.code, 'never-seen']) {
      const response = await handlePairingStatus(statusRequest(probe), {
        store,
        webBaseUrl: WEB,
        fetchImpl: upstreamFetch(() => Promise.reject(new Error('must not poll'))),
        now: () => new Date(future),
      });
      await expect(response.json()).resolves.toEqual({ status: 'unknown' });
    }
  });

  it('rejects non-GET', async () => {
    const store = createFakeOAuthStore();
    const response = await handlePairingStatus(
      new Request(`${ISSUER}/authorize/status`, { method: 'POST' }),
      { store, webBaseUrl: WEB }
    );
    expect(response.status).toBe(405);
  });
});

describe('consentPage (s6 contract)', () => {
  it('escapes the client name and carries needs_org/expired/unknown into failure copy with restart', async () => {
    const response = consentPage({
      clientName: '<script>alert(1)</script>',
      scope: 'mcp',
      webSignInUrl: `${WEB}/device-auth?code=PAIR-1`,
      statusUrl: '/authorize/status?code=abc',
      restartUrl: `${ISSUER}/authorize?client_id=c`,
    });
    const html = await response.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Requested access');
    expect(html).toContain('needs_org');
    expect(html).toContain('expired');
    expect(html).toContain('Start sign-in again');
    expect(html).toContain(`${ISSUER}/authorize?client_id=c`);
    // The restart CTA stays hidden while the page is still waiting, and the
    // stylesheet must not defeat the hidden attribute (an author display rule
    // beats the UA [hidden] rule — see PAGE_STYLE).
    expect(html).toMatch(/id="restart"[^>]*\shidden/);
    expect(html).toContain('[hidden]{display:none !important}');
    // The sign-in link opens in a new tab so the pairing poll in THIS tab
    // survives the trip to apps/web (the old same-tab bug).
    expect(html).toMatch(/class="cta"[^>]*target="_blank"/);
    // The shell carries the Kilo Cloud brand primary, not the old blue CTA.
    expect(html).toContain('--primary:#f7f586');
  });
});

describe('GET /authorize/status analytics (s3)', () => {
  it('records a denial as failed/denied with the client id when upstream reports it', async () => {
    const store = createFakeOAuthStore();
    const record = seedPendingCode(store);
    const fetchImpl = upstreamFetch(() => Response.json({ status: 'denied' }, { status: 403 }));
    const { analytics, calls } = fakeAnalytics();
    await handlePairingStatus(statusRequest(record.code), {
      store,
      webBaseUrl: WEB,
      fetchImpl,
      analytics,
    });
    expect(calls).toEqual([
      { phase: 'failed', identity: null, clientId: 'client-abc', reason: 'denied' },
    ]);
    expectNoCredentialLeak(calls);
  });

  it('emits a denial exactly once across repeated polls of the terminal record', async () => {
    const store = createFakeOAuthStore();
    const record = seedPendingCode(store);
    const fetchImpl = upstreamFetch(() => Response.json({ status: 'denied' }, { status: 403 }));
    const { analytics, calls } = fakeAnalytics();
    const deps = { store, webBaseUrl: WEB, fetchImpl, analytics };
    await expect(
      handlePairingStatus(statusRequest(record.code), deps).then(r => r.json())
    ).resolves.toEqual({ status: 'denied' });
    // The record is now terminal `denied`; every later poll must answer the
    // same way WITHOUT re-emitting (the failure was already recorded at the
    // transition) and without asking apps/web again.
    for (let poll = 0; poll < 3; poll += 1) {
      await expect(
        handlePairingStatus(statusRequest(record.code), deps).then(r => r.json())
      ).resolves.toEqual({ status: 'denied' });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      { phase: 'failed', identity: null, clientId: 'client-abc', reason: 'denied' },
    ]);
    expectNoCredentialLeak(calls);
  });

  it('an already-denied record answers denied without emitting or polling upstream', async () => {
    const store = createFakeOAuthStore();
    const record = seedPendingCode(store);
    store.codes.set(record.code, { ...store.codes.get(record.code)!, status: 'denied' });
    const { analytics, calls } = fakeAnalytics();
    const fetchImpl = upstreamFetch(() => Promise.reject(new Error('must not poll')));
    const response = await handlePairingStatus(statusRequest(record.code), {
      store,
      webBaseUrl: WEB,
      fetchImpl,
      analytics,
    });
    await expect(response.json()).resolves.toEqual({ status: 'denied' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('records an expired pairing as failed/expired', async () => {
    const store = createFakeOAuthStore();
    const record = seedPendingCode(store);
    const fetchImpl = upstreamFetch(() => Response.json({ status: 'expired' }, { status: 410 }));
    const { analytics, calls } = fakeAnalytics();
    await handlePairingStatus(statusRequest(record.code), {
      store,
      webBaseUrl: WEB,
      fetchImpl,
      analytics,
    });
    expect(calls).toEqual([
      { phase: 'failed', identity: null, clientId: 'client-abc', reason: 'expired' },
    ]);
    expectNoCredentialLeak(calls);
  });

  it('records nothing while the pairing is pending or unreachable', async () => {
    const store = createFakeOAuthStore();
    const record = seedPendingCode(store);
    const { analytics, calls } = fakeAnalytics();
    await handlePairingStatus(statusRequest(record.code), {
      store,
      webBaseUrl: WEB,
      fetchImpl: upstreamFetch(() => Response.json({ status: 'pending' }, { status: 202 })),
      analytics,
    });
    await handlePairingStatus(statusRequest(record.code), {
      store,
      webBaseUrl: WEB,
      fetchImpl: upstreamFetch(() => Promise.reject(new Error('network'))),
      analytics,
    });
    expect(calls).toEqual([]);
  });
});
