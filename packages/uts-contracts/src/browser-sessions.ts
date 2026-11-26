import { z } from 'zod';
import { UTS_MAX_TOKENS_PER_CALL, UtsScopeSchema } from './token';
import { IssuedTokenSchema } from './oauth';

/**
 * The web BFF's browser-session API (design 5.1, 5.3 and 5.5). The BFF is the confidential
 * first-party client `kilo-web`: every call authenticates with a private-key JWT (RFC 7523,
 * `private_key_jwt`) signed with Ed25519 under one of the at most two public keys in the UTS var
 * `KILO_WEB_CLIENT_JWKS`, and names the browser session by the opaque `session_handle` the code
 * exchange returned. The app keeps the handle in an HTTP-only cookie; UTS keeps only its SHA-256.
 * A stolen handle is useless without the client key, and the key is useless without a handle.
 *
 * Every request is a form POST (`application/x-www-form-urlencoded`) with `client_assertion_type`
 * and `client_assertion`; the assertion's `aud` is the exact URL of the endpoint called, its
 * `iss` and `sub` are `kilo-web`, it lives at most 300 seconds and its `jti` is accepted once.
 * Every response is `Cache-Control: no-store`. Errors use the RFC 6749 JSON shape, and only 429
 * and 503 carry `Retry-After`; a client retries only those.
 */

/** `POST <issuer>/account/browser-sessions/read`: the live session a handle names. */
export const UTS_BROWSER_SESSION_READ_PATH = '/account/browser-sessions/read';
/** `POST <issuer>/account/browser-sessions/token`: one access token from the session. */
export const UTS_BROWSER_SESSION_TOKEN_PATH = '/account/browser-sessions/token';
/** `POST <issuer>/account/browser-sessions/end`: ends this browser session only. */
export const UTS_BROWSER_SESSION_END_PATH = '/account/browser-sessions/end';
/** `POST <issuer>/account/browser-sessions/end-all`: ends every browser session of the subject. */
export const UTS_BROWSER_SESSION_END_ALL_PATH = '/account/browser-sessions/end-all';
/** `POST <issuer>/account/devices/revoke`: ends one CLI or mobile grant of the subject. */
export const UTS_DEVICE_REVOKE_PATH = '/account/devices/revoke';

/** RFC 7523 section 2.2: the `client_assertion_type` of a private-key JWT. */
export const UTS_CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** A `kilo-web` key id: the prefix and the RFC 7638 SHA-256 thumbprint of the public key. */
export const KILO_WEB_KID_PREFIX = 'kilo-web-';
/** UTS holds at most two `kilo-web` public keys, so a rotation has no gap. */
export const KILO_WEB_CLIENT_MAX_KEYS = 2;
/** A client assertion lives at most this long (`exp - iat`). */
export const KILO_WEB_ASSERTION_MAX_LIFETIME_SECONDS = 300;

/** The `typ` header of the legacy bridge's subject token. */
export const KILO_LEGACY_SESSION_TOKEN_TYP = 'kilo-legacy-session+jwt';
/** The legacy bridge's subject token lives at most this long (`exp - iat`). */
export const KILO_LEGACY_SESSION_MAX_LIFETIME_SECONDS = 60;
/** RFC 8693 section 3: the `subject_token_type` of the legacy bridge (a JWT). */
export const UTS_JWT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt';
/** RFC 8693 section 3: the `issued_token_type` of the legacy bridge (an access token). */
export const UTS_ACCESS_TOKEN_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

/** The sign-in method of a session the legacy bridge created; never a fresh sign-in. */
export const LEGACY_SESSION_AMR = 'legacy_session';

const Base64urlKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** One public half of a `kilo-web` signing key, as `KILO_WEB_CLIENT_JWKS` lists it. */
export const KiloWebPublicJwkSchema = z.strictObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  alg: z.literal('EdDSA'),
  use: z.literal('sig'),
  kid: z.string().regex(/^kilo-web-[A-Za-z0-9_-]{43}$/),
  x: Base64urlKey,
});
export type KiloWebPublicJwk = z.infer<typeof KiloWebPublicJwkSchema>;

/** The value of the UTS var `KILO_WEB_CLIENT_JWKS`: one or two public keys, distinct kids. */
export const KiloWebClientJwksSchema = z
  .strictObject({ keys: z.array(KiloWebPublicJwkSchema).min(1).max(KILO_WEB_CLIENT_MAX_KEYS) })
  .refine(
    jwks => new Set(jwks.keys.map(key => key.kid)).size === jwks.keys.length,
    'each kid appears once'
  );
export type KiloWebClientJwks = z.infer<typeof KiloWebClientJwksSchema>;

/** The opaque browser-session handle: 32 bytes in base64url. */
export const SessionHandleSchema = Base64urlKey;

const EpochSeconds = z.number().int().positive();
const LowercaseUuid = z.uuid().regex(/^[0-9a-f-]{36}$/);

/**
 * The session fields of a code exchange, a legacy bridge exchange and a `read`. `subject` is the
 * account id and every access token's `sub`. `auth_time` is the last sign-in or step-up;
 * `issued_at` is when the current handle was issued (a sign-in, a step-up or a bridge) and never
 * moves on `read` or `token`. `sso_connection` and `sso_organization` are the WorkOS ids of a
 * verified SSO profile, present only when `amr` includes `sso`.
 */
const SessionShape = {
  session_id: LowercaseUuid,
  subject: z.string().min(1).max(255),
  auth_time: EpochSeconds,
  amr: z.array(z.string().min(1)).min(1).max(8),
  sso_connection: z.string().min(1).max(255).optional(),
  sso_organization: z.string().min(1).max(255).optional(),
  issued_at: EpochSeconds,
  idle_expires_at: EpochSeconds,
  expires_at: EpochSeconds,
};

type SsoFields = { amr: string[]; sso_connection?: string; sso_organization?: string };
const ssoOnlyWithSso = (fields: SsoFields) =>
  fields.amr.includes('sso') ||
  (fields.sso_connection === undefined && fields.sso_organization === undefined);
const SSO_RULE = 'sso_connection and sso_organization appear only when amr includes sso';

/**
 * The `kilo-web` code exchange's answer: the token response (no refresh members; `issued_tokens`
 * lists every token and the RFC 6749 members describe the first) plus the browser session. A retry
 * with the same code, redirect URI and PKCE verifier inside the code's lifetime gets the same
 * `session_id` and `session_handle` and new access tokens.
 */
export const BrowserSessionGrantSchema = z
  .strictObject({
    access_token: z.string().min(1),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive(),
    scope: UtsScopeSchema,
    issued_tokens: z.array(IssuedTokenSchema).min(1).max(UTS_MAX_TOKENS_PER_CALL),
    session_handle: SessionHandleSchema,
    ...SessionShape,
  })
  .refine(ssoOnlyWithSso, SSO_RULE);
export type BrowserSessionGrant = z.infer<typeof BrowserSessionGrantSchema>;

/** The legacy bridge's answer (RFC 8693 section 2.2.1): the grant plus `issued_token_type`. */
export const LegacyBridgeGrantSchema = z
  .strictObject({
    access_token: z.string().min(1),
    issued_token_type: z.literal(UTS_ACCESS_TOKEN_TOKEN_TYPE),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive(),
    scope: UtsScopeSchema,
    issued_tokens: z.array(IssuedTokenSchema).min(1).max(UTS_MAX_TOKENS_PER_CALL),
    session_handle: SessionHandleSchema,
    ...SessionShape,
  })
  .refine(ssoOnlyWithSso, SSO_RULE);
export type LegacyBridgeGrant = z.infer<typeof LegacyBridgeGrantSchema>;

/** `read` (200): only a live session; any other handle answers 401 `invalid_session`. */
export const BrowserSessionReadSchema = z
  .strictObject({ status: z.literal('active'), ...SessionShape })
  .refine(ssoOnlyWithSso, SSO_RULE);
export type BrowserSessionRead = z.infer<typeof BrowserSessionReadSchema>;

/** `token` (200): one access token for one scope, no refresh members. */
export const BrowserSessionTokenSchema = z.strictObject({
  access_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  scope: UtsScopeSchema,
});
export type BrowserSessionToken = z.infer<typeof BrowserSessionTokenSchema>;

/**
 * `end` (200): `session_id` only on the call that ended the session; a repeat, or a handle that
 * was ended or never existed, answers without it. Both are authoritative.
 */
export const BrowserSessionEndSchema = z.strictObject({
  status: z.literal('ended'),
  session_id: LowercaseUuid.optional(),
});
export type BrowserSessionEnd = z.infer<typeof BrowserSessionEndSchema>;

/** `end-all` (200): how many browser sessions this call ended; 0 for a repeat or a dead handle. */
export const BrowserSessionEndAllSchema = z.strictObject({
  status: z.literal('ended'),
  ended: z.number().int().nonnegative(),
});
export type BrowserSessionEndAll = z.infer<typeof BrowserSessionEndAllSchema>;

/** `devices/revoke` (200): the same answer whether or not the `sid` was the caller's own. */
export const DeviceRevokeSchema = z.strictObject({ status: z.literal('ended') });
export type DeviceRevoke = z.infer<typeof DeviceRevokeSchema>;
