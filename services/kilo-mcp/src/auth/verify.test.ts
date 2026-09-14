import { describe, expect, it } from 'vitest';
import { signJwt } from './jwt';
import { verifyMcpAccessToken } from './verify';

const SECRET = 'verify-test-secret-32-bytes!!!';
const ISSUER = 'https://kilo-mcp.test';
const RESOURCE = `${ISSUER}/mcp`;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function token(overrides: Record<string, unknown> = {}, secret = SECRET): Promise<string> {
  return signJwt(
    {
      iss: ISSUER,
      sub: 'kilo-user-1',
      org: 'org-1',
      aud: RESOURCE,
      client_id: 'client-1',
      exp: nowSeconds() + 3600,
      jti: 'jti-1',
      ...overrides,
    },
    secret
  );
}

const deps = { tokenSecret: SECRET, issuer: ISSUER, resource: RESOURCE };

describe('verifyMcpAccessToken', () => {
  it('returns the bound identity for a valid token', async () => {
    const result = await verifyMcpAccessToken(await token(), deps);
    expect(result).toEqual({
      ok: true,
      token: {
        kiloUserId: 'kilo-user-1',
        organizationId: 'org-1',
        clientId: 'client-1',
        resource: RESOURCE,
        expiresAt: expect.any(Number),
      },
    });
  });

  it('accepts a null org (personal identity)', async () => {
    const result = await verifyMcpAccessToken(await token({ org: null }), deps);
    expect(result.ok && result.token.organizationId).toBeNull();
  });

  it('rejects a wrong signature without claiming ownership (passthrough stays possible)', async () => {
    const result = await verifyMcpAccessToken(
      await token({}, 'other-secret-32-bytes-absolute!!'),
      deps
    );
    expect(result).toEqual({ ok: false, mine: false, reason: 'signature' });
  });

  it('rejects non-JWT bearers as foreign', async () => {
    const result = await verifyMcpAccessToken('tok_app_123', deps);
    expect(result).toMatchObject({ ok: false, mine: false, reason: 'malformed' });
  });

  it('rejects an expired token (mine: true)', async () => {
    const result = await verifyMcpAccessToken(await token({ exp: nowSeconds() - 1 }), deps);
    expect(result).toEqual({ ok: false, mine: true, reason: 'expired' });
  });

  it('rejects a revoked jti (mine: true)', async () => {
    const result = await verifyMcpAccessToken(await token({ jti: 'bad-jti' }), {
      ...deps,
      isJtiRevoked: async jti => jti === 'bad-jti',
    });
    expect(result).toEqual({ ok: false, mine: true, reason: 'revoked' });
  });

  it('rejects a token not revoked when the registry says no', async () => {
    const result = await verifyMcpAccessToken(await token({ jti: 'fine-jti' }), {
      ...deps,
      isJtiRevoked: async () => false,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects the wrong issuer (mine: true)', async () => {
    const result = await verifyMcpAccessToken(await token({ iss: 'https://evil.test' }), deps);
    expect(result).toEqual({ ok: false, mine: true, reason: 'issuer' });
  });

  it('rejects the wrong audience — a token for another MCP resource (requirement 18)', async () => {
    const result = await verifyMcpAccessToken(
      await token({ aud: 'https://kilo-mcp.test/other' }),
      deps
    );
    expect(result).toEqual({ ok: false, mine: true, reason: 'audience' });
  });

  it('rejects missing claim types', async () => {
    const noJti = await verifyMcpAccessToken(await token({ jti: undefined }), deps);
    expect(noJti).toMatchObject({ ok: false, mine: true, reason: 'claims' });
    const badExp = await verifyMcpAccessToken(await token({ exp: 'soon' }), deps);
    expect(badExp).toMatchObject({ ok: false, mine: true, reason: 'expired' });
  });

  it('rejects alg=none and foreign header shapes', async () => {
    const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    const payload = btoa(JSON.stringify({ iss: ISSUER, aud: RESOURCE, exp: nowSeconds() + 60 }))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    const result = await verifyMcpAccessToken(`${header}.${payload}.`, deps);
    expect(result).toMatchObject({ ok: false, mine: false, reason: 'malformed' });
  });
});
