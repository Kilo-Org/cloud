import { STS_ISSUERS, STS_NOTIFICATIONS_INTERNAL_CALL } from '@kilocode/sts-contracts';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { resetInternalAuthObservation } from './internal-auth-observation';
import {
  createInternalServiceReceiver,
  type InternalReceiverEnv,
  type InternalRouteContract,
} from './internal-service-receiver';

const ISSUER = STS_ISSUERS.staging;
const ORIGIN = 'https://notifications.test';
const SECRET = 'legacy-shared-secret-value';
const ROUTE: InternalRouteContract = {
  label: 'dispatch',
  scope: STS_NOTIFICATIONS_INTERNAL_CALL.scope,
  workloads: ['web'],
  legacyHeader: 'X-Internal-Secret',
};

let privateKey: CryptoKey;
let kid: string;
let jwks: { keys: Record<string, unknown>[] };

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  privateKey = pair.privateKey;
  const exported = await exportJWK(pair.publicKey);
  kid = await calculateJwkThumbprint(exported);
  jwks = { keys: [{ ...exported, kid, alg: 'EdDSA', use: 'sig' }] };
});

async function token(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: ISSUER,
    exp: now + 300,
    aud: STS_NOTIFICATIONS_INTERNAL_CALL.audience,
    sub: 'service:web',
    client_id: 'web',
    iat: now,
    jti: crypto.randomUUID(),
    scope: ROUTE.scope,
    req: 'web',
    env: 'staging',
    ...overrides,
  })
    .setProtectedHeader({ typ: 'at+jwt', kid, alg: 'EdDSA' })
    .sign(privateKey);
}

function env(mode?: string): InternalReceiverEnv {
  return {
    INTERNAL_CREDENTIAL_ACCEPT: mode,
    STS_ENVIRONMENT: 'staging',
    STS_RESOURCE_ORIGIN: ORIGIN,
  };
}

function request(headers: Record<string, string>): Request {
  return new Request(`${ORIGIN}/internal/v1/dispatch`, { method: 'POST', headers });
}

/** The Worker's legacy check: admits exactly the shared secret. */
function legacyFor(req: Request) {
  return vi.fn(async () =>
    req.headers.get(ROUTE.legacyHeader) === SECRET
      ? null
      : Response.json({ error: 'Unauthorized' }, { status: 401 })
  );
}

const options = { waitUntil: () => {} };
let logs: string[];
let fetchMock: Mock;

beforeEach(() => {
  resetInternalAuthObservation();
  logs = [];
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
  }
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISSUER}/.well-known/jwks.json`) return Response.json(jwks);
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function receiver() {
  return createInternalServiceReceiver({
    receiver: 'notifications',
    audience: STS_NOTIFICATIONS_INTERNAL_CALL.audience,
    routes: [ROUTE],
  });
}

function stsLines(): Record<string, unknown>[] {
  return logs
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(line => line.event === 'kilo_internal_auth' && line.auth === 'sts');
}

describe('legacy-only (and unset)', () => {
  it.each([undefined, '', 'legacy-only'])('runs the legacy check unchanged for %j', async mode => {
    const bearer = await token();
    const req = request({ [ROUTE.legacyHeader]: SECRET, authorization: `Bearer ${bearer}` });
    const legacy = legacyFor(req);
    expect(await receiver().admit(req, env(mode), ROUTE, legacy, options)).toBeNull();
    expect(legacy).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();

    const bad = request({ [ROUTE.legacyHeader]: 'wrong' });
    const refused = await receiver().admit(bad, env(mode), ROUTE, legacyFor(bad), options);
    expect(refused?.status).toBe(401);
  });

  it('builds nothing and reads no STS setting', async () => {
    const req = request({ [ROUTE.legacyHeader]: SECRET });
    const result = await receiver().admit(req, {}, ROUTE, legacyFor(req), options);
    expect(result).toBeNull();
    expect(receiver().protectedResourceMetadata({})).toBeNull();
  });
});

describe('closed set', () => {
  it('refuses an unknown mode with 500', async () => {
    const req = request({ [ROUTE.legacyHeader]: SECRET });
    const legacy = legacyFor(req);
    expect((await receiver().admit(req, env('sts'), ROUTE, legacy, options))?.status).toBe(500);
    expect(legacy).not.toHaveBeenCalled();
  });

  it('refuses everything when disabled', async () => {
    const req = request({ [ROUTE.legacyHeader]: SECRET });
    const legacy = legacyFor(req);
    expect((await receiver().admit(req, env('disabled'), ROUTE, legacy, options))?.status).toBe(
      401
    );
    expect(legacy).not.toHaveBeenCalled();
  });

  it('answers 500 for an STS request without a valid STS environment or origin', async () => {
    const req = request({ authorization: `Bearer ${await token()}` });
    const noEnv = { ...env('legacy-and-sts'), STS_ENVIRONMENT: undefined };
    expect((await receiver().admit(req, noEnv, ROUTE, legacyFor(req), options))?.status).toBe(500);
    const httpOrigin = { ...env('legacy-and-sts'), STS_RESOURCE_ORIGIN: 'http://x.test' };
    expect((await receiver().admit(req, httpOrigin, ROUTE, legacyFor(req), options))?.status).toBe(
      500
    );
  });
});

describe('legacy-and-sts', () => {
  it('accepts the legacy secret alone', async () => {
    const req = request({ [ROUTE.legacyHeader]: SECRET });
    const legacy = legacyFor(req);
    expect(await receiver().admit(req, env('legacy-and-sts'), ROUTE, legacy, options)).toBeNull();
    expect(legacy).toHaveBeenCalledOnce();
  });

  it('accepts an STS token alone and logs one sts admission line', async () => {
    const req = request({ authorization: `Bearer ${await token()}` });
    const legacy = legacyFor(req);
    expect(await receiver().admit(req, env('legacy-and-sts'), ROUTE, legacy, options)).toBeNull();
    expect(legacy).not.toHaveBeenCalled();
    expect(stsLines()).toEqual([
      expect.objectContaining({
        event: 'kilo_internal_auth',
        receiver: 'notifications',
        route: 'dispatch',
        auth: 'sts',
        caller: 'web',
        count: 1,
      }),
    ]);
  });

  it('refuses both credentials together without running either check', async () => {
    const req = request({
      authorization: `Bearer ${await token()}`,
      [ROUTE.legacyHeader]: SECRET,
    });
    const legacy = legacyFor(req);
    const result = await receiver().admit(req, env('legacy-and-sts'), ROUTE, legacy, options);
    expect(result?.status).toBe(400);
    expect(legacy).not.toHaveBeenCalled();
    expect(stsLines()).toEqual([]);
  });

  it('refuses a malformed token and never retries it as legacy', async () => {
    const req = request({ authorization: 'Bearer not-a-jwt' });
    const legacy = legacyFor(req);
    const result = await receiver().admit(req, env('legacy-and-sts'), ROUTE, legacy, options);
    expect(result?.status).toBe(401);
    expect(legacy).not.toHaveBeenCalled();
  });
});

describe('sts-only', () => {
  it('refuses the legacy secret', async () => {
    const req = request({ [ROUTE.legacyHeader]: SECRET });
    const legacy = legacyFor(req);
    const result = await receiver().admit(req, env('sts-only'), ROUTE, legacy, options);
    expect(result?.status).toBe(401);
    expect(legacy).not.toHaveBeenCalled();
  });

  it('accepts a valid STS token', async () => {
    const req = request({ authorization: `Bearer ${await token()}` });
    expect(await receiver().admit(req, env('sts-only'), ROUTE, legacyFor(req), options)).toBeNull();
  });

  it.each([
    ['wrong audience', { aud: 'session-sync' }],
    ['wrong scope', { scope: 'notifications:other.call' }],
    [
      'expired',
      { exp: Math.floor(Date.now() / 1000) - 600, iat: Math.floor(Date.now() / 1000) - 900 },
    ],
    ['wrong issuer', { iss: STS_ISSUERS.production }],
    ['wrong environment', { env: 'production' }],
  ])('refuses a token with the %s', async (_name, overrides) => {
    const req = request({ authorization: `Bearer ${await token(overrides)}` });
    const legacy = legacyFor(req);
    const result = await receiver().admit(req, env('sts-only'), ROUTE, legacy, options);
    expect(result?.status).toBeGreaterThanOrEqual(401);
    expect(result?.status).toBeLessThan(500);
    expect(legacy).not.toHaveBeenCalled();
    expect(stsLines()).toEqual([]);
  });

  it('refuses a workload the route does not list', async () => {
    const other = await token({
      sub: 'service:kilo-chat',
      client_id: 'kilo-chat',
      req: 'kilo-chat',
    });
    const req = request({ authorization: `Bearer ${other}` });
    const result = await receiver().admit(req, env('sts-only'), ROUTE, legacyFor(req), options);
    expect(result?.status).toBe(403);
    expect(stsLines()).toEqual([]);
  });
});

describe('logs', () => {
  it('never contain the token or the secret', async () => {
    const bearer = await token();
    const expired = await token({ exp: 1, iat: 0 });
    const r = receiver();
    for (const headers of [
      { authorization: `Bearer ${bearer}` },
      { authorization: `Bearer ${expired}` },
      { authorization: `Bearer ${bearer}`, [ROUTE.legacyHeader]: SECRET },
      { [ROUTE.legacyHeader]: SECRET },
    ]) {
      for (const mode of ['legacy-and-sts', 'sts-only']) {
        const req = request(headers);
        await r.admit(req, env(mode), ROUTE, legacyFor(req), options);
      }
    }
    const all = logs.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    expect(all).not.toContain(bearer);
    expect(all).not.toContain(expired);
    expect(all).not.toContain(SECRET);
  });
});

describe('protected-resource metadata', () => {
  it('lists the origin, issuer and scopes only in an STS mode', async () => {
    expect(receiver().protectedResourceMetadata(env('legacy-only'))).toBeNull();
    const response = receiver().protectedResourceMetadata(env('legacy-and-sts'));
    expect(await response?.json()).toEqual({
      resource: ORIGIN,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
      scopes_supported: [ROUTE.scope],
    });
  });
});
