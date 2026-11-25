import { SELF, runInDurableObject } from 'cloudflare:test';
import {
  Ed25519PublicJwkSchema,
  JWKS_CACHE_CONTROL,
  JWKS_PATH,
  ServiceTokenClaimsSchema,
  type MintRequest,
} from '@kilocode/sts-contracts';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../../src/audit/log';
import { getTokenSignerStub, tokenSignerShard } from '../../src/dos/stubs';
import { TokenSignerDO, type TokenSignRequest } from '../../src/dos/TokenSignerDO';
import { stubOfflineNetwork } from './manager';
import { resetTokenSignerObject } from './reset';
import { config, env } from './test-env';

type StoredEvent = { type: string; data: { attributes: Record<string, unknown> } };

const signer = () => getTokenSignerStub(env, config, tokenSignerShard('probe'));

beforeEach(async () => {
  stubOfflineNetwork();
  await resetTokenSignerObject(signer());
});

afterEach(() => {
  vi.restoreAllMocks();
});

function entries(count: number): MintRequest['tokens'] {
  return Array.from({ length: count }, (_, index) => ({
    audience: `aud-${index + 1}`,
    scope: `aud-${index + 1}:read`,
  }));
}

function signRequest(overrides: Partial<TokenSignRequest> = {}): TokenSignRequest {
  return {
    environment: config.environment,
    workload: 'probe',
    identity: 'worker-binding',
    attestationExp: null,
    request: { tokens: entries(1) },
    ...overrides,
  };
}

function auditEvents(): Promise<StoredEvent[]> {
  return runInDurableObject(signer(), (_instance, state) =>
    state.storage.sql
      .exec<{ event: string }>('SELECT event FROM audit_event ORDER BY seq')
      .toArray()
      .map(row => JSON.parse(row.event) as StoredEvent)
  );
}

async function issuedEvents(): Promise<StoredEvent[]> {
  return (await auditEvents()).filter(event => event.type === 'ai.kilo.sts.token.issued');
}

async function keySet() {
  const jwks = await signer().getJwks();
  return createLocalJWKSet({ keys: jwks.keys.map(key => ({ ...key })) });
}

describe('token signer', () => {
  it('signs a batch of 8 under one key and appends one audit row listing every token', async () => {
    const result = await signer().mint(signRequest({ request: { tokens: entries(8) } }));
    if (result.status !== 'signed') throw new Error(`expected signed, got ${result.status}`);
    expect(result.tokens).toHaveLength(8);

    const jwks = await keySet();
    const kids = new Set<string>();
    for (const [index, issued] of result.tokens.entries()) {
      expect(issued).toMatchObject({ status: 'issued', audience: `aud-${index + 1}` });
      const header = decodeProtectedHeader(issued.token);
      expect(header).toMatchObject({ alg: 'EdDSA', typ: 'at+jwt' });
      kids.add(String(header.kid));
      const { payload } = await jwtVerify(issued.token, jwks, {
        issuer: config.issuer,
        audience: `aud-${index + 1}`,
        typ: 'at+jwt',
        algorithms: ['EdDSA'],
      });
      const claims = ServiceTokenClaimsSchema.parse(payload);
      expect(claims).toMatchObject({
        sub: 'service:probe',
        client_id: 'probe',
        req: 'probe',
        env: 'development',
        scope: `aud-${index + 1}:read`,
        jti: issued.jti,
        exp: issued.expiresAt,
      });
      expect(claims.exp - claims.iat).toBe(300);
    }
    expect(kids.size).toBe(1);

    const rows = await issuedEvents();
    expect(rows).toHaveLength(1);
    const attributes = rows[0].data.attributes;
    expect(attributes).toMatchObject({
      workload: 'probe',
      identity: 'worker-binding',
      kid: [...kids][0],
      lifetimeSeconds: 300,
      attestationCapped: false,
      tokenCount: 8,
      jtis: result.tokens.map(token => token.jti),
      audiences: entries(8).map(entry => entry.audience),
      scopes: entries(8).map(entry => entry.scope),
    });
    // The row lists references, never a token.
    expect(JSON.stringify(rows)).not.toContain(result.tokens[0].token);
  });

  it('caps exp at the attestation exp', async () => {
    const attestationExp = Math.floor(Date.now() / 1000) + 120;
    const result = await signer().mint(signRequest({ attestationExp }));
    if (result.status !== 'signed') throw new Error(`expected signed, got ${result.status}`);
    expect(result.tokens[0].expiresAt).toBe(attestationExp);
    const { payload } = await jwtVerify(result.tokens[0].token, await keySet(), {
      audience: 'aud-1',
    });
    expect(payload.exp).toBe(attestationExp);
    expect((await issuedEvents())[0].data.attributes).toMatchObject({ attestationCapped: true });
  });

  it('refuses when the attestation leaves under 60 seconds, and signs nothing', async () => {
    const attestationExp = Math.floor(Date.now() / 1000) + 30;
    expect(await signer().mint(signRequest({ attestationExp }))).toEqual({
      status: 'attestation_expiring',
    });
    expect(await issuedEvents()).toEqual([]);
  });

  it('returns no token when the audit append fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await signer().getJwks();
    vi.spyOn(AuditLog.prototype, 'append').mockRejectedValueOnce(new Error('append failed'));
    expect(await signer().mint(signRequest({ request: { tokens: entries(3) } }))).toEqual({
      status: 'unavailable',
    });
    expect(await issuedEvents()).toEqual([]);
  });

  it('refuses a call for another environment', async () => {
    expect(await signer().mint(signRequest({ environment: 'production' }))).toEqual({
      status: 'unavailable',
    });
  });

  it('keeps its key across an object restart and records the key creation once', async () => {
    const before = await signer().getJwks();
    expect(before.keys).toHaveLength(1);
    await runInDurableObject(signer(), (_instance, state) => state.abort('restart')).catch(
      () => undefined
    );
    const after = await signer().getJwks();
    expect(after.keys.map(key => key.kid)).toEqual(before.keys.map(key => key.kid));
    const created = (await auditEvents()).filter(
      event => event.type === 'ai.kilo.sts.token_key.rotated'
    );
    expect(created).toHaveLength(1);
    expect(created[0].data.attributes).toMatchObject({
      change: 'created',
      kid: before.keys[0].kid,
    });
  });

  it('drops a revoked current key from the key set, promotes a fresh one and audits the removal', async () => {
    const [revoked] = (await signer().getJwks()).keys;
    // A deploy that lists the kid restarts the object with the new var; this instance has it.
    const after = await runInDurableObject(signer(), async (_instance, state) => {
      const restarted = new TokenSignerDO(state, {
        ...env,
        TOKEN_SIGNING_KIDS_REVOKED: revoked.kid,
      });
      const jwks = await restarted.getJwks();
      const minted = await restarted.mint(signRequest());
      return { jwks, minted };
    });
    expect(after.jwks.keys.map(key => key.kid)).not.toContain(revoked.kid);
    expect(after.jwks.keys).toHaveLength(1);
    if (after.minted.status !== 'signed') throw new Error(`got ${after.minted.status}`);
    const kid = decodeProtectedHeader(after.minted.tokens[0].token).kid;
    expect(kid).toBe(after.jwks.keys[0].kid);
    expect(kid).not.toBe(revoked.kid);

    const removal = (await auditEvents()).filter(
      event => event.type === 'ai.kilo.sts.token_key.revoked'
    );
    expect(removal).toHaveLength(1);
    expect(removal[0].data.attributes).toMatchObject({
      kid: revoked.kid,
      state: 'current',
      replacementKid: kid,
    });
  });
});

describe('service-token key set route', () => {
  it('serves the public keys with the design cache headers and no private material', async () => {
    const response = await SELF.fetch(`${config.issuer}${JWKS_PATH}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(JWKS_CACHE_CONTROL);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = await response.json<{ keys: Array<Record<string, unknown>> }>();
    expect(body.keys.length).toBeGreaterThan(0);
    for (const key of body.keys) {
      expect(Ed25519PublicJwkSchema.parse(key)).toMatchObject({ alg: 'EdDSA', use: 'sig' });
      expect(Object.keys(key).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x']);
    }
  });

  it('leaves the manager login key set as it was', async () => {
    const response = await SELF.fetch(`${config.issuer}/manager-auth/.well-known/jwks.json`);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    const body = await response.json<{ keys: Array<{ alg: string }> }>();
    expect(body.keys.map(key => key.alg)).toEqual(['ES256']);
  });
});
