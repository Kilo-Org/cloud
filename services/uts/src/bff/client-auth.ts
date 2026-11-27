import {
  KILO_BRIDGE_KID_PREFIX,
  KILO_LEGACY_SESSION_MAX_LIFETIME_SECONDS,
  KILO_LEGACY_SESSION_TOKEN_TYP,
  KILO_WEB_ASSERTION_MAX_LIFETIME_SECONDS,
  KILO_WEB_CLIENT_ID,
  KILO_WEB_KID_PREFIX,
  KiloBridgeJwksSchema,
  KiloWebClientJwksSchema,
  UTS_CLIENT_ASSERTION_TYPE,
} from '@kilocode/uts-contracts';
import { Buffer } from 'node:buffer';
import { calculateJwkThumbprint, decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import { z } from 'zod';
import type { Env } from '../env';
import type { Params } from '../oauth/params';

/**
 * `kilo-web` client authentication (design 5.1; RFC 7523 section 2.2, `private_key_jwt`): a JWT
 * signed with Ed25519 under a key whose public half the UTS var `KILO_WEB_CLIENT_JWKS` lists (one
 * or two keys, so a rotation has no gap). The assertion's `iss` and `sub` are `kilo-web`, its
 * `aud` is the exact URL of the endpoint called and nothing else, it lives at most 300 seconds,
 * and the statement it authorizes records its `jti` under the key's RFC 7638 thumbprint, so it is
 * accepted once. The legacy bridge's subject token, which vouches for a legacy session of any app
 * user, is a JWT with its own `typ` under a key of its own (`KILO_WEB_BRIDGE_JWKS`, kid prefix
 * `kilo-bridge-`), never a client key: a JWT of one kind is never accepted as the other, and the
 * bridge serves nothing while its key set shares a key with the client's.
 */

/** Clock skew the checks allow, as the verifier library does (design 7). */
export const CLIENT_ASSERTION_SKEW_SECONDS = 60;

/** One `kilo-web` public key, imported, with its thumbprint as the 32 bytes a jti row stores. */
type ClientKey = { key: CryptoKey; jkt: Uint8Array };

/** The `kilo-web` keys by `kid`. */
export type ClientKeys = ReadonlyMap<string, ClientKey>;

/**
 * `unconfigured`: the var is not set, so `kilo-web` (or the legacy bridge) is not served.
 * `misconfigured`: the var is set but is not one or two well-formed keys whose `kid` is the
 * expected prefix and the key's thumbprint, or a bridge key is also a client key; nothing is
 * served either, and the failure is logged. Both answer 503, never 500.
 */
export type WebClientKeys =
  | { status: 'unconfigured' }
  | { status: 'misconfigured' }
  | { status: 'ready'; keys: ClientKeys };

type ParsedKeys = { raw: string; keys: Promise<WebClientKeys> } | null;
/** The keys of the last value of each var this isolate parsed: one value per Worker version. */
let parsedClient: ParsedKeys = null;
let parsedBridge: ParsedKeys = null;

async function parseKeys(
  raw: string,
  schema: typeof KiloWebClientJwksSchema | typeof KiloBridgeJwksSchema,
  kidPrefix: string,
  logPrefix: string
): Promise<WebClientKeys> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = null;
  }
  const jwks = schema.safeParse(value);
  if (!jwks.success) {
    console.error(JSON.stringify({ event: `${logPrefix}.jwks_invalid` }));
    return { status: 'misconfigured' };
  }
  const keys = new Map<string, ClientKey>();
  for (const jwk of jwks.data.keys) {
    const thumbprint = await calculateJwkThumbprint({ kty: jwk.kty, crv: jwk.crv, x: jwk.x });
    if (jwk.kid !== `${kidPrefix}${thumbprint}`) {
      console.error(JSON.stringify({ event: `${logPrefix}.kid_mismatch`, kid: jwk.kid }));
      return { status: 'misconfigured' };
    }
    const key = await importJWK(jwk, 'EdDSA');
    if (!(key instanceof CryptoKey)) return { status: 'misconfigured' };
    keys.set(jwk.kid, { key, jkt: new Uint8Array(Buffer.from(thumbprint, 'base64url')) });
  }
  return { status: 'ready', keys };
}

/** The `kilo-web` public keys of this Worker's `KILO_WEB_CLIENT_JWKS`. */
export async function webClientKeys(
  env: Pick<Env, 'KILO_WEB_CLIENT_JWKS'>
): Promise<WebClientKeys> {
  const raw = env.KILO_WEB_CLIENT_JWKS;
  if (raw === undefined || raw === '') return { status: 'unconfigured' };
  if (parsedClient === null || parsedClient.raw !== raw) {
    parsedClient = {
      raw,
      keys: parseKeys(raw, KiloWebClientJwksSchema, KILO_WEB_KID_PREFIX, 'uts.kilo_web'),
    };
  }
  return await parsedClient.keys;
}

/**
 * The legacy bridge's public keys (`KILO_WEB_BRIDGE_JWKS`). A bridge key that is also a
 * `KILO_WEB_CLIENT_JWKS` key (the same thumbprint under another kid) makes the set
 * `misconfigured`, logged as `uts.legacy_bridge.key_reused`.
 */
export async function legacyBridgeKeys(
  env: Pick<Env, 'KILO_WEB_BRIDGE_JWKS' | 'KILO_WEB_CLIENT_JWKS'>
): Promise<WebClientKeys> {
  const raw = env.KILO_WEB_BRIDGE_JWKS;
  if (raw === undefined || raw === '') return { status: 'unconfigured' };
  if (parsedBridge === null || parsedBridge.raw !== raw) {
    parsedBridge = {
      raw,
      keys: parseKeys(raw, KiloBridgeJwksSchema, KILO_BRIDGE_KID_PREFIX, 'uts.legacy_bridge'),
    };
  }
  const bridge = await parsedBridge.keys;
  const client = await webClientKeys(env);
  if (bridge.status !== 'ready' || client.status !== 'ready') return bridge;
  const clientKeys = new Set(
    [...client.keys.values()].map(key => Buffer.from(key.jkt).toString('base64url'))
  );
  for (const key of bridge.keys.values()) {
    if (clientKeys.has(Buffer.from(key.jkt).toString('base64url'))) {
      console.error(JSON.stringify({ event: 'uts.legacy_bridge.key_reused' }));
      return { status: 'misconfigured' };
    }
  }
  return bridge;
}

/** A verified JWT's single-use id: the statement records `jti` under `jkt` until `expiresAt`. */
export type JtiUse = { jkt: Uint8Array; jti: string; expiresAt: Date };

const HeaderSchema = z.strictObject({
  alg: z.literal('EdDSA'),
  kid: z.string().min(1).max(128),
  typ: z.string().optional(),
});

/** A `jti` the statement can store: 16 to 128 URL-safe characters. */
const JtiSchema = z.string().regex(/^[A-Za-z0-9._~-]{16,128}$/);
const Seconds = z.number().int().positive();

type Verified = { claims: unknown; use: { jkt: Uint8Array; exp: number } };

/**
 * Verifies `jwt`'s signature, `iss`, `exp` and `nbf` under one of `keys` with the expected `typ`
 * (null: absent or `JWT`). The caller checks the other claims. Null for any failure.
 */
async function verifyJwt(
  jwt: string,
  keys: ClientKeys,
  typ: string | null,
  nowSeconds: number
): Promise<Verified | null> {
  let header;
  try {
    header = HeaderSchema.safeParse(decodeProtectedHeader(jwt));
  } catch {
    return null;
  }
  if (!header.success) return null;
  const headerTyp = header.data.typ;
  const typOk = typ === null ? headerTyp === undefined || headerTyp === 'JWT' : headerTyp === typ;
  const key = keys.get(header.data.kid);
  if (!typOk || key === undefined) return null;
  try {
    const { payload } = await jwtVerify(jwt, key.key, {
      algorithms: ['EdDSA'],
      issuer: KILO_WEB_CLIENT_ID,
      clockTolerance: CLIENT_ASSERTION_SKEW_SECONDS,
      currentDate: new Date(nowSeconds * 1000),
    });
    const exp = Seconds.safeParse(payload.exp);
    if (!exp.success) return null;
    return { claims: payload, use: { jkt: key.jkt, exp: exp.data } };
  } catch {
    return null;
  }
}

/** The time checks every `kilo-web` JWT passes: issued, not yet past, and short enough. */
function lifetimeOk(iat: number, exp: number, maxLifetime: number, nowSeconds: number): boolean {
  return (
    exp > iat &&
    exp - iat <= maxLifetime &&
    iat <= nowSeconds + CLIENT_ASSERTION_SKEW_SECONDS &&
    exp + CLIENT_ASSERTION_SKEW_SECONDS > nowSeconds
  );
}

/** A row stays until no clock accepts the JWT again. */
function jtiUse(verified: Verified, jti: string): JtiUse {
  return {
    jkt: verified.use.jkt,
    jti,
    expiresAt: new Date((verified.use.exp + CLIENT_ASSERTION_SKEW_SECONDS) * 1000),
  };
}

/**
 * The outcome of a request's client authentication: `absent` when it sends no assertion (the
 * caller then serves it as another client), `refused` with the 401 `invalid_client` reason,
 * `unavailable` when `kilo-web` is not configured here (503), or the assertion's single-use id.
 */
export type ClientAuthentication =
  | { status: 'absent' }
  | { status: 'refused' }
  | { status: 'unavailable' }
  | { status: 'authenticated'; assertion: JtiUse };

/**
 * Checks a request's `kilo-web` client assertion for the endpoint `audience`. A `client_id`, when
 * sent, must be `kilo-web` (RFC 7523 section 3). A repeated or partial assertion is refused.
 */
export async function authenticateWebClient(
  params: Params,
  keys: WebClientKeys,
  audience: string,
  nowSeconds: number
): Promise<ClientAuthentication> {
  const type = params.one('client_assertion_type');
  const assertion = params.one('client_assertion');
  if (type.status === 'absent' && assertion.status === 'absent') return { status: 'absent' };
  if (keys.status !== 'ready') return { status: 'unavailable' };
  const clientId = params.one('client_id');
  if (
    type.status !== 'present' ||
    type.value !== UTS_CLIENT_ASSERTION_TYPE ||
    assertion.status !== 'present' ||
    clientId.status === 'repeated' ||
    (clientId.status === 'present' && clientId.value !== KILO_WEB_CLIENT_ID)
  ) {
    return { status: 'refused' };
  }
  const verified = await verifyJwt(assertion.value, keys.keys, null, nowSeconds);
  if (verified === null) return { status: 'refused' };
  const claims = z
    .looseObject({
      iss: z.literal(KILO_WEB_CLIENT_ID),
      sub: z.literal(KILO_WEB_CLIENT_ID),
      aud: z.literal(audience),
      iat: Seconds,
      exp: Seconds,
      jti: JtiSchema,
    })
    .safeParse(verified.claims);
  if (
    !claims.success ||
    !lifetimeOk(
      claims.data.iat,
      claims.data.exp,
      KILO_WEB_ASSERTION_MAX_LIFETIME_SECONDS,
      nowSeconds
    )
  ) {
    return { status: 'refused' };
  }
  return { status: 'authenticated', assertion: jtiUse(verified, claims.data.jti) };
}

/** What the web app vouches for in a legacy bridge subject token, checked and typed. */
export type LegacySessionClaims = {
  /** The existing app user id, which is the imported account's id. */
  subject: string;
  /** The legacy session's sign-in time, in seconds. */
  authTime: number;
  /** The WorkOS ids web verified server-side, before UTS checks them against its authority. */
  sso: { connection: string; organization: string | null } | null;
  use: JtiUse;
};

const LegacyClaimsSchema = z
  .looseObject({
    iss: z.literal(KILO_WEB_CLIENT_ID),
    sub: z.string().min(1).max(255),
    iat: Seconds,
    exp: Seconds,
    jti: JtiSchema,
    auth_time: Seconds,
    sso_connection: z.string().min(1).max(255).optional(),
    sso_organization: z.string().min(1).max(255).optional(),
  })
  .refine(
    claims => claims.sso_organization === undefined || claims.sso_connection !== undefined,
    'sso_organization comes with sso_connection'
  );

/**
 * Verifies the legacy bridge's subject token: `typ` `kilo-legacy-session+jwt`, signed by a
 * legacy bridge key (`legacyBridgeKeys`), `aud` the token endpoint, at most 60 seconds long, with
 * the app user id in `sub` and a legacy sign-in time not in the future. Null for any failure.
 */
export async function verifyLegacySessionToken(
  token: string,
  keys: ClientKeys,
  audience: string,
  nowSeconds: number
): Promise<LegacySessionClaims | null> {
  const verified = await verifyJwt(token, keys, KILO_LEGACY_SESSION_TOKEN_TYP, nowSeconds);
  if (verified === null) return null;
  const claims = LegacyClaimsSchema.safeParse(verified.claims);
  if (
    !claims.success ||
    !z.literal(audience).safeParse(claims.data.aud).success ||
    !lifetimeOk(
      claims.data.iat,
      claims.data.exp,
      KILO_LEGACY_SESSION_MAX_LIFETIME_SECONDS,
      nowSeconds
    ) ||
    claims.data.auth_time > nowSeconds + CLIENT_ASSERTION_SKEW_SECONDS
  ) {
    return null;
  }
  const { sso_connection: connection, sso_organization: organization } = claims.data;
  return {
    subject: claims.data.sub,
    authTime: claims.data.auth_time,
    sso: connection === undefined ? null : { connection, organization: organization ?? null },
    use: jtiUse(verified, claims.data.jti),
  };
}
