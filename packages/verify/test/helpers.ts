import type { StsScopeRegistry } from '@kilocode/sts-contracts';
import { SignJWT, base64url, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { vi } from 'vitest';
import {
  FEED_HEAD_TYPE,
  createVerifier,
  type PatConfig,
  type RevocationFeedSource,
  type RevocationList,
  type RevocationListWire,
  type UtsBootstrapSource,
  type Verifier,
  type VerifyContext,
} from '../src/index';
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

/** `kid` prefixes of one UTS signer object's token key and of one feed object's key. */
export const UTS_TOKEN_KID = 'uts-token-00-';
export const UTS_FEED_KID = 'uts-feed-0-';

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

/** A compact JWS with exactly this header and payload, signed with Ed25519 whatever `alg` says. */
export async function signCompact(
  privateKey: CryptoKey,
  header: Record<string, unknown>,
  payload: unknown
): Promise<string> {
  const encode = (value: unknown) => base64url.encode(JSON.stringify(value));
  const encoded = `${encode(header)}.${encode(payload)}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(encoded))
  );
  return `${encoded}.${base64url.encode(signature)}`;
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
    default:
      return await signCompact(issuer.privateKey, header, claims);
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

/** The list as UTS serves it: UTF-8 JSON of the wire schema. */
export function encodeList(list: RevocationList): Uint8Array<ArrayBuffer> {
  const wire: RevocationListWire = {
    revoked_before: Object.fromEntries(list.revokedBefore),
    revoked_sids: [...list.revokedSids],
    revoked_kids: [...list.revokedKids],
    revoked_pat_ids: [...list.revokedPatIds],
    blocked_accounts: [...list.blockedAccounts],
  };
  return new TextEncoder().encode(JSON.stringify(wire));
}

export async function listHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

/**
 * A scripted revocation feed that signs real heads with `signer`: each head is signed `headAgeMs`
 * ago (or exactly at `headIssuedAt`, in ms, when set) over the current `list`. `gate` holds the
 * head answer; `header` adds header parameters; `tamperList` serves list bytes off the hash.
 */
export type FakeFeed = {
  list: RevocationList;
  signer: Issuer;
  headAgeMs: number;
  headIssuedAt: number | null;
  header: Record<string, unknown>;
  tamperList: boolean;
  mode: SourceMode;
  gate: Gate | null;
  /** Head fetches. */
  calls: number;
  /** List fetches. */
  listsSent: number;
  /** A signed head and its list bytes now, without counting a fetch (the bootstrap uses it). */
  current(): Promise<{ head: string; list: Uint8Array<ArrayBuffer> }>;
  source: RevocationFeedSource;
};

export function fakeFeed(signer: Issuer): FakeFeed {
  const served = new Map<string, Uint8Array<ArrayBuffer>>();
  const fake: FakeFeed = {
    list: emptyList(),
    signer,
    headAgeMs: 0,
    headIssuedAt: null,
    header: {},
    tamperList: false,
    mode: 'ok',
    gate: null,
    calls: 0,
    listsSent: 0,
    async current() {
      const bytes = encodeList(fake.list);
      const hash = await listHash(bytes);
      served.set(hash, bytes);
      const issuedAtMs = fake.headIssuedAt ?? Date.now() - fake.headAgeMs;
      const head = await signCompact(
        fake.signer.privateKey,
        { alg: 'EdDSA', typ: FEED_HEAD_TYPE, kid: fake.signer.kid, ...fake.header },
        { iat: Math.floor(issuedAtMs / 1000), list_hash: hash }
      );
      return { head, list: bytes };
    },
    source: {
      async head() {
        fake.calls++;
        if (fake.gate !== null) await fake.gate.promise;
        if (fake.mode === 'fail') throw new Error('feed unreachable');
        if (fake.mode === 'hang') return await never();
        return (await fake.current()).head;
      },
      async list(hash) {
        fake.listsSent++;
        const bytes = served.get(hash);
        if (bytes === undefined) throw new Error('unknown list hash');
        return fake.tamperList
          ? encodeList({ ...emptyList(), revokedSids: new Set(['x']) })
          : bytes;
      },
    },
  };
  return fake;
}

/** A scripted bootstrap endpoint answering the fake UTS key set, head and list in one call. */
export type FakeBootstrap = {
  mode: SourceMode;
  gate: Gate | null;
  calls: number;
  source: UtsBootstrapSource;
};

export function fakeBootstrap(jwks: FakeJwks, feed: FakeFeed): FakeBootstrap {
  const fake: FakeBootstrap = {
    mode: 'ok',
    gate: null,
    calls: 0,
    source: async () => {
      fake.calls++;
      if (fake.gate !== null) await fake.gate.promise;
      if (fake.mode === 'fail') throw new Error('bootstrap unreachable');
      if (fake.mode === 'hang') return await never();
      const { head, list } = await feed.current();
      return { jwks: { keys: jwks.keys }, head, list };
    },
  };
  return fake;
}

export type Harness = {
  verifier: Verifier;
  sts: Issuer;
  uts: Issuer;
  feedSigner: Issuer;
  stsJwks: FakeJwks;
  utsJwks: FakeJwks;
  feed: FakeFeed;
  bootstrap: FakeBootstrap;
  background: Promise<unknown>[];
  ctx: VerifyContext;
};

export async function harness(
  options: { pat?: PatConfig; bootstrap?: boolean } = {}
): Promise<Harness> {
  const sts = await createIssuer(STS_ISSUER);
  const uts = await createIssuer(UTS_ISSUER, UTS_TOKEN_KID);
  const feedSigner = await createIssuer(UTS_ISSUER, UTS_FEED_KID);
  const stsJwks = fakeJwks([sts.jwk]);
  const utsJwks = fakeJwks([uts.jwk, feedSigner.jwk]);
  const feed = fakeFeed(feedSigner);
  const bootstrap = fakeBootstrap(utsJwks, feed);
  const background: Promise<unknown>[] = [];
  const verifier = createVerifier({
    audience: AUDIENCE,
    environment: 'production',
    resourceMetadataUrl: RESOURCE_METADATA,
    sts: { issuer: STS_ISSUER, jwks: stsJwks.source, scopeRegistry: STS_REGISTRY },
    uts: {
      issuer: UTS_ISSUER,
      jwks: utsJwks.source,
      scopeRegistry: UTS_REGISTRY,
      revocation: feed.source,
      bootstrap: options.bootstrap === true ? bootstrap.source : undefined,
      pat: options.pat,
    },
  });
  return {
    verifier,
    sts,
    uts,
    feedSigner,
    stsJwks,
    utsJwks,
    feed,
    bootstrap,
    background,
    ctx: { waitUntil: promise => background.push(promise), clientAddress: '203.0.113.7' },
  };
}

export const bearer = (token: string): string => `Bearer ${token}`;

/** Lets the background calls handed to `waitUntil` so far settle. */
export async function drain(background: Promise<unknown>[]): Promise<void> {
  await Promise.all(background.splice(0));
}

/**
 * Also fakes the timers each call's owner uses to mark it alive, so no mark ever lands: every
 * pending call then looks like one whose request was cancelled, once 1 s passes on the clock.
 */
export function freezeHeartbeats(): void {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: Date.now() });
}

/** Fakes every timer the library uses, so `vi.advanceTimersByTimeAsync` drives its polling too. */
export function fakeAllTimers(): void {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    now: Date.now(),
  });
}
