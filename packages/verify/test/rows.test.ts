import { beforeEach, describe, expect, it } from 'vitest';
import { createVerifier, failureResponse, type Route, type VerifyResult } from '../src/index';
import {
  AUDIENCE,
  OTHER_SCOPE,
  RESOURCE_METADATA,
  SCOPE,
  SESSION_SCOPE,
  STS_ISSUER,
  UTS_ISSUER,
  bearer,
  createIssuer,
  harness,
  nowSeconds,
  sign,
  signWithHeader,
  stsClaims,
  utsClaims,
  type Harness,
} from './helpers';

// One table per design section 7 row; each case is named after the rule it exercises.

type Expectation =
  | { ok: true }
  | { status: 401 | 403 | 429 | 503; error: string | null; reason: string };

type Case = {
  name: string;
  token: (h: Harness) => Promise<string>;
  route?: Partial<Route>;
  setup?: (h: Harness) => void;
  expected: Expectation;
};

const OK: Expectation = { ok: true };
const invalid = (reason: string): Expectation => ({ status: 401, error: 'invalid_token', reason });
const insufficient = (reason: string): Expectation => ({
  status: 403,
  error: 'insufficient_scope',
  reason,
});

let h: Harness;
beforeEach(async () => {
  h = await harness();
});

async function run(c: Case): Promise<VerifyResult> {
  c.setup?.(h);
  const route: Route = { issuer: 'sts', scope: SCOPE, ...c.route };
  return await h.verifier.verify(bearer(await c.token(h)), route, h.ctx);
}

function check(result: VerifyResult, expected: Expectation): void {
  if ('ok' in expected) {
    expect(result).toMatchObject({ ok: true });
    return;
  }
  expect(result).toMatchObject({
    ok: false,
    status: expected.status,
    error: expected.error,
    reason: expected.reason,
  });
}

function table(cases: Case[]): void {
  it.each(cases.map(c => [c.name, c] as const))('%s', async (_name, c) => {
    check(await run(c), c.expected);
  });
}

const uts: Partial<Route> = { issuer: 'uts' };

describe('row 1: algorithm is EdDSA only, and the header names a kid', () => {
  table([
    { name: 'EdDSA with a kid is accepted', token: h => sign(h.sts, stsClaims()), expected: OK },
    {
      name: 'alg none is refused',
      token: h =>
        signWithHeader(h.sts, stsClaims(), { alg: 'none', typ: 'at+jwt', kid: h.sts.kid }),
      expected: invalid('algorithm'),
    },
    {
      name: 'HS256 is refused',
      token: h =>
        signWithHeader(h.sts, stsClaims(), { alg: 'HS256', typ: 'at+jwt', kid: h.sts.kid }),
      expected: invalid('algorithm'),
    },
    {
      name: 'RS256 is refused',
      token: h =>
        signWithHeader(h.sts, stsClaims(), { alg: 'RS256', typ: 'at+jwt', kid: h.sts.kid }),
      expected: invalid('algorithm'),
    },
    {
      name: 'ES256 is refused',
      token: h =>
        signWithHeader(h.sts, stsClaims(), { alg: 'ES256', typ: 'at+jwt', kid: h.sts.kid }),
      expected: invalid('algorithm'),
    },
    {
      name: 'a missing kid is refused',
      token: h => signWithHeader(h.sts, stsClaims(), { alg: 'EdDSA', typ: 'at+jwt' }),
      expected: invalid('kid_missing'),
    },
    {
      name: 'an empty kid is refused',
      token: h => signWithHeader(h.sts, stsClaims(), { alg: 'EdDSA', typ: 'at+jwt', kid: '' }),
      expected: invalid('kid_missing'),
    },
    {
      name: 'a token that is not three segments is refused',
      token: async () => 'abc.def',
      expected: invalid('malformed_token'),
    },
  ]);
});

describe('row 2: the signature verifies against the JWKS key for that kid', () => {
  table([
    {
      name: 'a signature by the kid key is accepted',
      token: h => sign(h.sts, stsClaims()),
      expected: OK,
    },
    {
      name: 'a tampered payload is refused',
      token: async h => {
        const [header, , signature] = (await sign(h.sts, stsClaims())).split('.');
        const forged = btoa(JSON.stringify(stsClaims({ scope: OTHER_SCOPE })))
          .replace(/=+$/, '')
          .replace(/\+/g, '-')
          .replace(/\//g, '_');
        return `${header}.${forged}.${signature}`;
      },
      expected: invalid('signature'),
    },
    {
      name: 'a signature by another Ed25519 key under the same kid is refused',
      token: async h => sign({ ...(await createIssuer(STS_ISSUER)), kid: h.sts.kid }, stsClaims()),
      expected: invalid('signature'),
    },
    {
      name: 'a signature by a second key of the set under the first key kid is refused',
      setup: () => {},
      token: async h => {
        const second = await createIssuer(STS_ISSUER);
        h.stsJwks.keys = [h.sts.jwk, second.jwk];
        return await sign({ ...second, kid: h.sts.kid }, stsClaims());
      },
      expected: invalid('signature'),
    },
  ]);
});

describe('row 3: issuer is an exact match and the key comes from that issuer set', () => {
  table([
    {
      name: 'an issuer with a trailing slash is refused',
      token: h => sign(h.sts, stsClaims({ iss: `${STS_ISSUER}/` })),
      expected: invalid('issuer'),
    },
    {
      name: 'an unknown issuer is refused',
      token: h => sign(h.sts, stsClaims({ iss: 'https://evil.test' })),
      expected: invalid('issuer'),
    },
    {
      name: 'a valid UTS-signed token on an STS-only route is refused',
      token: h => sign(h.uts, utsClaims()),
      expected: invalid('issuer_per_route'),
    },
    {
      name: 'iss=STS with a kid only in the UTS set is refused',
      token: h => sign(h.uts, stsClaims()),
      expected: invalid('unknown_kid'),
    },
    {
      name: 'a UTS token signed under a revocation-feed key of the UTS set is refused',
      token: async h => {
        const feedKey = await createIssuer(UTS_ISSUER, 'uts-feed-0-');
        h.utsJwks.keys = [h.uts.jwk, feedKey.jwk];
        return await sign(feedKey, utsClaims());
      },
      route: uts,
      expected: invalid('not_token_key'),
    },
  ]);

  it('never fetches the UTS set for an STS route', async () => {
    await run({ name: '', token: h => sign(h.uts, stsClaims()), expected: invalid('unknown_kid') });
    expect(h.utsJwks.calls).toBe(0);
  });

  it('refuses a feed-key kid before fetching the key set', async () => {
    const feedKey = await createIssuer(UTS_ISSUER, 'uts-feed-0-');
    const result = await h.verifier.verify(
      bearer(await sign(feedKey, utsClaims())),
      { issuer: 'uts', scope: SCOPE },
      h.ctx
    );
    check(result, invalid('not_token_key'));
    expect(h.utsJwks.calls).toBe(0);
  });
});

describe('row 4: exactly one audience, equal to this service', () => {
  table([
    {
      name: 'this audience as one string is accepted',
      token: h => sign(h.sts, stsClaims()),
      expected: OK,
    },
    {
      name: 'an array naming only this service is refused',
      token: h => sign(h.sts, stsClaims({ aud: [AUDIENCE] })),
      expected: invalid('audience'),
    },
    {
      name: 'an array naming this service and another is refused',
      token: h => sign(h.sts, stsClaims({ aud: [AUDIENCE, 'gateway'] })),
      expected: invalid('audience'),
    },
    {
      name: 'a missing aud is refused',
      token: h => sign(h.sts, stsClaims({ aud: undefined })),
      expected: invalid('audience'),
    },
    {
      name: 'another service as audience is refused with insufficient_scope',
      token: h => sign(h.sts, stsClaims({ aud: 'gateway', scope: 'gateway:models.read' })),
      expected: insufficient('audience'),
    },
  ]);
});

describe('row 5: typ is at+jwt', () => {
  table([
    {
      name: 'typ JWT is refused',
      token: h => signWithHeader(h.sts, stsClaims(), { alg: 'EdDSA', typ: 'JWT', kid: h.sts.kid }),
      expected: invalid('type'),
    },
    {
      name: 'a missing typ is refused',
      token: h => signWithHeader(h.sts, stsClaims(), { alg: 'EdDSA', kid: h.sts.kid }),
      expected: invalid('type'),
    },
    {
      name: 'typ application/at+jwt is refused',
      token: h =>
        signWithHeader(h.sts, stsClaims(), {
          alg: 'EdDSA',
          typ: 'application/at+jwt',
          kid: h.sts.kid,
        }),
      expected: invalid('type'),
    },
    {
      name: 'typ at+jwt signed raw is accepted',
      token: h =>
        signWithHeader(h.sts, stsClaims(), { alg: 'EdDSA', typ: 'at+jwt', kid: h.sts.kid }),
      expected: OK,
    },
  ]);
});

describe('row 6: exp in the future and iat not in the future with 60 s skew; nbf in the past', () => {
  const at = (iat: number, exp: number, extra: Record<string, unknown> = {}) =>
    stsClaims({ iat: nowSeconds() + iat, exp: nowSeconds() + exp, ...extra });
  table([
    {
      name: 'exp 61 s ago is refused',
      token: h => sign(h.sts, at(-300, -61)),
      expected: invalid('expired'),
    },
    {
      name: 'exp 30 s ago is inside the skew',
      token: h => sign(h.sts, at(-300, -30)),
      expected: OK,
    },
    {
      name: 'iat 120 s ahead is refused',
      token: h => sign(h.sts, at(120, 400)),
      expected: invalid('issued_in_future'),
    },
    {
      name: 'iat 30 s ahead is inside the skew',
      token: h => sign(h.sts, at(30, 300)),
      expected: OK,
    },
    {
      name: 'nbf 120 s ahead is refused',
      token: h => sign(h.sts, at(0, 300, { nbf: nowSeconds() + 120 })),
      expected: invalid('not_yet_valid'),
    },
    {
      name: 'nbf 30 s ahead is inside the skew',
      token: h => sign(h.sts, at(0, 300, { nbf: nowSeconds() + 30 })),
      expected: OK,
    },
    {
      name: 'nbf in the past is accepted',
      token: h => sign(h.sts, at(0, 300, { nbf: nowSeconds() - 5 })),
      expected: OK,
    },
    {
      name: 'a string exp is refused',
      token: h => sign(h.sts, stsClaims({ exp: String(nowSeconds() + 300) })),
      expected: invalid('time'),
    },
    {
      name: 'an STS token living longer than 300 s is refused',
      token: h => sign(h.sts, at(0, 301)),
      expected: invalid('time'),
    },
  ]);
});

describe('row 7: sub, jti and client_id present', () => {
  table([
    {
      name: 'all three present is accepted',
      token: h => sign(h.uts, utsClaims()),
      route: uts,
      expected: OK,
    },
    {
      name: 'a missing sub is refused',
      token: h => sign(h.uts, utsClaims({ sub: undefined })),
      route: uts,
      expected: invalid('identity'),
    },
    {
      name: 'an empty sub is refused',
      token: h => sign(h.uts, utsClaims({ sub: '' })),
      route: uts,
      expected: invalid('identity'),
    },
    {
      name: 'a missing jti is refused',
      token: h => sign(h.uts, utsClaims({ jti: undefined })),
      route: uts,
      expected: invalid('identity'),
    },
    {
      name: 'a missing client_id is refused',
      token: h => sign(h.uts, utsClaims({ client_id: undefined })),
      route: uts,
      expected: invalid('identity'),
    },
    {
      name: 'an STS token whose sub is not service:<client_id> is refused',
      token: h => sign(h.sts, stsClaims({ sub: 'user-1' })),
      expected: invalid('identity'),
    },
    {
      name: 'unknown claims are tolerated',
      token: h => sign(h.uts, utsClaims({ cnf: { jkt: 'x' }, custom: 1 })),
      route: uts,
      expected: OK,
    },
  ]);
});

describe('row 8: a registered scope of this audience, equal to the route scope', () => {
  table([
    {
      name: 'an STS scope missing from the STS registry is refused',
      token: h => sign(h.sts, stsClaims({ scope: 'session-ingest:admin' })),
      expected: insufficient('scope_unknown'),
    },
    {
      name: 'an STS token with another registered scope than the route is refused',
      token: h => sign(h.sts, stsClaims({ scope: OTHER_SCOPE })),
      expected: insufficient('scope_mismatch'),
    },
    {
      name: 'a UTS scope missing from the UTS registry is refused',
      token: h => sign(h.uts, utsClaims({ scope: 'session-ingest:admin' })),
      route: uts,
      expected: insufficient('scope_unknown'),
    },
    {
      name: 'a UTS token with another registered scope than the route is refused',
      token: h => sign(h.uts, utsClaims({ scope: OTHER_SCOPE })),
      route: uts,
      expected: insufficient('scope_mismatch'),
    },
    {
      name: 'a scope of another audience in a token for this audience is refused',
      token: h => sign(h.sts, stsClaims({ scope: 'gateway:models.read' })),
      expected: insufficient('scope_unknown'),
    },
    {
      name: 'two space-separated scopes are refused',
      token: h => sign(h.sts, stsClaims({ scope: `${SCOPE} ${OTHER_SCOPE}` })),
      expected: invalid('claims'),
    },
  ]);

  it('names the required scope in the body and the challenge', async () => {
    const result = await run({
      name: '',
      token: h => sign(h.sts, stsClaims({ scope: OTHER_SCOPE })),
      expected: insufficient('scope_mismatch'),
    });
    expect(result).toMatchObject({
      body: { error: 'insufficient_scope', scope: SCOPE },
      headers: {
        'www-authenticate': `Bearer error="insufficient_scope", scope="${SCOPE}", resource_metadata="${RESOURCE_METADATA}"`,
      },
    });
  });

  it('denies every STS scope with the shipped, empty registry', async () => {
    const verifier = createVerifier({
      audience: AUDIENCE,
      resourceMetadataUrl: RESOURCE_METADATA,
      sts: { issuer: STS_ISSUER, jwks: h.stsJwks.source },
    });
    const result = await verifier.verify(
      bearer(await sign(h.sts, stsClaims())),
      { issuer: 'sts', scope: SCOPE },
      h.ctx
    );
    expect(result).toMatchObject({ ok: false, status: 403, reason: 'scope_unknown' });
  });

  it('throws for a route scope of another audience', async () => {
    await expect(
      h.verifier.verify(bearer('x.y.z'), { issuer: 'sts', scope: 'gateway:models.read' }, h.ctx)
    ).rejects.toThrow(/not a scope of audience/);
  });

  it('throws for an STS route that requires a session', async () => {
    await expect(
      h.verifier.verify(
        bearer('x.y.z'),
        { issuer: 'sts', scope: SCOPE, requiresSession: true },
        h.ctx
      )
    ).rejects.toThrow(/cannot require a session/);
  });
});

describe('row 9: a present org claim equals the request org on an org-scoped route', () => {
  table([
    {
      name: 'a different org is refused',
      token: h => sign(h.uts, utsClaims({ org: 'org-2' })),
      route: { ...uts, org: 'org-1' },
      expected: { status: 403, error: 'org_mismatch', reason: 'org_mismatch' },
    },
    {
      name: 'the same org is accepted',
      token: h => sign(h.uts, utsClaims({ org: 'org-1' })),
      route: { ...uts, org: 'org-1' },
      expected: OK,
    },
    {
      name: 'no org claim is accepted',
      token: h => sign(h.uts, utsClaims()),
      route: { ...uts, org: 'org-1' },
      expected: OK,
    },
    {
      name: 'an org claim on a route without org is accepted',
      token: h => sign(h.uts, utsClaims({ org: 'org-2' })),
      route: uts,
      expected: OK,
    },
  ]);
});

describe('row 10: revocation for UTS tokens; STS tokens skip the feed', () => {
  table([
    {
      name: 'iat equal to revoked_before is refused',
      setup: h => {
        h.feed.list.revokedBefore = new Map([['user-1', nowSeconds()]]);
      },
      token: h => sign(h.uts, utsClaims()),
      route: uts,
      expected: invalid('revoked_subject'),
    },
    {
      name: 'iat later than revoked_before is accepted',
      setup: h => {
        h.feed.list.revokedBefore = new Map([['user-1', nowSeconds() - 1]]);
      },
      token: h => sign(h.uts, utsClaims()),
      route: uts,
      expected: OK,
    },
    {
      name: 'a revoked sid is refused',
      setup: h => {
        h.feed.list.revokedSids = new Set(['grant-1']);
      },
      token: h => sign(h.uts, utsClaims()),
      route: uts,
      expected: invalid('revoked_session'),
    },
    {
      name: 'a revoked kid is refused even with a cached key',
      setup: h => {
        h.feed.list.revokedKids = new Set([h.uts.kid]);
      },
      token: h => sign(h.uts, utsClaims()),
      route: uts,
      expected: invalid('revoked_kid'),
    },
    {
      name: 'an STS token is accepted while the feed is down',
      setup: h => {
        h.feed.mode = 'fail';
      },
      token: h => sign(h.sts, stsClaims()),
      expected: OK,
    },
    {
      name: 'a UTS token is refused with 503 while the feed has never answered',
      setup: h => {
        h.feed.mode = 'fail';
      },
      token: h => sign(h.uts, utsClaims()),
      route: uts,
      expected: { status: 503, error: 'temporarily_unavailable', reason: 'feed_unavailable' },
    },
  ]);

  it('makes no feed call for an STS token', async () => {
    check(await run({ name: '', token: h => sign(h.sts, stsClaims()), expected: OK }), OK);
    expect(h.feed.calls).toBe(0);
  });
});

describe('row 11: a session-bound route or scope needs an unrevoked sid', () => {
  table([
    {
      name: 'a route that requires a session refuses a token without sid',
      token: h => sign(h.uts, utsClaims({ sid: undefined })),
      route: { ...uts, requiresSession: true },
      expected: invalid('session_required'),
    },
    {
      name: 'a scope that requires a session refuses a token without sid',
      token: h => sign(h.uts, utsClaims({ sid: undefined, scope: SESSION_SCOPE })),
      route: { ...uts, scope: SESSION_SCOPE },
      expected: invalid('session_required'),
    },
    {
      name: 'a scope that requires a session refuses a revoked sid',
      setup: h => {
        h.feed.list.revokedSids = new Set(['grant-1']);
      },
      token: h => sign(h.uts, utsClaims({ scope: SESSION_SCOPE })),
      route: { ...uts, scope: SESSION_SCOPE },
      expected: invalid('revoked_session'),
    },
    {
      name: 'a scope that requires a session accepts a live sid',
      token: h => sign(h.uts, utsClaims({ scope: SESSION_SCOPE })),
      route: { ...uts, scope: SESSION_SCOPE },
      expected: OK,
    },
    {
      name: 'a route without a session need accepts a token without sid',
      token: h => sign(h.uts, utsClaims({ sid: undefined })),
      route: uts,
      expected: OK,
    },
  ]);
});

describe('row 12: PAT offline check first (full PAT rules in pat.test.ts)', () => {
  table([
    {
      name: 'a PAT on a verifier without PAT lookup is refused',
      token: async () => 'kilo_pat_notvalid',
      route: uts,
      expected: invalid('pat_not_accepted'),
    },
  ]);
});

describe('row 13: account not blocked (UTS); STS service subjects skip it', () => {
  table([
    {
      name: 'a blocked account is refused',
      setup: h => {
        h.feed.list.blockedAccounts = new Set(['user-1']);
      },
      token: h => sign(h.uts, utsClaims()),
      route: uts,
      expected: invalid('blocked_account'),
    },
    {
      name: 'an STS service subject is never looked up as an account',
      setup: h => {
        h.feed.list.blockedAccounts = new Set(['service:cloud-agent-next']);
      },
      token: h => sign(h.sts, stsClaims()),
      expected: OK,
    },
  ]);
});

describe('row 14: each route accepts exactly one issuer', () => {
  table([
    {
      name: 'a UTS token on an STS route is refused',
      token: h => sign(h.uts, utsClaims()),
      expected: invalid('issuer_per_route'),
    },
    {
      name: 'an STS token on a UTS route is refused',
      token: h => sign(h.sts, stsClaims()),
      route: uts,
      expected: invalid('issuer_per_route'),
    },
    {
      name: 'a PAT on an STS route is refused',
      token: async () => 'kilo_pat_anything',
      expected: invalid('issuer_per_route'),
    },
    {
      name: 'a UTS token on a UTS route is accepted',
      token: h => sign(h.uts, utsClaims()),
      route: uts,
      expected: OK,
    },
  ]);
});

describe('error responses', () => {
  it('answers no credential with the bare RFC 9728 challenge', async () => {
    for (const input of [null, '', 'Basic dXNlcjpwYXNz', new Request('https://x.test/')]) {
      const result = await h.verifier.verify(input, { issuer: 'sts', scope: SCOPE }, h.ctx);
      expect(result).toEqual({
        ok: false,
        status: 401,
        error: null,
        reason: 'missing_credential',
        headers: {
          'cache-control': 'no-store',
          'www-authenticate': `Bearer resource_metadata="${RESOURCE_METADATA}"`,
        },
        body: null,
      });
    }
  });

  it('reads the Authorization header of a request', async () => {
    const token = await sign(h.sts, stsClaims());
    const request = new Request('https://x.test/', { headers: { authorization: bearer(token) } });
    expect(await h.verifier.verify(request, { issuer: 'sts', scope: SCOPE }, h.ctx)).toMatchObject({
      ok: true,
      credential: 'access_token',
      issuerKind: 'sts',
      caller: { kind: 'service', workload: 'cloud-agent-next' },
    });
  });

  it('refuses an empty bearer as invalid_token', async () => {
    const result = await h.verifier.verify('Bearer ', { issuer: 'sts', scope: SCOPE }, h.ctx);
    expect(result).toMatchObject({ status: 401, error: 'invalid_token' });
  });

  it('turns each failure into its HTTP response without the token', async () => {
    const token = await sign(
      h.sts,
      stsClaims({ exp: nowSeconds() - 100, iat: nowSeconds() - 300 })
    );
    const result = await h.verifier.verify(bearer(token), { issuer: 'sts', scope: SCOPE }, h.ctx);
    if (result.ok) throw new Error('expected a failure');
    const response = failureResponse(result);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer error="invalid_token", resource_metadata="${RESOURCE_METADATA}"`
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'invalid_token' });
    expect(text).not.toContain(token.split('.')[2]);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('answers a dependency failure with 503 and Retry-After', async () => {
    h.stsJwks.mode = 'fail';
    const result = await h.verifier.verify(
      bearer(await sign(h.sts, stsClaims())),
      { issuer: 'sts', scope: SCOPE },
      h.ctx
    );
    if (result.ok) throw new Error('expected a failure');
    expect(result).toMatchObject({
      status: 503,
      error: 'temporarily_unavailable',
      reason: 'jwks_unavailable',
    });
    const response = failureResponse(result);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
  });

  it('returns the user caller of a UTS token', async () => {
    const result = await h.verifier.verify(
      bearer(await sign(h.uts, utsClaims({ org: 'org-1', act: { sub: 'service:agent' } }))),
      { issuer: 'uts', scope: SCOPE, org: 'org-1' },
      h.ctx
    );
    expect(result).toMatchObject({
      ok: true,
      issuerKind: 'uts',
      caller: {
        kind: 'user',
        subject: 'user-1',
        clientId: 'kilo-cli',
        org: 'org-1',
        sessionId: 'grant-1',
        actor: { sub: 'service:agent' },
      },
    });
  });

  it('refuses a resource metadata URL that could break the challenge', () => {
    expect(() =>
      createVerifier({ audience: AUDIENCE, resourceMetadataUrl: 'https://x.test/"a' })
    ).toThrow();
  });
});
