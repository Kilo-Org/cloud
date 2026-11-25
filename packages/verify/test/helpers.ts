import type { StsScopeRegistry } from '@kilocode/sts-contracts';
import { SignJWT, base64url, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { createVerifier, type PatConfig, type Verifier, type VerifyContext } from '../src/index';
import type { FeedFetch, FeedHead, RevocationList } from '../src/revocation';
import type { UtsScopeRegistry } from '../src/verifier';

export const AUDIENCE = 'session-ingest';
export const SCOPE = 'session-ingest:events.write';
export const OTHER_SCOPE = 'session-ingest:events.read';
export const SESSION_SCOPE = 'session-ingest:session.manage';
/** Registered for UTS tokens, but no PAT may carry it. */
export const NO_PAT_SCOPE = 'session-ingest:admin.read';
export const STS_ISSUER = 'https://sts.test';
export const UTS_ISSUER = 'https://uts.test';
export const RESOURCE_METADATA = 'https://session-ingest.test/.well-known/oauth-protected-resource';

export const STS_REGISTRY: StsScopeRegistry = { [AUDIENCE]: { scopes: [SCOPE, OTHER_SCOPE] } };

const UTS_SCOPES: Record<string, { requiresSession: boolean; patEligible: boolean }> = {
  [SCOPE]: { requiresSession: false, patEligible: true },
  [OTHER_SCOPE]: { requiresSession: false, patEligible: true },
  [SESSION_SCOPE]: { requiresSession: true, patEligible: true },
  [NO_PAT_SCOPE]: { requiresSession: false, patEligible: false },
};
export const UTS_REGISTRY: UtsScopeRegistry = (audience, scope) =>
  audience === AUDIENCE && Object.hasOwn(UTS_SCOPES, scope) ? (UTS_SCOPES[scope] ?? null) : null;

/** UTS token keys carry this `kid` prefix; its feed keys carry another (uts-contracts jwks.ts). */
export const UTS_TOKEN_KID_PREFIX = 'uts-token-00-';
export const isUtsTokenKid = (kid: string): boolean => kid.startsWith(UTS_TOKEN_KID_PREFIX);

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export type Issuer = {
  issuer: string;
  kid: string;
  jwk: Record<string, unknown>;
  privateKey: CryptoKey;
};

export async function createIssuer(issuer: string, kidPrefix = ''): Promise<Issuer> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true });
  const exported = await exportJWK(publicKey);
  const kid = `${kidPrefix}${await calculateJwkThumbprint(exported)}`;
  return { issuer, kid, jwk: { ...exported, kid, alg: 'EdDSA', use: 'sig' }, privateKey };
}

export async function sign(
  issuer: Issuer,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {}
): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ typ: 'at+jwt', kid: issuer.kid, ...header, alg: 'EdDSA' })
    .sign(issuer.privateKey);
}

/** A token whose header is exactly `header`, signed with whatever `alg` it names. */
export async function signWithHeader(
  issuer: Issuer,
  claims: Record<string, unknown>,
  header: Record<string, unknown>
): Promise<string> {
  const encode = (value: unknown) => base64url.encode(JSON.stringify(value));
  switch (header.alg) {
    case 'none':
      return `${encode(header)}.${encode(claims)}.`;
    case 'HS256':
      return await new SignJWT(claims)
        .setProtectedHeader({ ...header, alg: 'HS256' })
        .sign(new TextEncoder().encode('a-shared-secret-of-sufficient-length'));
    case 'RS256':
    case 'ES256': {
      const { privateKey } = await generateKeyPair(header.alg);
      return await new SignJWT(claims)
        .setProtectedHeader({ ...header, alg: header.alg })
        .sign(privateKey);
    }
    default: {
      const encoded = `${encode(header)}.${encode(claims)}`;
      const signature = new Uint8Array(
        await crypto.subtle.sign('Ed25519', issuer.privateKey, new TextEncoder().encode(encoded))
      );
      return `${encoded}.${base64url.encode(signature)}`;
    }
  }
}

export function stsClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = nowSeconds();
  return {
    iss: STS_ISSUER,
    exp: now + 300,
    aud: AUDIENCE,
    sub: 'service:cloud-agent-next',
    client_id: 'cloud-agent-next',
    iat: now,
    jti: crypto.randomUUID(),
    scope: SCOPE,
    req: 'cloud-agent-next',
    env: 'production',
    ...overrides,
  };
}

export function utsClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = nowSeconds();
  return {
    iss: UTS_ISSUER,
    exp: now + 600,
    aud: AUDIENCE,
    sub: 'user-1',
    client_id: 'kilo-cli',
    iat: now,
    jti: crypto.randomUUID(),
    scope: SCOPE,
    sid: 'grant-1',
    env: 'production',
    ...overrides,
  };
}

export type SourceMode = 'ok' | 'fail' | 'hang';

/** A held answer: a source awaits `promise` until the test calls `release`. */
export type Gate = { promise: Promise<void>; release: () => void };

export function gate(): Gate {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, release: () => resolve() };
}

/** A source answer that never arrives. */
const never = <T>(): Promise<T> => Promise.withResolvers<T>().promise;

/** A scripted key-set source: counts fetches; `mode` decides the answer, `gate` holds it. */
export type FakeJwks = {
  keys: unknown[];
  mode: SourceMode;
  gate: Gate | null;
  calls: number;
  source: (signal: AbortSignal) => Promise<unknown>;
};

export function fakeJwks(keys: unknown[]): FakeJwks {
  const fake: FakeJwks = {
    keys,
    mode: 'ok',
    gate: null,
    calls: 0,
    source: async () => {
      fake.calls++;
      if (fake.gate !== null) await fake.gate.promise;
      if (fake.mode === 'fail') throw new Error('issuer unreachable');
      if (fake.mode === 'hang') return await never();
      return { keys: fake.keys };
    },
  };
  return fake;
}

export function emptyList(): RevocationList {
  return {
    revokedBefore: new Map(),
    revokedSids: new Set(),
    revokedKids: new Set(),
    revokedPatIds: new Set(),
    blockedAccounts: new Set(),
  };
}

/**
 * A scripted revocation feed: each fetch answers a head signed `headAgeMs` ago (or exactly at
 * `headIssuedAt` when set); `gate` holds the answer.
 */
export type FakeFeed = {
  list: RevocationList;
  listHash: string;
  headAgeMs: number;
  headIssuedAt: number | null;
  mode: SourceMode;
  gate: Gate | null;
  calls: number;
  listsSent: number;
  heldOnLastCall: FeedHead | null;
  source: { fetch(held: FeedHead | null, signal: AbortSignal): Promise<FeedFetch> };
};

export function fakeFeed(): FakeFeed {
  const fake: FakeFeed = {
    list: emptyList(),
    listHash: 'hash-1',
    headAgeMs: 0,
    headIssuedAt: null,
    mode: 'ok',
    gate: null,
    calls: 0,
    listsSent: 0,
    heldOnLastCall: null,
    source: {
      async fetch(held) {
        fake.calls++;
        fake.heldOnLastCall = held;
        if (fake.gate !== null) await fake.gate.promise;
        if (fake.mode === 'fail') throw new Error('feed unreachable');
        if (fake.mode === 'hang') return await never();
        const issuedAt = fake.headIssuedAt ?? Date.now() - fake.headAgeMs;
        const head = { issuedAt, listHash: fake.listHash };
        if (held !== null && held.listHash === fake.listHash) return { head, list: null };
        fake.listsSent++;
        return { head, list: fake.list };
      },
    },
  };
  return fake;
}

export type Harness = {
  verifier: Verifier;
  sts: Issuer;
  uts: Issuer;
  stsJwks: FakeJwks;
  utsJwks: FakeJwks;
  feed: FakeFeed;
  background: Promise<unknown>[];
  ctx: VerifyContext;
};

export async function harness(options: { pat?: PatConfig } = {}): Promise<Harness> {
  const sts = await createIssuer(STS_ISSUER);
  const uts = await createIssuer(UTS_ISSUER, UTS_TOKEN_KID_PREFIX);
  const stsJwks = fakeJwks([sts.jwk]);
  const utsJwks = fakeJwks([uts.jwk]);
  const feed = fakeFeed();
  const background: Promise<unknown>[] = [];
  const verifier = createVerifier({
    audience: AUDIENCE,
    resourceMetadataUrl: RESOURCE_METADATA,
    sts: { issuer: STS_ISSUER, jwks: stsJwks.source, scopeRegistry: STS_REGISTRY },
    uts: {
      issuer: UTS_ISSUER,
      jwks: utsJwks.source,
      isTokenKid: isUtsTokenKid,
      scopeRegistry: UTS_REGISTRY,
      revocation: feed.source,
      pat: options.pat,
    },
  });
  return {
    verifier,
    sts,
    uts,
    stsJwks,
    utsJwks,
    feed,
    background,
    ctx: { waitUntil: promise => background.push(promise), clientAddress: '203.0.113.7' },
  };
}

export const bearer = (token: string): string => `Bearer ${token}`;

/** Lets the background calls handed to `waitUntil` so far settle. */
export async function drain(background: Promise<unknown>[]): Promise<void> {
  await Promise.all(background.splice(0));
}
