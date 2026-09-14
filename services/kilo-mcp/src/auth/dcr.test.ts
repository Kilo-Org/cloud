import { describe, expect, it } from 'vitest';
import { handleRegistration, validateRedirectUri } from './dcr';
import type { OAuthStoreApi, StoredClient } from '../store/oauth-store';

/**
 * In-memory OAuthStoreApi for these endpoint tests. Methods these tests never
 * reach throw, so a new handler dependency fails loudly instead of silently.
 */
function createFakeOAuthStore(): OAuthStoreApi & { clients: Map<string, StoredClient> } {
  const clients = new Map<string, StoredClient>();
  const unused = (): never => {
    throw new Error('not reachable from these tests');
  };
  return {
    clients,
    async registerClient(input) {
      clients.set(input.clientId, { ...input, redirectUris: [...input.redirectUris] });
      return true;
    },
    async getClient(clientId) {
      const client = clients.get(clientId);
      return client ? { ...client, redirectUris: [...client.redirectUris] } : null;
    },
    createCode: unused,
    getCode: unused,
    recordPairingApproval: unused,
    denyCode: unused,
    markCodeExpired: unused,
    approveCode: unused,
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

const NOW = new Date('2026-09-09T12:00:00.000Z');

function registrationRequest(body: unknown, method = 'POST'): Request {
  return new Request('https://kilo-mcp.test/register', {
    method,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Shape of the /register JSON responses asserted below. */
type RegistrationBody = {
  client_id: string;
  client_secret?: string;
  token_endpoint_auth_method?: string;
  redirect_uris?: string[];
  client_name?: string;
  grant_types?: string[];
  scope?: string;
  error?: string;
  error_description?: string;
};

async function handle(body: unknown) {
  const store = createFakeOAuthStore();
  const response = await handleRegistration(registrationRequest(body), { store, now: () => NOW });
  return { store, response };
}

describe('validateRedirectUri', () => {
  it('accepts https URIs', () => {
    expect(validateRedirectUri('https://client.test/callback').ok).toBe(true);
    expect(validateRedirectUri('https://client.test:8443/cb?x=1').ok).toBe(true);
  });

  it('accepts loopback http (native apps, RFC 8252)', () => {
    expect(validateRedirectUri('http://localhost:8765/callback').ok).toBe(true);
    expect(validateRedirectUri('http://127.0.0.1:33411/').ok).toBe(true);
    expect(validateRedirectUri('http://127.0.0.53:9/cb').ok).toBe(true);
    expect(validateRedirectUri('http://[::1]:8080/cb').ok).toBe(true);
  });

  it('rejects non-loopback http, other schemes, fragments, userinfo, and junk', () => {
    expect(validateRedirectUri('http://evil.test/cb').ok).toBe(false);
    expect(validateRedirectUri('myapp://callback').ok).toBe(false);
    expect(validateRedirectUri('https://client.test/cb#frag').ok).toBe(false);
    expect(validateRedirectUri('https://user:pw@client.test/cb').ok).toBe(false);
    expect(validateRedirectUri('not-a-url').ok).toBe(false);
    expect(validateRedirectUri(42).ok).toBe(false);
    expect(validateRedirectUri('').ok).toBe(false);
  });
});

describe('POST /register (happy)', () => {
  it('persists the client and answers 201 with client_id and no secret', async () => {
    const { store, response } = await handle({
      client_name: 'Kilo CLI',
      redirect_uris: ['https://client.test/cb', 'http://localhost:1234/cb'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    const body = (await response.json()) as RegistrationBody;
    expect(response.status).toBe(201);
    expect(typeof body.client_id).toBe('string');
    expect(body.client_id.length).toBeGreaterThanOrEqual(43);
    expect(body.client_secret).toBeUndefined();
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.redirect_uris).toEqual(['https://client.test/cb', 'http://localhost:1234/cb']);
    expect(body.client_name).toBe('Kilo CLI');

    const stored = await store.getClient(body.client_id);
    expect(stored).toMatchObject({ clientName: 'Kilo CLI', createdAt: NOW.toISOString() });
    expect(stored?.redirectUris).toEqual(['https://client.test/cb', 'http://localhost:1234/cb']);
  });

  it('defaults client_name, grants, and scope when omitted', async () => {
    const { response } = await handle({ redirect_uris: ['https://client.test/cb'] });
    const body = (await response.json()) as RegistrationBody;
    expect(response.status).toBe(201);
    expect(body.client_name).toBe('Unnamed client');
    expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(body.scope).toBe('mcp');
  });

  it('deduplicates repeated redirect URIs', async () => {
    const { response } = await handle({
      redirect_uris: ['https://a.test/cb', 'https://a.test/cb'],
    });
    const body = (await response.json()) as RegistrationBody;
    expect(body.redirect_uris).toEqual(['https://a.test/cb']);
  });

  it('issues distinct client ids per registration', async () => {
    const { response: first } = await handle({ redirect_uris: ['https://a.test/cb'] });
    const { response: second } = await handle({ redirect_uris: ['https://a.test/cb'] });
    expect(((await first.json()) as RegistrationBody).client_id).not.toBe(
      ((await second.json()) as RegistrationBody).client_id
    );
  });
});

describe('POST /register (input validation)', () => {
  it('the empty registry input: no redirect_uris gets its own error message', async () => {
    const { response } = await handle({ client_name: 'ghost' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as RegistrationBody;
    expect(body.error).toBe('invalid_client_metadata');
    expect(body.error_description).toMatch(/redirect_uris is required/);
  });

  it('rejects an empty redirect_uris array', async () => {
    const { response } = await handle({ redirect_uris: [] });
    const body = (await response.json()) as RegistrationBody;
    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('rejects a non-https, non-loopback redirect', async () => {
    const { response } = await handle({ redirect_uris: ['http://example.com/cb'] });
    const body = (await response.json()) as RegistrationBody;
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('rejects more than the redirect cap', async () => {
    const uris = Array.from({ length: 11 }, (_, i) => `https://a.test/cb${i}`);
    const { response } = await handle({ redirect_uris: uris });
    const body = (await response.json()) as RegistrationBody;
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('rejects confidential clients: token_endpoint_auth_method must be none', async () => {
    const { response } = await handle({
      redirect_uris: ['https://a.test/cb'],
      token_endpoint_auth_method: 'client_secret_basic',
    });
    const body = (await response.json()) as RegistrationBody;
    expect(body.error).toBe('invalid_client_metadata');
    expect(body.error_description).toMatch(/public clients/);
  });

  it('rejects unknown grant_types and response_types', async () => {
    const { response: grants } = await handle({
      redirect_uris: ['https://a.test/cb'],
      grant_types: ['password'],
    });
    expect(((await grants.json()) as RegistrationBody).error).toBe('invalid_client_metadata');
    const { response: types } = await handle({
      redirect_uris: ['https://a.test/cb'],
      response_types: ['token'],
    });
    expect(((await types.json()) as RegistrationBody).error).toBe('invalid_client_metadata');
  });

  it('rejects scopes outside mcp', async () => {
    const { response } = await handle({ redirect_uris: ['https://a.test/cb'], scope: 'mcp admin' });
    const body = (await response.json()) as RegistrationBody;
    expect(body.error).toBe('invalid_client_metadata');
  });

  it('rejects oversized and malformed bodies', async () => {
    const junk = await handleRegistration(registrationRequest('{not json'), {
      store: createFakeOAuthStore(),
    });
    expect(((await junk.json()) as RegistrationBody).error).toBe('invalid_client_metadata');

    const huge = await handleRegistration(
      registrationRequest(
        JSON.stringify({ redirect_uris: ['https://a.test/cb'], pad: 'x'.repeat(20_000) })
      ),
      { store: createFakeOAuthStore() }
    );
    expect(huge.status).toBe(400);

    const { response: arrayResponse } = await handle([]);
    expect(((await arrayResponse.json()) as RegistrationBody).error).toBe(
      'invalid_client_metadata'
    );
  });

  it('rejects non-POST', async () => {
    const response = await handleRegistration(
      new Request('https://kilo-mcp.test/register', { method: 'GET' }),
      { store: createFakeOAuthStore() }
    );
    expect(response.status).toBe(405);
  });

  it('refuses with a deterministic error once the client registry is full', async () => {
    const store = createFakeOAuthStore();
    store.registerClient = async () => false;
    const response = await handleRegistration(
      registrationRequest({ redirect_uris: ['https://a.test/cb'] }),
      { store, now: () => NOW }
    );
    expect(response.status).toBe(429);
    const body = (await response.json()) as RegistrationBody;
    expect(body.error).toBe('temporarily_unavailable');
    expect(store.clients.size).toBe(0);
  });
});
