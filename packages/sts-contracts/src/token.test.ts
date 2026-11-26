import { describe, expect, it } from 'vitest';
import {
  STS_SCOPE_REGISTRY,
  isRegisteredStsScope,
  stsScopeRegistryProblems,
  type StsScopeRegistry,
} from './scopes';
import {
  AccessTokenClaimsSchema,
  AccessTokenHeaderSchema,
  Ed25519PublicJwkSchema,
  MAX_AUDIENCES_PER_MINT,
  MintRequestSchema,
  MintResultSchema,
  STS_ISSUERS,
  ScopeSchema,
  ServiceTokenClaimsSchema,
  mintResultHttpStatus,
  scopeAudience,
} from './token';

const NOW = 1_800_000_000;

function serviceClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: STS_ISSUERS.production,
    exp: NOW + 300,
    aud: 'session-ingest',
    sub: 'service:cloud-agent-next',
    client_id: 'cloud-agent-next',
    iat: NOW,
    jti: 'jti-1',
    scope: 'session-ingest:events.write',
    req: 'cloud-agent-next',
    env: 'production',
    ...overrides,
  };
}

function audiences(count: number): Array<{ audience: string; scope: string }> {
  return Array.from({ length: count }, (_, i) => ({
    audience: `svc-${i}`,
    scope: `svc-${i}:read`,
  }));
}

describe('access token header', () => {
  it.each([
    ['EdDSA with kid and at+jwt', { alg: 'EdDSA', typ: 'at+jwt', kid: 'k1' }, true],
    ['extra header parameters', { alg: 'EdDSA', typ: 'at+jwt', kid: 'k1', cty: 'x' }, true],
    ['alg none', { alg: 'none', typ: 'at+jwt', kid: 'k1' }, false],
    ['alg HS256', { alg: 'HS256', typ: 'at+jwt', kid: 'k1' }, false],
    ['typ JWT', { alg: 'EdDSA', typ: 'JWT', kid: 'k1' }, false],
    ['missing kid', { alg: 'EdDSA', typ: 'at+jwt' }, false],
    ['empty kid', { alg: 'EdDSA', typ: 'at+jwt', kid: '' }, false],
  ])('%s', (_name, header, accepted) => {
    expect(AccessTokenHeaderSchema.safeParse(header).success).toBe(accepted);
  });
});

describe('access token claims', () => {
  it.each([
    ['the service profile', serviceClaims(), true],
    ['unknown claims', serviceClaims({ cnf: { jkt: 'x' }, extra: 1 }), true],
    [
      'a user token with org, sid, act, amr',
      serviceClaims({
        sub: 'user-1',
        client_id: 'kilo-cli',
        org: 'org-1',
        sid: 'grant-1',
        act: { sub: 'service:a', act: { sub: 'service:b' } },
        auth_time: NOW - 10,
        amr: ['passkey'],
      }),
      true,
    ],
    ['an array aud, even naming the service', serviceClaims({ aud: ['session-ingest'] }), false],
    [
      'two scopes in one string',
      serviceClaims({ scope: 'session-ingest:a session-ingest:b' }),
      false,
    ],
    ['a scope array', serviceClaims({ scope: ['session-ingest:a'] }), false],
    ['a string exp', serviceClaims({ exp: String(NOW + 300) }), false],
    ['missing sub', serviceClaims({ sub: undefined }), false],
    ['missing jti', serviceClaims({ jti: undefined }), false],
    ['missing client_id', serviceClaims({ client_id: undefined }), false],
    ['missing env', serviceClaims({ env: undefined }), false],
    ['an unknown env', serviceClaims({ env: 'preview' }), false],
    ['an actor without sub', serviceClaims({ act: { client_id: 'x' } }), false],
    ['amr not an array', serviceClaims({ amr: 'passkey' }), false],
  ])('%s', (_name, claims, accepted) => {
    expect(AccessTokenClaimsSchema.safeParse(claims).success).toBe(accepted);
  });

  it('keeps unknown claims in the parsed value', () => {
    const parsed = AccessTokenClaimsSchema.parse(serviceClaims({ extra: 'kept' }));
    expect(parsed.extra).toBe('kept');
  });
});

describe('STS service-token profile', () => {
  it.each([
    ['sub service:<workload>, client_id and req the workload', serviceClaims(), true],
    ['a 300 s lifetime', serviceClaims({ exp: NOW + 300 }), true],
    ['a 301 s lifetime', serviceClaims({ exp: NOW + 301 }), false],
    ['exp not after iat', serviceClaims({ exp: NOW }), false],
    ['sub naming another workload', serviceClaims({ sub: 'service:other' }), false],
    ['a user sub', serviceClaims({ sub: 'user-1' }), false],
    ['req naming another workload', serviceClaims({ req: 'other' }), false],
    ['missing req', serviceClaims({ req: undefined }), false],
    ['an org claim', serviceClaims({ org: 'org-1' }), false],
    ['a sid claim', serviceClaims({ sid: 'grant-1' }), false],
    ['an act claim', serviceClaims({ act: { sub: 'service:a' } }), false],
    ['an auth_time claim', serviceClaims({ auth_time: NOW }), false],
    ['an amr claim', serviceClaims({ amr: ['passkey'] }), false],
    [
      'a client_id that is not a workload name',
      serviceClaims({
        client_id: 'Bad_Name',
        sub: 'service:Bad_Name',
        req: 'Bad_Name',
      }),
      false,
    ],
  ])('%s', (_name, claims, accepted) => {
    expect(ServiceTokenClaimsSchema.safeParse(claims).success).toBe(accepted);
  });
});

describe('scope strings', () => {
  it.each([
    ['gateway:models.read', true],
    ['session-ingest:events_write', true],
    ['a-b:c.d-e_f', true],
    ['gateway', false],
    ['gateway:', false],
    [':read', false],
    ['Gateway:read', false],
    ['gateway:read write', false],
    ['gateway:read:more', false],
  ])('%s', (scope, accepted) => {
    expect(ScopeSchema.safeParse(scope).success).toBe(accepted);
  });

  it('names the audience before the colon', () => {
    expect(scopeAudience('gateway:models.read')).toBe('gateway');
  });
});

describe('STS scope registry', () => {
  it('lists only the pilot and UTS scopes, so every other scope is denied', () => {
    expect(STS_SCOPE_REGISTRY).toEqual({
      web: { scopes: ['web:sts.canary'] },
      'usage-ingest': { scopes: ['usage-ingest:sts.canary'] },
      'uts-feed': { scopes: ['uts-feed:revocation.read'] },
      uts: {
        scopes: [
          'uts:subjects.revoke',
          'uts:browser-sessions.end',
          'uts:api-credentials.revoke',
          'uts:token-exchange',
        ],
      },
    });
    expect(isRegisteredStsScope('web', 'web:sts.canary')).toBe(true);
    expect(isRegisteredStsScope('gateway', 'gateway:models.read')).toBe(false);
    expect(isRegisteredStsScope('web', 'usage-ingest:sts.canary')).toBe(false);
    expect(isRegisteredStsScope('uts', 'uts-feed:revocation.read')).toBe(false);
  });

  it('lists each shipped scope under its own audience', () => {
    expect(stsScopeRegistryProblems(STS_SCOPE_REGISTRY)).toEqual([]);
  });

  it('flags a scope whose prefix is not its audience', () => {
    const registry: StsScopeRegistry = { gateway: { scopes: ['o11y:write', 'gateway:read'] } };
    expect(stsScopeRegistryProblems(registry)).toEqual([
      'gateway: scope o11y:write belongs to audience o11y',
    ]);
  });

  it('flags invalid audiences, invalid scopes and duplicates', () => {
    const registry: StsScopeRegistry = {
      Gateway: { scopes: [] },
      o11y: { scopes: ['o11y:write', 'o11y:write', 'o11y'] },
    };
    expect(stsScopeRegistryProblems(registry)).toEqual([
      'audience "Gateway" is not a valid audience',
      'o11y: scope o11y:write is listed twice',
      'o11y: scope "o11y" is not a valid scope',
    ]);
  });

  it('never matches an inherited object key', () => {
    const registry: StsScopeRegistry = { o11y: { scopes: ['o11y:write'] } };
    expect(isRegisteredStsScope('o11y', 'o11y:write', registry)).toBe(true);
    expect(isRegisteredStsScope('constructor', 'constructor:x', registry)).toBe(false);
    expect(isRegisteredStsScope('__proto__', '__proto__:x', registry)).toBe(false);
  });
});

describe('mint request', () => {
  it.each([
    ['one token', { tokens: audiences(1) }, true],
    [`${MAX_AUDIENCES_PER_MINT} audiences`, { tokens: audiences(MAX_AUDIENCES_PER_MINT) }, true],
    ['no tokens', { tokens: [] }, false],
    ['9 audiences', { tokens: audiences(9) }, false],
    [
      'a duplicate audience',
      {
        tokens: [
          { audience: 'o11y', scope: 'o11y:read' },
          { audience: 'o11y', scope: 'o11y:write' },
        ],
      },
      false,
    ],
    [
      'a scope of another audience',
      { tokens: [{ audience: 'o11y', scope: 'gateway:read' }] },
      false,
    ],
    [
      'two scopes for one audience',
      { tokens: [{ audience: 'o11y', scope: 'o11y:read o11y:write' }] },
      false,
    ],
    ['an extra field', { tokens: audiences(1), lifetime: 600 }, false],
  ])('%s', (_name, request, accepted) => {
    expect(MintRequestSchema.safeParse(request).success).toBe(accepted);
  });
});

describe('mint result', () => {
  const issued = {
    status: 'issued',
    audience: 'o11y',
    scope: 'o11y:write',
    token: 'header.payload.signature',
    jti: 'jti-1',
    expiresAt: NOW + 300,
  };

  it.each([
    [
      'issued and denied entries',
      {
        status: 'ok',
        tokens: [
          issued,
          { status: 'denied', audience: 'gateway', scope: 'gateway:read', reason: 'unknown_scope' },
        ],
      },
      true,
    ],
    [
      'a denial with an unknown reason',
      {
        status: 'ok',
        tokens: [{ status: 'denied', audience: 'gateway', scope: 'gateway:read', reason: 'nope' }],
      },
      false,
    ],
    ['two results for one audience', { status: 'ok', tokens: [issued, issued] }, false],
    ['unavailable with retry seconds', { status: 'unavailable', retryAfterSeconds: 5 }, true],
    ['unavailable without retry seconds', { status: 'unavailable' }, false],
    ['identity rejected', { status: 'identity_rejected' }, true],
    ['invalid request', { status: 'invalid_request' }, true],
  ])('%s', (_name, result, accepted) => {
    expect(MintResultSchema.safeParse(result).success).toBe(accepted);
  });

  it('maps each whole-request outcome to its HTTP status', () => {
    expect(mintResultHttpStatus(MintResultSchema.parse({ status: 'ok', tokens: [issued] }))).toBe(
      200
    );
    expect(mintResultHttpStatus({ status: 'invalid_request' })).toBe(400);
    expect(mintResultHttpStatus({ status: 'identity_rejected' })).toBe(401);
    expect(mintResultHttpStatus({ status: 'unavailable', retryAfterSeconds: 1 })).toBe(503);
  });
});

describe('signing keys', () => {
  const x = 'A'.repeat(43);
  it.each([
    ['an Ed25519 key', { kty: 'OKP', crv: 'Ed25519', x, kid: 'k1' }, true],
    [
      'with alg EdDSA and use sig',
      { kty: 'OKP', crv: 'Ed25519', x, kid: 'k1', alg: 'EdDSA', use: 'sig' },
      true,
    ],
    ['an X25519 key', { kty: 'OKP', crv: 'X25519', x, kid: 'k1' }, false],
    ['an EC key', { kty: 'EC', crv: 'P-256', x, y: x, kid: 'k1' }, false],
    ['missing kid', { kty: 'OKP', crv: 'Ed25519', x }, false],
    ['a short x', { kty: 'OKP', crv: 'Ed25519', x: 'AAAA', kid: 'k1' }, false],
    ['use enc', { kty: 'OKP', crv: 'Ed25519', x, kid: 'k1', use: 'enc' }, false],
  ])('%s', (_name, jwk, accepted) => {
    expect(Ed25519PublicJwkSchema.safeParse(jwk).success).toBe(accepted);
  });
});

describe('issuers', () => {
  it('match STS_ISSUER of each wrangler environment', () => {
    expect(STS_ISSUERS).toEqual({
      development: 'http://localhost:8825',
      staging: 'https://sts-staging.kiloapps.io',
      production: 'https://sts.kiloapps.io',
    });
  });
});
