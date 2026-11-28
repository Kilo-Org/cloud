import {
  UTS_ENDPOINTS,
  type UtsEnvironment,
  type UtsPublicJwk,
  type UtsScopeEntry as UtsRegistryEntry,
} from '@kilocode/uts-contracts';
import type { UtsFeedBinding } from './index';

/**
 * A local UTS for tests: real Ed25519 keys, signed access tokens, a signed revocation head and its
 * list, served through the `FeedReader` entrypoint's answer shapes. Nothing here bypasses a check:
 * `@kilocode/verify` verifies every token, key set, head and list the fixture serves.
 */

/** A subject whose tokens issued before the far future are revoked (`revoked_before`). */
export const FIXTURE_REVOKED_SUBJECT = 'uts-fixture-revoked-subject';
/** A subject in `blocked_accounts`. */
export const FIXTURE_BLOCKED_SUBJECT = 'uts-fixture-blocked-subject';
/** A session id in `revoked_sids`. */
export const FIXTURE_REVOKED_SESSION = 'uts-fixture-revoked-session';
/** The session id tokens carry unless a test names another. */
export const FIXTURE_SESSION = 'uts-fixture-live-session';
/** The client id tokens carry unless a test names another. */
export const FIXTURE_CLIENT = 'kilo-cli';

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type SigningKey = { kid: string; privateKey: CryptoKey; publicJwk: UtsPublicJwk };

/**
 * A fresh Ed25519 key. The public key is published in phase 3's exact key-set member shape:
 * runtimes differ in what `exportKey('jwk')` adds (Node 24 adds `alg: "Ed25519"`, `key_ops`,
 * `ext`), and a verifier must see the key as UTS publishes it.
 */
async function signingKey(kidPrefix: string): Promise<SigningKey> {
  // Workerd's typings return `CryptoKey | CryptoKeyPair` for every algorithm; Ed25519 gives a pair.
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  if (!('privateKey' in pair)) throw new Error('Ed25519 key generation returned no key pair');
  // Workerd's typings return `ArrayBuffer | JsonWebKey` for every format; a JWK export has `x`.
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  if (!('x' in exported) || typeof exported.x !== 'string') {
    throw new Error('Ed25519 public key exported without x');
  }
  const kid = `${kidPrefix}${exported.x}`;
  return {
    kid,
    privateKey: pair.privateKey,
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: exported.x, kid, alg: 'EdDSA', use: 'sig' },
  };
}

async function signJws(key: SigningKey, header: object, payload: object): Promise<string> {
  const input = [{ ...header, kid: key.kid }, payload]
    .map(part => base64Url(encoder.encode(JSON.stringify(part))))
    .join('.');
  const signature = await crypto.subtle.sign('Ed25519', key.privateKey, encoder.encode(input));
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

/** Claims a test may set; every other claim gets a valid default. `undefined` drops a claim. */
export type FixtureClaims = {
  aud: string;
  scope: string;
  sub?: string;
  client_id?: string;
  sid?: string | undefined;
  org?: string | undefined;
  act?: { sub: string; client_id?: string } | undefined;
  iat?: number;
  exp?: number;
  iss?: string;
  /** `true` only on a bot token, which UTS mints without `sid` (`bot-token.ts`). */
  bot_user?: true;
  /** Defaults to the fixture's environment, the one `env` claim its verifier accepts. */
  env?: string | undefined;
};

export type UtsFixture = {
  environment: UtsEnvironment;
  issuer: string;
  /** A `FeedReader` binding serving this fixture's key set, head and list. */
  feed: UtsFeedBinding;
  /** Calls answered by `feed`, by method. */
  calls: { head: number; list: number; bootstrap: number; jwks: number };
  /** While false, every `feed` method answers `unavailable`, as the feed Worker does on failure. */
  setAvailable(available: boolean): void;
  /** A UTS access token signed with the fixture's token key. */
  mint(claims: FixtureClaims): Promise<string>;
  /** The same token, signed with a key the key set does not hold. */
  mintWithUnknownKey(claims: FixtureClaims): Promise<string>;
};

/**
 * A fixture for `environment` (development by default: issuer `http://localhost:8800`). Each call
 * makes new keys, so tests that need a cold verifier create a new gate and fixture together.
 */
export async function createUtsFixture(
  environment: UtsEnvironment = 'development'
): Promise<UtsFixture> {
  const issuer = UTS_ENDPOINTS[environment].issuer;
  const tokenKey = await signingKey('uts-token-00-');
  const unknownKey = await signingKey('uts-token-01-');
  const feedKey = await signingKey('uts-feed-0-');
  const jwks = {
    keys: [tokenKey, feedKey].map(key => key.publicJwk),
  };
  const list = encoder.encode(
    JSON.stringify({
      revoked_before: { [FIXTURE_REVOKED_SUBJECT]: 4_000_000_000 },
      revoked_sids: [FIXTURE_REVOKED_SESSION],
      revoked_kids: [],
      revoked_pat_ids: [],
      blocked_accounts: [FIXTURE_BLOCKED_SUBJECT],
    })
  );
  const listHash = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', list)));
  const keyAges = { newest: 0, oldest: 0 };
  const calls = { head: 0, list: 0, bootstrap: 0, jwks: 0 };
  let available = true;
  const unavailable = { status: 'unavailable', retryAfterSeconds: 5 } as const;

  const head = () =>
    signJws(
      feedKey,
      { alg: 'EdDSA', typ: 'kilo-feed-head+jwt' },
      { iat: Math.floor(Date.now() / 1000), list_hash: listHash }
    );

  const feed: UtsFeedBinding = {
    async head() {
      calls.head++;
      return available ? { status: 'ok', head: await head() } : unavailable;
    },
    async list(hash: string) {
      calls.list++;
      if (!available) return unavailable;
      return hash === listHash ? { status: 'ok', list: list.slice() } : { status: 'not_found' };
    },
    async bootstrap() {
      calls.bootstrap++;
      if (!available) return unavailable;
      return { status: 'ok', jwks, keyAges, head: await head(), list: list.slice() };
    },
    async jwks() {
      calls.jwks++;
      return available ? { status: 'ok', jwks, keyAges } : unavailable;
    },
  };

  function payload(claims: FixtureClaims): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    const full: Record<string, unknown> = {
      iss: issuer,
      sub: 'uts-fixture-user',
      client_id: FIXTURE_CLIENT,
      jti: crypto.randomUUID(),
      iat: now,
      exp: now + 600,
      env: environment,
      sid: FIXTURE_SESSION,
      ...claims,
    };
    for (const [name, value] of Object.entries(full)) if (value === undefined) delete full[name];
    return full;
  }

  const header = { alg: 'EdDSA', typ: 'at+jwt' };
  return {
    environment,
    issuer,
    feed,
    calls,
    setAvailable(value) {
      available = value;
    },
    mint: claims => signJws(tokenKey, header, payload(claims)),
    mintWithUnknownKey: claims => signJws(unknownKey, header, payload(claims)),
  };
}

/**
 * A scope registry holding `scopes`, each a first-party grant scope that is session-bound, not
 * PAT-eligible and not delegable, in the shape of the phase 3 registry entries, so a gate under
 * test controls its allowed clients and organization binding.
 */
export function fixtureScopeRegistry(
  scopes: Readonly<Record<string, { allowedClients: readonly string[]; orgMember?: boolean }>>
): (scope: string) => UtsRegistryEntry | null {
  return scope => {
    const entry = Object.hasOwn(scopes, scope) ? scopes[scope] : undefined;
    if (entry === undefined) return null;
    const orgMember = entry.orgMember === true;
    return {
      audience: scope.slice(0, scope.indexOf(':')),
      maxLifetimeSeconds: 600,
      allowedClients: entry.allowedClients,
      subjects: orgMember ? { kind: 'org_member', roles: 'any' } : { kind: 'any_user' },
      thirdPartySafe: false,
      stepUp: false,
      patEligible: false,
      privileged: false,
      requiresSession: true,
      requiresOrgClaim: orgMember,
      delegable: false,
      issuance: 'grant',
      delegatesTo: [],
      consentText: null,
    };
  };
}
