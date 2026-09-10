import { describe, expect, it } from 'vitest';
import { authenticate, ORGANIZATION_ID_HEADER } from './auth';
import { signJwt } from './auth/jwt';

const SECRET = 'unit-test-hmac-secret-32-bytes!!';
const ISSUER = 'https://kilo-mcp.test';
const RESOURCE = `${ISSUER}/mcp`;

function requestWith(headers: Record<string, string>): Request {
  return new Request('https://kilo-mcp.test/mcp', { method: 'POST', headers });
}

async function mcpAccessToken(overrides: Record<string, unknown> = {}): Promise<string> {
  return signJwt(
    {
      iss: ISSUER,
      sub: 'kilo-user-1',
      org: 'org-uuid-1',
      aud: RESOURCE,
      client_id: 'client-1',
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: 'jti-1',
      ...overrides,
    },
    SECRET
  );
}

const mcpToken = { tokenSecret: SECRET, issuer: ISSUER, resource: RESOURCE };

function bearerRequest(token: string, extra: Record<string, string> = {}): Request {
  return requestWith({ Authorization: `Bearer ${token}`, ...extra });
}

describe('authenticate (s2 passthrough)', () => {
  it('returns null when there is no Authorization header', async () => {
    expect(await authenticate(requestWith({ 'Content-Type': 'application/json' }))).toBeNull();
  });

  it('returns null when the Authorization header is not a bearer token', async () => {
    expect(await authenticate(requestWith({ Authorization: 'Basic dXNlcjpwYXNz' }))).toBeNull();
    expect(await authenticate(requestWith({ Authorization: 'Bearer' }))).toBeNull();
    expect(await authenticate(requestWith({ Authorization: 'Bearer   ' }))).toBeNull();
  });

  it('forwards the bearer token and org header to apps/web', async () => {
    const auth = await authenticate(
      requestWith({
        Authorization: 'Bearer tok_123',
        [ORGANIZATION_ID_HEADER]: 'org-uuid-1',
      })
    );
    expect(auth).toEqual({ authorization: 'Bearer tok_123', organizationId: 'org-uuid-1' });
  });

  it('accepts a bearer token without an organization header', async () => {
    const auth = await authenticate(requestWith({ Authorization: 'Bearer tok_123' }));
    expect(auth).toEqual({ authorization: 'Bearer tok_123', organizationId: undefined });
  });

  it('is case-insensitive on the scheme and header name', async () => {
    const auth = await authenticate(
      new Request('https://kilo-mcp.test/mcp', {
        method: 'POST',
        headers: { authorization: 'bearer tok_123' },
      })
    );
    expect(auth?.authorization).toBe('bearer tok_123');
  });

  it('without MCP deps, any bearer keeps the s2 passthrough', async () => {
    const token = await mcpAccessToken();
    const auth = await authenticate(bearerRequest(token));
    expect(auth).toEqual({ authorization: `Bearer ${token}`, organizationId: undefined });
    expect(auth?.mcpIdentity).toBeUndefined();
  });
});

describe('authenticate (s5 verify + s6 enforcement: only MCP tokens)', () => {
  const withKilo = {
    mcpToken,
    resolveKiloToken: async (identity: { kiloUserId: string; clientId: string }) =>
      identity.kiloUserId === 'kilo-user-1' && identity.clientId === 'client-1'
        ? 'kilo-app-token'
        : null,
  };

  it('verifies an MCP token and forwards the bound Kilo credential + org from its claims', async () => {
    const token = await mcpAccessToken();
    const auth = await authenticate(
      bearerRequest(token, { [ORGANIZATION_ID_HEADER]: 'spoofed' }),
      withKilo
    );
    expect(auth).not.toBeNull();
    // apps/web cannot verify this worker's JWT: the forwarded bearer is the
    // Kilo token the grant was minted from, not the MCP token.
    expect(auth?.authorization).toBe('Bearer kilo-app-token');
    expect(auth?.organizationId).toBe('org-uuid-1');
    expect(auth?.mcpIdentity).toMatchObject({
      kiloUserId: 'kilo-user-1',
      organizationId: 'org-uuid-1',
      clientId: 'client-1',
    });
  });

  it('the caller-supplied organization header is ignored; the org claim wins', async () => {
    const token = await mcpAccessToken({ org: null });
    const auth = await authenticate(
      bearerRequest(token, { [ORGANIZATION_ID_HEADER]: 'attacker-org' }),
      withKilo
    );
    expect(auth?.organizationId).toBeUndefined();
    expect(auth?.mcpIdentity?.organizationId).toBeNull();
  });

  it('personal (org-less) tokens verify with no organization', async () => {
    const token = await mcpAccessToken({ org: null });
    const auth = await authenticate(bearerRequest(token), withKilo);
    expect(auth?.organizationId).toBeUndefined();
    expect(auth?.mcpIdentity?.organizationId).toBeNull();
  });

  it('an expired MCP token is rejected, not forwarded', async () => {
    const token = await mcpAccessToken({ exp: Math.floor(Date.now() / 1000) - 10 });
    expect(await authenticate(bearerRequest(token), withKilo)).toBeNull();
  });

  it('a revoked MCP token is rejected', async () => {
    const token = await mcpAccessToken({ jti: 'revoked-jti' });
    const auth = await authenticate(bearerRequest(token), {
      ...withKilo,
      mcpToken: { ...mcpToken, isJtiRevoked: async (jti: string) => jti === 'revoked-jti' },
    });
    expect(auth).toBeNull();
  });
  it('a token for a different audience is rejected', async () => {
    const token = await mcpAccessToken({ aud: 'https://other-mcp.test/mcp' });
    expect(await authenticate(bearerRequest(token), withKilo)).toBeNull();
  });

  it('a token signed with a different secret is rejected — no passthrough', async () => {
    const token = await signJwt(
      {
        iss: ISSUER,
        sub: 'x',
        org: null,
        aud: RESOURCE,
        client_id: 'c',
        exp: Math.floor(Date.now() / 1000) + 60,
        jti: 'j',
      },
      'another-secret-not-ours-at-all!!'
    );
    expect(await authenticate(bearerRequest(token), withKilo)).toBeNull();
  });

  it('a non-JWT bearer (an apps/web app token) is rejected — only MCP tokens pass', async () => {
    expect(await authenticate(bearerRequest('tok_app_123'), withKilo)).toBeNull();
  });

  it('a valid MCP token whose grant lost its Kilo credential is rejected (reconnect)', async () => {
    const token = await mcpAccessToken({ sub: 'user-without-grant' });
    expect(await authenticate(bearerRequest(token), withKilo)).toBeNull();
  });
});
