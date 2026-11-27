import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ACCESS_REFUSAL_HEADER, refuseWithoutAccess } from './access-gate.js';

const TEAM_DOMAIN = 'gate-probe.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const env = { ENVIRONMENT: 'production', E2E_ACCESS_AUD: AUD, E2E_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN };

let signingKey: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  signingKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'gate-probe', alg: 'RS256' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      (input instanceof Request ? input.url : input instanceof URL ? input.href : input) ===
      `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`
        ? Response.json({ keys: [jwk] })
        : new Response('not found', { status: 404 })
    )
  );
});

function assertion(
  overrides: { aud?: string; iss?: string; exp?: number; key?: CryptoKey } = {}
): Promise<string> {
  return new SignJWT({ common_name: 'client-id.access' })
    .setProtectedHeader({ alg: 'RS256', kid: 'gate-probe' })
    .setIssuer(overrides.iss ?? `https://${TEAM_DOMAIN}`)
    .setAudience(overrides.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(overrides.exp ?? Math.floor(Date.now() / 1000) + 300)
    .sign(overrides.key ?? signingKey);
}

const request = (token?: string) =>
  new Request('https://cloud-agent-e2e.example.test/trpc/getSession', {
    headers: token === undefined ? {} : { 'Cf-Access-Jwt-Assertion': token },
  });

describe('refuseWithoutAccess', () => {
  it('admits a request carrying a valid Access assertion', async () => {
    expect(await refuseWithoutAccess(request(await assertion()), env)).toBeNull();
  });

  it('refuses a missing, foreign or expired assertion with the Worker marker', async () => {
    const tokens = [
      undefined,
      'not-a-jwt',
      await assertion({ aud: 'b'.repeat(64) }),
      await assertion({ iss: 'https://other.cloudflareaccess.com' }),
      await assertion({ exp: Math.floor(Date.now() / 1000) - 60 }),
      await assertion({ key: otherKey }),
    ];
    for (const token of tokens) {
      const refusal = await refuseWithoutAccess(request(token), env);
      expect(refusal?.status).toBe(403);
      expect(refusal?.headers.get(ACCESS_REFUSAL_HEADER)).toBe('access');
    }
  });

  it('fails closed without an audience or team domain', async () => {
    const token = await assertion();
    for (const partial of [
      { ...env, E2E_ACCESS_AUD: undefined },
      { ...env, E2E_ACCESS_TEAM_DOMAIN: undefined },
      { ENVIRONMENT: 'production' },
      {},
    ]) {
      expect((await refuseWithoutAccess(request(token), partial))?.status).toBe(403);
    }
  });

  it('skips the gate only in development', async () => {
    expect(await refuseWithoutAccess(request(), { ENVIRONMENT: 'development' })).toBeNull();
  });
});
