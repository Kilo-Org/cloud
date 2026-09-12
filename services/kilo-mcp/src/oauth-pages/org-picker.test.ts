import { describe, expect, it, vi } from 'vitest';
import {
  fetchOrgOptions,
  handleOrgPicker,
  ORG_LIST_QUERY_PATH,
  PERSONAL_ORG_ID,
} from './org-picker';
import type {
  NewOAuthCode,
  OAuthCodeRecord,
  OAuthStoreApi,
  StoredClient,
} from '../store/oauth-store';

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
      return clients.get(clientId) ?? null;
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
      return codes.get(code) ?? null;
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

function seedPairedCode(store: ReturnType<typeof createFakeOAuthStore>): OAuthCodeRecord {
  const input: NewOAuthCode = {
    code: 'auth-code-value-00000000000000000000000000000000000',
    clientId: CLIENT_ID,
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
  void store.recordPairingApproval(
    input.deviceAuthCode,
    { kiloUserId: 'u-1', kiloToken: 'kilo-tok-1' },
    new Date().toISOString()
  );
  store.clients.set(CLIENT_ID, {
    clientId: CLIENT_ID,
    redirectUris: [REDIRECT],
    clientName: 'Test Client',
    createdAt: '2026-09-09T00:00:00.000Z',
  });
  return { ...store.codes.get(input.code)! };
}

function trpcOrgFetch(orgs: Array<{ organizationId: string; organizationName: string }>) {
  return vi.fn(async () => Response.json({ result: { data: orgs } }));
}

function pickerUrl(code: string): string {
  return `${ISSUER}/authorize/org?code=${encodeURIComponent(code)}`;
}

describe('fetchOrgOptions (organizations.list via the Kilo bearer)', () => {
  it('calls the catalog query with the Kilo bearer and lists personal first', async () => {
    const fetchImpl = trpcOrgFetch([
      { organizationId: 'org-1', organizationName: 'Acme' },
      { organizationId: 'org-2', organizationName: 'Nova' },
    ]);
    const options = await fetchOrgOptions({ webBaseUrl: WEB, fetchImpl }, 'kilo-tok-1');
    expect(options).toEqual([
      { id: PERSONAL_ORG_ID, name: 'Personal account' },
      { id: 'org-1', name: 'Acme' },
      { id: 'org-2', name: 'Nova' },
    ]);
    const [calledUrl, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe(`${WEB}/api/trpc/${ORG_LIST_QUERY_PATH}`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer kilo-tok-1');
  });

  it('dedupes ids and skips malformed rows', async () => {
    const fetchImpl = trpcOrgFetch([
      { organizationId: 'org-1', organizationName: 'Acme' },
      { organizationId: 'org-1', organizationName: 'dup' },
      { organizationName: 'no id' },
      'garbage',
    ] as never);
    const options = await fetchOrgOptions({ webBaseUrl: WEB, fetchImpl }, 'k');
    expect(options.map(o => o.id)).toEqual([PERSONAL_ORG_ID, 'org-1']);
  });

  it('throws on a non-OK or unexpected upstream (caller renders a retry)', async () => {
    await expect(
      fetchOrgOptions(
        {
          webBaseUrl: WEB,
          fetchImpl: vi.fn(async () => Response.json({}, { status: 500 })) as never,
        },
        'k'
      )
    ).rejects.toThrow();
    await expect(
      fetchOrgOptions(
        { webBaseUrl: WEB, fetchImpl: vi.fn(async () => Response.json({ nope: 1 })) as never },
        'k'
      )
    ).rejects.toThrow();
  });
});

describe('GET /authorize/org (picker render)', () => {
  it('renders the personal context plus each of the user organizations', async () => {
    const store = createFakeOAuthStore();
    const record = seedPairedCode(store);
    const response = await handleOrgPicker(new Request(pickerUrl(record.code)), {
      store,
      webBaseUrl: WEB,
      fetchImpl: trpcOrgFetch([
        { organizationId: 'org-1', organizationName: 'Acme' },
      ]) as unknown as typeof fetch,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('Choose a Kilo organization');
    expect(html).toContain('Test Client');
    expect(html).toContain('Personal account');
    expect(html).toContain('Acme');
    expect(html).toContain(`value="${PERSONAL_ORG_ID}"`);
    expect(html).toContain('value="org-1"');
    expect(html).toContain(`action="/authorize/org?code=${record.code}"`);
  });

  it('escapes an organization name', async () => {
    const store = createFakeOAuthStore();
    const record = seedPairedCode(store);
    const response = await handleOrgPicker(new Request(pickerUrl(record.code)), {
      store,
      webBaseUrl: WEB,
      fetchImpl: trpcOrgFetch([
        { organizationId: 'o', organizationName: '<b>x</b>' },
      ]) as unknown as typeof fetch,
    });
    const html = await response.text();
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
  });

  it('offers a retry with the personal context when the org list fails', async () => {
    const store = createFakeOAuthStore();
    const record = seedPairedCode(store);
    const response = await handleOrgPicker(new Request(pickerUrl(record.code)), {
      store,
      webBaseUrl: WEB,
      fetchImpl: vi.fn(async () => {
        throw new Error('upstream down');
      }) as unknown as typeof fetch,
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/Could not load your organizations/);
    expect(html).toContain('Personal account');
  });

  it('completes the client redirect when the org was already chosen', async () => {
    const store = createFakeOAuthStore();
    const record = seedPairedCode(store);
    await store.approveCode(
      record.deviceAuthCode,
      { kiloUserId: 'u-1', organizationId: 'org-1' },
      new Date().toISOString()
    );
    const response = await handleOrgPicker(new Request(pickerUrl(record.code)), {
      store,
      webBaseUrl: WEB,
      fetchImpl: vi.fn(() =>
        Promise.reject(new Error('must not fetch'))
      ) as unknown as typeof fetch,
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location')!);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get('code')).toBe(record.code);
    expect(location.searchParams.get('state')).toBe('st-1');
  });

  it('sends an unpaired code back through the consent page', async () => {
    const store = createFakeOAuthStore();
    const record = seedPairedCode(store);
    // Roll the identity back: pairing not finished upstream yet.
    store.codes.set(record.code, { ...record, kiloUserId: null, kiloToken: null });
    const response = await handleOrgPicker(new Request(pickerUrl(record.code)), {
      store,
      webBaseUrl: WEB,
      fetchImpl: vi.fn(() =>
        Promise.reject(new Error('must not fetch'))
      ) as unknown as typeof fetch,
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Connect to Kilo MCP');
    expect(html).toContain(`${WEB}/device-auth?code=${record.deviceAuthCode}`);
  });

  it('rejects unknown, expired, used, and denied codes with an error page', async () => {
    const store = createFakeOAuthStore();
    const record = seedPairedCode(store);
    const fetchImpl = vi.fn(() =>
      Promise.reject(new Error('must not fetch'))
    ) as unknown as typeof fetch;
    const deps = { store, webBaseUrl: WEB, fetchImpl };
    await expect(
      handleOrgPicker(new Request(pickerUrl('ghost')), deps).then(r => r.status)
    ).resolves.toBe(400);
    store.codes.set(record.code, { ...record, status: 'denied' });
    await expect(
      handleOrgPicker(new Request(pickerUrl(record.code)), deps).then(r => r.status)
    ).resolves.toBe(400);
    store.codes.set(record.code, { ...record, status: 'used' });
    await expect(
      handleOrgPicker(new Request(pickerUrl(record.code)), deps).then(r => r.status)
    ).resolves.toBe(400);
    store.codes.set(record.code, {
      ...record,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await expect(
      handleOrgPicker(new Request(pickerUrl(record.code)), deps).then(r => r.status)
    ).resolves.toBe(400);
  });
});

describe('POST /authorize/org (bind the org and complete)', () => {
  async function post(
    store: ReturnType<typeof createFakeOAuthStore>,
    record: OAuthCodeRecord,
    organizationId: string | null,
    orgs: Array<{ organizationId: string; organizationName: string }>
  ) {
    const form = new URLSearchParams();
    if (organizationId !== null) form.set('organization_id', organizationId);
    const response = await handleOrgPicker(
      new Request(pickerUrl(record.code), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      }),
      { store, webBaseUrl: WEB, fetchImpl: trpcOrgFetch(orgs) as unknown as typeof fetch }
    );
    return response;
  }

  it('binds a member organization into the authorization and redirects with the code', async () => {
    const store = createFakeOAuthStore();
    const record = seedPairedCode(store);
    const response = await post(store, record, 'org-2', [
      { organizationId: 'org-1', organizationName: 'Acme' },
      { organizationId: 'org-2', organizationName: 'Nova' },
    ]);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location')!);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get('code')).toBe(record.code);
    expect(location.searchParams.get('state')).toBe('st-1');
    const approved = store.codes.get(record.code);
    expect(approved).toMatchObject({
      status: 'approved',
      kiloUserId: 'u-1',
      organizationId: 'org-2',
    });
  });

  it('the personal context authorizes with a null organization', async () => {
    const store = createFakeOAuthStore();
    const record = seedPairedCode(store);
    const response = await post(store, record, PERSONAL_ORG_ID, [
      { organizationId: 'org-1', organizationName: 'Acme' },
    ]);
    expect(response.status).toBe(302);
    expect(store.codes.get(record.code)).toMatchObject({
      status: 'approved',
      organizationId: null,
    });
  });

  it('the personal selection completes even when the org list fetch fails (no dead-end retry loop)', async () => {
    const store = createFakeOAuthStore();
    const record = seedPairedCode(store);
    const response = await handleOrgPicker(
      new Request(pickerUrl(record.code), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ organization_id: PERSONAL_ORG_ID }).toString(),
      }),
      {
        store,
        webBaseUrl: WEB,
        fetchImpl: vi.fn(async () => {
          throw new Error('upstream down');
        }) as unknown as typeof fetch,
      }
    );
    // The personal context is always valid for an approved Kilo login: the
    // submit must complete, not be discarded behind the failed membership read.
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location')!);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get('code')).toBe(record.code);
    expect(store.codes.get(record.code)).toMatchObject({
      status: 'approved',
      organizationId: null,
    });
  });

  it('a concrete org selection with a failed org list fetch stays retryable (no approval)', async () => {
    const store = createFakeOAuthStore();
    const record = seedPairedCode(store);
    const response = await handleOrgPicker(
      new Request(pickerUrl(record.code), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ organization_id: 'org-1' }).toString(),
      }),
      {
        store,
        webBaseUrl: WEB,
        fetchImpl: vi.fn(async () => {
          throw new Error('upstream down');
        }) as unknown as typeof fetch,
      }
    );
    // Membership cannot be verified without the live read, so the concrete org
    // is refused retryably and only the (still valid) personal context is offered.
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/Could not load your organizations/);
    expect(html).toContain('Personal account');
    expect(store.codes.get(record.code)?.status).toBe('pending');
  });

  it('refuses an organization the user is not a member of (edited form)', async () => {
    const store = createFakeOAuthStore();
    const record = seedPairedCode(store);
    const response = await post(store, record, 'org-victim', [
      { organizationId: 'org-1', organizationName: 'Acme' },
    ]);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/not available for this account/);
    expect(store.codes.get(record.code)?.status).toBe('pending');
  });

  it('a missing selection re-renders the picker with a prompt', async () => {
    const store = createFakeOAuthStore();
    const record = seedPairedCode(store);
    const response = await post(store, record, null, [
      { organizationId: 'org-1', organizationName: 'Acme' },
    ]);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/Choose an account/);
    expect(store.codes.get(record.code)?.status).toBe('pending');
  });

  it('a lost race to expiry/denial does not redirect', async () => {
    const store = createFakeOAuthStore();
    const record = seedPairedCode(store);
    // Simulate a concurrent denial between render and submit.
    store.codes.set(record.code, { ...record, status: 'denied' });
    const response = await post(store, record, 'org-1', [
      { organizationId: 'org-1', organizationName: 'Acme' },
    ]);
    expect(response.status).toBe(400);
  });
});
