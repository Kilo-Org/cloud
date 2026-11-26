import { SELF, createExecutionContext, runInDurableObject } from 'cloudflare:test';
import {
  Ed25519PublicJwkSchema,
  JWKS_PATH,
  ServiceTokenClaimsSchema,
  type MintRequest,
} from '@kilocode/sts-contracts';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../../src/audit/log';
import { TOKEN_AUDIT_RETENTION_MS } from '../../src/constants';
import { getTokenSignerStub } from '../../src/dos/stubs';
import {
  TokenSignerDO,
  type TokenSignRequest,
  type TokenSignResult,
} from '../../src/dos/TokenSignerDO';
import { handleRequest } from '../../src/http';
import type { KeyRing } from '../../src/tokens/key-ring';
import { stubOfflineNetwork } from './manager';
import { resetTokenSignerObject } from './reset';
import { config, env } from './test-env';

type StoredEvent = { type: string; data: { attributes: Record<string, unknown> } };

const signer = () => getTokenSignerStub(env, config, 0);

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

  it('exposes only mint, getJwks and alarm to a stub, so no caller reaches a key', async () => {
    expect(Object.getOwnPropertyNames(TokenSignerDO.prototype).sort()).toEqual([
      'alarm',
      'constructor',
      'getJwks',
      'mint',
    ]);
    // An internal method name is refused over RPC, not answered with the key record. Awaited
    // directly: handing the RPC promise to `expect(...).rejects` left an unhandled rejection.
    const stub = signer() as unknown as { currentKey(): Promise<unknown> };
    let refusal: unknown = null;
    try {
      await stub.currentKey();
    } catch (error) {
      refusal = error;
    }
    expect(String(refusal)).toContain('does not implement "currentKey"');
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
      cause: 'listed',
      replacementKid: kid,
    });
  });

  it('prunes relayed rows past the token retention window and keeps unrelayed ones', async () => {
    await signer().mint(signRequest());
    await signer().mint(signRequest());
    const old = Date.now() - TOKEN_AUDIT_RETENTION_MS - 60_000;
    const kept = await runInDurableObject(signer(), (_instance, state) => {
      const seqs = state.storage.sql
        .exec<{ seq: number }>('SELECT seq FROM audit_event ORDER BY seq')
        .toArray()
        .map(row => row.seq);
      // Every row is old; all but the last were relayed.
      state.storage.sql.exec('UPDATE audit_event SET created_at = ?', old);
      state.storage.sql.exec(
        'INSERT OR REPLACE INTO audit_watermark (id, relayed_seq) VALUES (1, ?)',
        seqs[seqs.length - 2]
      );
      state.storage.sql.exec('DELETE FROM audit_prune');
      return seqs[seqs.length - 1];
    });
    // The relay fails, so the alarm only prunes.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(AuditLog.prototype, 'relay').mockRejectedValueOnce(new Error('queue down'));
    await runInDurableObject(signer(), instance => instance.alarm());
    const left = await runInDurableObject(signer(), (_instance, state) =>
      state.storage.sql
        .exec<{ seq: number }>('SELECT seq FROM audit_event ORDER BY seq')
        .toArray()
        .map(row => row.seq)
    );
    expect(left).toEqual([kept]);
  });

  it('keeps a latest exp a mint records while a rotation is writing its audit rows', async () => {
    const [{ kid }] = (await signer().getJwks()).keys;
    const after = await runInDurableObject(signer(), async (instance, state) => {
      const append = AuditLog.prototype.append;
      let minted: TokenSignResult | undefined;
      // 24 days on, the next call publishes the next key.
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 24 * 60 * 60 * 1000);
      // A mint that read the current key before the rotation records its exp in the rotation's
      // first await.
      vi.spyOn(AuditLog.prototype, 'append').mockImplementationOnce(async function (
        this: AuditLog,
        ...args
      ) {
        clock.mockRestore();
        minted = await instance.mint(signRequest());
        return await append.apply(this, args);
      });
      await instance.getJwks();
      return { minted, keys: (await state.storage.get<KeyRing>('token-key-ring'))?.keys };
    });
    if (after.minted?.status !== 'signed') throw new Error('expected the racing mint to sign');
    const [token] = after.minted.tokens;
    expect(decodeProtectedHeader(token.token).kid).toBe(kid);
    expect(after.keys?.map(key => key.state)).toEqual(['current', 'next']);
    expect(after.keys?.find(key => key.kid === kid)?.maxExp).toBe(
      Math.ceil(token.expiresAt / 60) * 60
    );
  });
});

describe('service-token key set route', () => {
  it('serves the public keys with no-store and no private material', async () => {
    const response = await SELF.fetch(`${config.issuer}${JWKS_PATH}`);
    expect(response.status).toBe(200);
    // No HTTP cache may hold the set or serve it stale; only the verifier's own 5-minute copy counts.
    expect(response.headers.get('cache-control')).toBe('no-store');
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

  it('rebuilds its isolate copy when the revoked-kid list changes', async () => {
    const ctx = createExecutionContext();
    const fetchKids = async (revoked: string) => {
      const response = await handleRequest(
        new Request(`${config.issuer}${JWKS_PATH}`),
        { ...env, TOKEN_SIGNING_KIDS_REVOKED: revoked },
        ctx
      );
      return (await response.json<{ keys: Array<{ kid: string }> }>()).keys.map(key => key.kid);
    };
    await fetchKids('A'.repeat(43));
    // Shard 0 gets a fresh key (as after an emergency removal); a deploy changes the list.
    await resetTokenSignerObject(signer());
    const [{ kid: fresh }] = (await signer().getJwks()).keys;
    expect(await fetchKids('B'.repeat(43))).toContain(fresh);
  });
});
