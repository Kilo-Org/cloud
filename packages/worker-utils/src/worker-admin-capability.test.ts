import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_CAPABILITY_TTL_SECONDS,
  GASTOWN_ADMIN_AUDIENCE,
  WORKER_ADMIN_CAPABILITY_HEADER,
  WORKER_ADMIN_CAPABILITY_TYP,
  WASTELAND_ADMIN_AUDIENCE,
  capabilityAllowsAction,
  createWorkerAdminAuthority,
  createWorkerAdminIntrospectionCache,
  evaluateLegacyAdminClaim,
  parseWorkerAdminJwks,
  readWorkerAdminCapabilityHeader,
  verifyWorkerAdminCapability,
  workerAdminBindingDigest,
  workerAdminServiceTarget,
  type WorkerAdminCapabilityClaims,
  type WorkerAdminJwks,
} from './worker-admin-capability';

const NOW = 1_800_000_000;
const KID = 'wac-test';

type KeyMaterial = {
  jwt: string;
  jwks: WorkerAdminJwks;
  privateKey: CryptoKey;
  publicJwk: JWK;
};

async function keyMaterial(kid = KID): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const publicJwk = { ...(await exportJWK(publicKey)), kid, use: 'sig', alg: 'ES256' };
  return {
    jwt: 'unused',
    jwks: { keys: [publicJwk] },
    privateKey,
    publicJwk,
  };
}

async function signCapability(
  material: KeyMaterial,
  overrides: Partial<WorkerAdminCapabilityClaims> = {},
  options: { kid?: string; typ?: string } = {}
): Promise<string> {
  const pepper = await workerAdminBindingDigest('pepper');
  const wsp = await workerAdminBindingDigest('');
  const claims: WorkerAdminCapabilityClaims = {
    iss: 'kilo-web',
    sub: 'user-1',
    aud: GASTOWN_ADMIN_AUDIENCE,
    env: 'test',
    iat: NOW,
    nbf: NOW,
    exp: NOW + BROWSER_CAPABILITY_TTL_SECONDS,
    jti: 'jti-1',
    cap: {
      v: 1,
      actions: ['trpc:gastown.getTown'],
      targets: [{ kind: 'town', id: 'town-1' }],
    },
    bnd: { pep: pepper, wsp },
    ...overrides,
  };
  return new SignJWT(claims as unknown as Record<string, unknown>)
    .setProtectedHeader({
      alg: 'ES256',
      typ: options.typ ?? WORKER_ADMIN_CAPABILITY_TYP,
      kid: options.kid ?? KID,
    })
    .sign(material.privateKey);
}

const identity = {
  kiloUserId: 'user-1',
  apiTokenPepper: 'pepper',
  env: 'test',
} as const;

const townTarget = { kind: 'town' as const, id: 'town-1' };
const otherTownTarget = { kind: 'town' as const, id: 'town-2' };

describe('legacy admin claim hardening', () => {
  it('accepts an hour-long admin claim', () => {
    expect(evaluateLegacyAdminClaim({ isAdmin: true, iat: NOW, exp: NOW + 3600 })).toEqual({
      allowed: true,
    });
  });

  it('rejects dateless and long-lived tokens', () => {
    expect(evaluateLegacyAdminClaim({ isAdmin: true, iat: NOW, exp: undefined })).toEqual({
      allowed: false,
      reason: 'missing_exp',
    });
    expect(evaluateLegacyAdminClaim({ isAdmin: true, iat: NOW, exp: NOW + 3601 })).toEqual({
      allowed: false,
      reason: 'lifetime_exceeded',
    });
  });

  it('ignores non-admin claims', () => {
    expect(evaluateLegacyAdminClaim({ isAdmin: false, iat: NOW, exp: NOW + 60 })).toEqual({
      allowed: false,
      reason: 'not_admin',
    });
  });
});

describe('worker admin capability verification', () => {
  it('accepts a capability bound to the identity and audience', async () => {
    const material = await keyMaterial();
    const token = await signCapability(material);
    const result = await verifyWorkerAdminCapability({
      token,
      jwks: material.jwks,
      audience: GASTOWN_ADMIN_AUDIENCE,
      identity,
      now: () => NOW * 1000,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects HS256 tokens signed with the shared secret', async () => {
    const material = await keyMaterial();
    const token = await new SignJWT({ hello: 'world' } as Record<string, unknown>)
      .setProtectedHeader({ alg: 'HS256', typ: WORKER_ADMIN_CAPABILITY_TYP, kid: KID })
      .sign(new TextEncoder().encode('nextauth-secret'));
    const result = await verifyWorkerAdminCapability({
      token,
      jwks: material.jwks,
      audience: GASTOWN_ADMIN_AUDIENCE,
      identity,
      now: () => NOW * 1000,
    });
    expect(result).toEqual({ ok: false, reason: 'algorithm' });
  });

  it.each([
    ['wrong audience', { aud: WASTELAND_ADMIN_AUDIENCE }],
    ['wrong subject', { sub: 'user-2' }],
    ['wrong environment', { env: 'production' }],
    ['lifetime over five minutes', { exp: NOW + BROWSER_CAPABILITY_TTL_SECONDS + 1 }],
    ['expired', { iat: NOW - 400, nbf: NOW - 400, exp: NOW - 100 }],
    ['not yet valid', { nbf: NOW + 120, iat: NOW + 120, exp: NOW + 300 }],
    ['unknown claim', { extra: true }],
  ])('rejects %s', async (_name, overrides) => {
    const material = await keyMaterial();
    const token = await signCapability(material, overrides as Partial<WorkerAdminCapabilityClaims>);
    const result = await verifyWorkerAdminCapability({
      token,
      jwks: material.jwks,
      audience: GASTOWN_ADMIN_AUDIENCE,
      identity,
      now: () => NOW * 1000,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown kid and a wrong token type', async () => {
    const material = await keyMaterial();
    const unknownKid = await signCapability(material, {}, { kid: 'other' });
    const wrongType = await signCapability(material, {}, { typ: 'JWT' });
    for (const token of [unknownKid, wrongType]) {
      const result = await verifyWorkerAdminCapability({
        token,
        jwks: material.jwks,
        audience: GASTOWN_ADMIN_AUDIENCE,
        identity,
        now: () => NOW * 1000,
      });
      expect(result.ok).toBe(false);
    }
  });

  it('rejects a capability bound to a different pepper', async () => {
    const material = await keyMaterial();
    const token = await signCapability(material);
    const result = await verifyWorkerAdminCapability({
      token,
      jwks: material.jwks,
      audience: GASTOWN_ADMIN_AUDIENCE,
      identity: { ...identity, apiTokenPepper: 'other' },
      now: () => NOW * 1000,
    });
    expect(result).toEqual({ ok: false, reason: 'binding' });
  });
});

describe('capability action and target scope', () => {
  it('accepts a matching action and target', async () => {
    const material = await keyMaterial();
    const token = await signCapability(material);
    const verification = await verifyWorkerAdminCapability({
      token,
      jwks: material.jwks,
      audience: GASTOWN_ADMIN_AUDIENCE,
      identity,
      now: () => NOW * 1000,
    });
    if (!verification.ok) throw new Error('expected capability');
    expect(
      capabilityAllowsAction(
        GASTOWN_ADMIN_AUDIENCE,
        verification.claims,
        'trpc:gastown.getTown',
        townTarget
      )
    ).toEqual({ allowed: true });
    expect(
      capabilityAllowsAction(
        GASTOWN_ADMIN_AUDIENCE,
        verification.claims,
        'trpc:gastown.getTown',
        otherTownTarget
      )
    ).toEqual({ allowed: false, reason: 'target_mismatch' });
    expect(
      capabilityAllowsAction(
        GASTOWN_ADMIN_AUDIENCE,
        verification.claims,
        'trpc:gastown.deleteBead',
        townTarget
      )
    ).toEqual({ allowed: false, reason: 'action_not_allowed' });
  });

  it('only allows service targets for list-all actions', async () => {
    const material = await keyMaterial();
    const token = await signCapability(material, {
      aud: WASTELAND_ADMIN_AUDIENCE,
      cap: {
        v: 1,
        actions: ['trpc:wasteland.adminListWastelands'],
        targets: [{ kind: 'service', id: 'wasteland' }],
      },
    });
    const verification = await verifyWorkerAdminCapability({
      token,
      jwks: material.jwks,
      audience: WASTELAND_ADMIN_AUDIENCE,
      identity,
      now: () => NOW * 1000,
    });
    if (!verification.ok) throw new Error('expected capability');
    expect(
      capabilityAllowsAction(
        WASTELAND_ADMIN_AUDIENCE,
        verification.claims,
        'trpc:wasteland.adminListWastelands',
        workerAdminServiceTarget(WASTELAND_ADMIN_AUDIENCE)
      )
    ).toEqual({ allowed: true });
    expect(
      capabilityAllowsAction(
        WASTELAND_ADMIN_AUDIENCE,
        verification.claims,
        'trpc:wasteland.adminListWastelands',
        { kind: 'service', id: 'gastown' }
      )
    ).toEqual({ allowed: false, reason: 'service_target_mismatch' });
  });
});

describe('worker admin authority', () => {
  const activeIntrospect = async () => ({ active: true });

  it('honors a hardened legacy claim in honor mode and rejects it in reject mode', async () => {
    const honored = await createWorkerAdminAuthority({
      mode: 'honor',
      audience: GASTOWN_ADMIN_AUDIENCE,
      identity,
      legacyClaim: true,
      capabilityToken: null,
      jwks: null,
      introspect: activeIntrospect,
      now: () => NOW * 1000,
    });
    await expect(honored.decide('trpc:gastown.deleteBead', townTarget)).resolves.toMatchObject({
      allowed: true,
      source: 'legacy',
      wouldDeny: false,
    });

    const rejected = await createWorkerAdminAuthority({
      mode: 'reject',
      audience: GASTOWN_ADMIN_AUDIENCE,
      identity,
      legacyClaim: true,
      capabilityToken: null,
      jwks: null,
      introspect: activeIntrospect,
      now: () => NOW * 1000,
    });
    await expect(rejected.decide('trpc:gastown.getTown', townTarget)).resolves.toMatchObject({
      allowed: false,
      status: 403,
      reason: 'legacy_claim_rejected',
    });
  });

  it('names the hardened-out legacy claim reason', async () => {
    const authority = await createWorkerAdminAuthority({
      mode: 'honor',
      audience: GASTOWN_ADMIN_AUDIENCE,
      identity,
      legacyClaim: false,
      legacyClaimRejection: 'lifetime_exceeded',
      capabilityToken: null,
      jwks: null,
      introspect: activeIntrospect,
      now: () => NOW * 1000,
    });
    await expect(authority.decide('trpc:gastown.getTown', townTarget)).resolves.toMatchObject({
      allowed: false,
      status: 401,
      reason: 'legacy_claim_lifetime_rejected',
    });
  });

  it('marks observe-mode legacy grants as would-deny', async () => {
    const authority = await createWorkerAdminAuthority({
      mode: 'observe',
      audience: GASTOWN_ADMIN_AUDIENCE,
      identity,
      legacyClaim: true,
      capabilityToken: null,
      jwks: null,
      introspect: activeIntrospect,
      now: () => NOW * 1000,
    });
    await expect(authority.decide('trpc:gastown.getTown', townTarget)).resolves.toMatchObject({
      allowed: true,
      wouldDeny: true,
    });
  });

  it('fails closed when the capability header is present but invalid', async () => {
    const material = await keyMaterial();
    const authority = await createWorkerAdminAuthority({
      mode: 'honor',
      audience: GASTOWN_ADMIN_AUDIENCE,
      identity,
      legacyClaim: true,
      capabilityToken: 'not-a-jwt',
      jwks: material.jwks,
      introspect: activeIntrospect,
      now: () => NOW * 1000,
    });
    await expect(authority.decide('trpc:gastown.getTown', townTarget)).resolves.toMatchObject({
      allowed: false,
      status: 401,
    });
  });

  it('never falls back to the legacy claim when a capability is present', async () => {
    const material = await keyMaterial();
    const token = await signCapability(material);
    const authority = await createWorkerAdminAuthority({
      mode: 'honor',
      audience: GASTOWN_ADMIN_AUDIENCE,
      identity,
      legacyClaim: true,
      capabilityToken: token,
      jwks: material.jwks,
      introspect: activeIntrospect,
      now: () => NOW * 1000,
    });
    await expect(authority.decide('trpc:gastown.getTown', otherTownTarget)).resolves.toMatchObject({
      allowed: false,
      status: 403,
      reason: 'target_mismatch',
    });
  });

  it('rejects inactive introspection and 503s on transport failure', async () => {
    const material = await keyMaterial();
    const token = await signCapability(material);

    const inactive = await createWorkerAdminAuthority({
      mode: 'reject',
      audience: GASTOWN_ADMIN_AUDIENCE,
      identity,
      legacyClaim: false,
      capabilityToken: token,
      jwks: material.jwks,
      introspect: async () => ({ active: false, reason: 'blocked' }),
      now: () => NOW * 1000,
    });
    await expect(inactive.decide('trpc:gastown.getTown', townTarget)).resolves.toMatchObject({
      allowed: false,
      status: 403,
      reason: 'blocked',
    });

    const unavailable = await createWorkerAdminAuthority({
      mode: 'reject',
      audience: GASTOWN_ADMIN_AUDIENCE,
      identity,
      legacyClaim: false,
      capabilityToken: token,
      jwks: material.jwks,
      introspect: async () => {
        throw new Error('offline');
      },
      now: () => NOW * 1000,
    });
    await expect(unavailable.decide('trpc:gastown.getTown', townTarget)).resolves.toMatchObject({
      allowed: false,
      status: 503,
      reason: 'validation_unavailable',
    });
  });

  it('caches read introspection but never caches writes', async () => {
    const material = await keyMaterial();
    const token = await signCapability(material, {
      cap: {
        v: 1,
        actions: ['trpc:gastown.getTown', 'trpc:gastown.adminForceFailBead'],
        targets: [{ kind: 'town', id: 'town-1' }],
      },
    });
    let calls = 0;
    const readCache = createWorkerAdminIntrospectionCache();
    const createAuthority = () =>
      createWorkerAdminAuthority({
        mode: 'reject',
        audience: GASTOWN_ADMIN_AUDIENCE,
        identity,
        legacyClaim: false,
        capabilityToken: token,
        jwks: material.jwks,
        readCache,
        introspect: async () => {
          calls += 1;
          return { active: true };
        },
        now: () => NOW * 1000,
      });

    await (await createAuthority()).decide('trpc:gastown.getTown', townTarget);
    await (await createAuthority()).decide('trpc:gastown.getTown', townTarget);
    expect(calls).toBe(1);

    await (await createAuthority()).decide('trpc:gastown.adminForceFailBead', townTarget);
    await (await createAuthority()).decide('trpc:gastown.adminForceFailBead', townTarget);
    expect(calls).toBe(3);
  });
});

describe('introspection cache bounds', () => {
  it('evicts old entries instead of growing without bound', () => {
    const cache = createWorkerAdminIntrospectionCache();
    for (let index = 0; index < 600; index += 1) {
      cache.set(`key-${index}`, { active: true }, 60_000);
    }
    expect(cache.get('key-0')).toBeUndefined();
    expect(cache.get('key-599')).toEqual({ active: true });
  });

  it('prunes expired entries before evicting live ones', () => {
    const cache = createWorkerAdminIntrospectionCache();
    cache.set('expired', { active: true }, -1);
    for (let index = 0; index < 500; index += 1) {
      cache.set(`live-${index}`, { active: true }, 60_000);
    }
    expect(cache.get('expired')).toBeUndefined();
    expect(cache.get('live-0')).toEqual({ active: true });
  });
});

describe('helpers', () => {
  it('parses JWKS values', () => {
    expect(parseWorkerAdminJwks('{"keys":[{"kty":"EC"}]}')).toEqual({
      keys: [{ kty: 'EC' }],
    });
    expect(parseWorkerAdminJwks('not json')).toBeNull();
    expect(parseWorkerAdminJwks(null)).toBeNull();
  });

  it('reads the capability header defensively', () => {
    const headers = new Headers({ [WORKER_ADMIN_CAPABILITY_HEADER]: ' token ' });
    expect(readWorkerAdminCapabilityHeader(headers)).toBe('token');
    expect(readWorkerAdminCapabilityHeader(new Headers())).toBeNull();
  });
});
