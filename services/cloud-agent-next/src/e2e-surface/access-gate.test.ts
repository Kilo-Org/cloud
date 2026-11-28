import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ACCESS_REFUSAL_HEADER, refuseWithoutAccess, withoutAccessHeaders } from './access-gate.js';

const TEAM_DOMAIN = 'gate-probe.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const CLIENT_ID = 'client-id.access';
const env = {
  ENVIRONMENT: 'production',
  E2E_ACCESS_AUD: AUD,
  E2E_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  E2E_ACCESS_CLIENT_ID: CLIENT_ID,
};

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
  overrides: { aud?: string; iss?: string; exp?: number; key?: CryptoKey; commonName?: string } = {}
): Promise<string> {
  return new SignJWT({ common_name: overrides.commonName ?? CLIENT_ID })
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
      await assertion({ commonName: 'other-client.access' }),
      await new SignJWT({ email: 'person@example.test' })
        .setProtectedHeader({ alg: 'RS256', kid: 'gate-probe' })
        .setIssuer(`https://${TEAM_DOMAIN}`)
        .setAudience(AUD)
        .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
        .sign(signingKey),
    ];
    for (const token of tokens) {
      const refusal = await refuseWithoutAccess(request(token), env);
      expect(refusal?.status).toBe(403);
      expect(refusal?.headers.get(ACCESS_REFUSAL_HEADER)).toBe('access');
    }
  });

  it('fails closed without an audience, team domain or client id', async () => {
    const token = await assertion();
    for (const partial of [
      { ...env, E2E_ACCESS_AUD: undefined },
      { ...env, E2E_ACCESS_TEAM_DOMAIN: undefined },
      { ...env, E2E_ACCESS_CLIENT_ID: undefined },
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

describe('audience binding (the fake LLM)', () => {
  const fakeEnv = {
    ENVIRONMENT: 'production',
    E2E_ACCESS_AUD: AUD,
    E2E_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  };

  it('admits a valid assertion for the audience without a held client id', async () => {
    const token = await assertion({ commonName: 'any-token.access' });
    expect(await refuseWithoutAccess(request(token), fakeEnv, 'audience')).toBeNull();
  });

  it('still refuses a missing, foreign-audience or wrongly signed assertion', async () => {
    for (const token of [
      undefined,
      await assertion({ aud: 'b'.repeat(64) }),
      await assertion({ key: otherKey }),
    ]) {
      const refusal = await refuseWithoutAccess(request(token), fakeEnv, 'audience');
      expect(refusal?.status).toBe(403);
      expect(refusal?.headers.get(ACCESS_REFUSAL_HEADER)).toBe('access');
    }
    const token = await assertion();
    expect(
      (
        await refuseWithoutAccess(
          request(token),
          { ...fakeEnv, E2E_ACCESS_AUD: undefined },
          'audience'
        )
      )?.status
    ).toBe(403);
  });
});

describe('withoutAccessHeaders', () => {
  it('drops the service token and the assertion and keeps everything else', async () => {
    const admitted = withoutAccessHeaders(
      new Request('https://cloud-agent-e2e.example.test/trpc/x', {
        method: 'POST',
        body: '{}',
        headers: {
          'CF-Access-Client-Id': 'id',
          'CF-Access-Client-Secret': 'secret',
          'Cf-Access-Jwt-Assertion': 'jwt',
          Authorization: 'Bearer kilo',
        },
      })
    );
    for (const name of [
      'CF-Access-Client-Id',
      'CF-Access-Client-Secret',
      'Cf-Access-Jwt-Assertion',
    ]) {
      expect(admitted.headers.has(name), name).toBe(false);
    }
    expect(admitted.headers.get('Authorization')).toBe('Bearer kilo');
    expect(admitted.method).toBe('POST');
    expect(await admitted.text()).toBe('{}');
  });

  it('returns a request without them unchanged', () => {
    const plain = new Request('https://cloud-agent-e2e.example.test/');
    expect(withoutAccessHeaders(plain)).toBe(plain);
  });
});
