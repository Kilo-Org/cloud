import { Buffer } from 'node:buffer';
import {
  type JWTPayload,
  type JWTVerifyGetKey,
  SignJWT,
  createRemoteJWKSet,
  errors,
  importPKCS8,
  jwtVerify,
} from 'jose';
import { z } from 'zod';
import type { ClientCredentials } from './config';
import type { DiscordSpec, GitHubSpec, OidcSpec, ProviderSpec } from './specs';
import type { ProviderIdentity } from './store';

/**
 * The provider side of a sign-in: the authorization request, the code exchange at the token
 * endpoint, and the identity check. Every outbound call ends within 10 seconds; the calls of one
 * callback run one after another (the token call, then the key set or the user reads), so a cold
 * isolate's OpenID Connect callback can wait up to 20 seconds. Nothing here logs or returns a
 * provider token; only the checked identity leaves.
 *
 * * OpenID Connect: the ID token from the token endpoint is verified against the provider's key
 *   set (signature, `iss`, `aud` = client id, `exp`, `iat`, and `nonce` = the flow's nonce).
 *   `createRemoteJWKSet` keeps each key set in the isolate for 10 minutes (`cacheMaxAge`) and
 *   refetches it on an unknown `kid` at most once per 30 seconds (`cooldownDuration`), so an
 *   isolate fetches a provider's key set at most once per 10 minutes plus those refetches, and
 *   never more than once per callback.
 * * GitHub has no OpenID Connect: the access token reads `/user` and `/user/emails`, and only the
 *   primary address counts.
 * * Discord: the access token reads the user object.
 */

const CALL_TIMEOUT_MS = 10_000;
const KEY_SET_CACHE_MS = 10 * 60 * 1000;
const KEY_SET_COOLDOWN_MS = 30 * 1000;
/** An Apple client secret or a Claude client assertion covers one request plus clock skew. */
const CLIENT_JWT_LIFETIME_SECONDS = 300;
const APPLE_AUDIENCE = 'https://appleid.apple.com';
/** GitHub's REST API refuses a request without a user agent. */
const GITHUB_USER_AGENT = 'kilo-uts';

export type FlowValues = { state: string; challenge: string; nonce: string };

/** The provider's authorization URL for one flow. */
export function authorizationUrl(
  spec: ProviderSpec,
  clientId: string,
  redirectUri: string,
  flow: FlowValues
): URL {
  const url = new URL(spec.endpoints.authorization);
  const params = url.searchParams;
  params.set('response_type', 'code');
  params.set('client_id', clientId);
  params.set('redirect_uri', redirectUri);
  params.set('scope', spec.scope);
  params.set('state', flow.state);
  if (spec.protocol !== 'oidc' || spec.pkce) {
    params.set('code_challenge', flow.challenge);
    params.set('code_challenge_method', 'S256');
  }
  if (spec.protocol === 'oidc') {
    params.set('nonce', flow.nonce);
    if (spec.responseMode === 'form_post') params.set('response_mode', 'form_post');
    if (spec.resource !== null) params.set('resource', spec.resource);
  }
  return url;
}

/**
 * Why the provider side failed. `retryable`: the provider did not answer, or answered 5xx, so the
 * same sign-in can succeed later. `refused`: the provider refused the code or sent an identity that
 * failed its checks; the user starts again.
 */
export type ProviderFailure = { kind: 'retryable' | 'refused'; reason: string };

export type IdentityResult =
  | { status: 'ok'; identity: ProviderIdentity }
  | { status: 'failed'; failure: ProviderFailure };

class ProviderError extends Error {
  override name = 'ProviderError';
  readonly failure: ProviderFailure;
  constructor(kind: ProviderFailure['kind'], reason: string) {
    super(reason);
    this.failure = { kind, reason };
  }
}

/** One outbound call; a network failure, a timeout or a 5xx is retryable. */
async function call(url: string, init: RequestInit, step: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch {
    throw new ProviderError('retryable', `${step}_unreachable`);
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status >= 500) throw new ProviderError('retryable', `${step}_${response.status}`);
  if (!response.ok) throw new ProviderError('refused', `${step}_${response.status}`);
  return body;
}

function parse<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  reason: string
): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProviderError('refused', reason);
  return parsed.data;
}

async function signClientJwt(
  pem: string,
  keyId: string,
  claims: { iss: string; sub: string; aud: string; jti?: string }
): Promise<string> {
  const key = await importPKCS8(pem.replaceAll('\\n', '\n'), 'ES256');
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT(claims.jti === undefined ? {} : { jti: claims.jti })
    .setProtectedHeader({ alg: 'ES256', kid: keyId, typ: 'JWT' })
    .setIssuer(claims.iss)
    .setSubject(claims.sub)
    .setAudience(claims.aud)
    .setIssuedAt(now)
    .setExpirationTime(now + CLIENT_JWT_LIFETIME_SECONDS);
  return await jwt.sign(key);
}

/** A form POST to the token endpoint with the client authentication the provider expects. */
async function tokenRequest(
  endpoint: string,
  spec: ProviderSpec,
  credentials: ClientCredentials,
  fields: Record<string, string>
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const method = spec.protocol === 'oidc' ? spec.clientAuth : 'client_secret_post';
  if (method === 'private_key_jwt_json') {
    if (credentials.kind !== 'assertion') throw new ProviderError('refused', 'credentials_kind');
    const assertion = await signClientJwt(credentials.privateKeyPem, credentials.keyId, {
      iss: credentials.issuer,
      sub: credentials.subject,
      aud: credentials.audience,
      // The provider accepts an assertion with a given `jti` once.
      jti: crypto.randomUUID(),
    });
    return await call(
      endpoint,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...fields,
          client_id: credentials.clientId,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: assertion,
        }),
      },
      'token'
    );
  }
  const body = new URLSearchParams(fields);
  if (method === 'apple_client_secret') {
    if (credentials.kind !== 'apple') throw new ProviderError('refused', 'credentials_kind');
    body.set('client_id', credentials.clientId);
    body.set(
      'client_secret',
      await signClientJwt(credentials.privateKeyPem, credentials.keyId, {
        iss: credentials.teamId,
        sub: credentials.clientId,
        aud: APPLE_AUDIENCE,
      })
    );
  } else {
    if (credentials.kind !== 'secret') throw new ProviderError('refused', 'credentials_kind');
    if (method === 'client_secret_basic') {
      // RFC 6749 section 2.3.1: both values form-encoded before the Basic encoding.
      const user = encodeURIComponent(credentials.clientId);
      const password = encodeURIComponent(credentials.clientSecret);
      headers.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    } else {
      body.set('client_id', credentials.clientId);
      body.set('client_secret', credentials.clientSecret);
    }
  }
  return await call(
    endpoint,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    'token'
  );
}

const EMAIL = /^[^@\s]+@[^@\s]+$/;

/** The address in the identity store's form (lower case, at most 320 characters), or null. */
export function normalizeEmail(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const email = value.trim().toLowerCase();
  return email.length <= 320 && EMAIL.test(email) ? email : null;
}

const keySets = new Map<string, JWTVerifyGetKey>();

function keySet(jwksUri: string): JWTVerifyGetKey {
  let keys = keySets.get(jwksUri);
  if (keys === undefined) {
    keys = createRemoteJWKSet(new URL(jwksUri), {
      timeoutDuration: CALL_TIMEOUT_MS,
      cacheMaxAge: KEY_SET_CACHE_MS,
      cooldownDuration: KEY_SET_COOLDOWN_MS,
    });
    keySets.set(jwksUri, keys);
  }
  return keys;
}

const IdTokenClaimsSchema = z.looseObject({
  sub: z.string().min(1).max(512),
  nonce: z.string(),
  email: z.string().optional(),
  email_verified: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
  hd: z.string().min(1).optional(),
});

async function verifyIdToken(
  spec: OidcSpec,
  clientId: string,
  idToken: string
): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(idToken, keySet(spec.endpoints.jwks), {
      issuer: [...spec.endpoints.issuers],
      audience: clientId,
      algorithms: [...spec.idTokenAlgorithms],
      requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
      clockTolerance: 60,
    });
    return payload;
  } catch (error) {
    if (error instanceof errors.JWKSTimeout) throw new ProviderError('retryable', 'jwks_timeout');
    if (error instanceof errors.JOSEError)
      throw new ProviderError('refused', `id_token_${error.code}`);
    // createRemoteJWKSet rethrows a failed key-set fetch as it came.
    throw new ProviderError('retryable', 'jwks_unreachable');
  }
}

/** Whether the ID token proves control of `email` (src/signin/providers/specs.ts). */
export function oidcEmailProven(
  spec: Pick<OidcSpec, 'emailProof'>,
  claims: z.output<typeof IdTokenClaimsSchema>,
  email: string | null
): boolean {
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  if (email === null || !verified) return false;
  if (spec.emailProof === 'google') return email.endsWith('@gmail.com') || claims.hd !== undefined;
  return true;
}

const OidcTokenSchema = z.looseObject({ id_token: z.string().min(1) });

async function oidcIdentity(
  spec: OidcSpec,
  credentials: ClientCredentials,
  code: string,
  redirectUri: string,
  verifier: string,
  nonce: string
): Promise<ProviderIdentity> {
  const fields: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  };
  if (spec.pkce) fields.code_verifier = verifier;
  if (spec.resource !== null) fields.resource = spec.resource;
  const tokens = parse(
    OidcTokenSchema,
    await tokenRequest(spec.endpoints.token, spec, credentials, fields),
    'token_response'
  );
  const payload = await verifyIdToken(spec, credentials.clientId, tokens.id_token);
  const claims = parse(IdTokenClaimsSchema, payload, 'id_token_claims');
  if (claims.nonce !== nonce) throw new ProviderError('refused', 'id_token_nonce');
  const email = normalizeEmail(claims.email);
  return {
    subject: claims.sub,
    email,
    emailProven: oidcEmailProven(spec, claims, email),
    workosConnectionId: null,
    workosOrganizationId: null,
  };
}

const AccessTokenSchema = z.looseObject({ access_token: z.string().min(1) });
const GitHubUserSchema = z.looseObject({ id: z.number().int().positive() });
const GitHubEmailsSchema = z.array(
  z.looseObject({ email: z.string(), verified: z.boolean(), primary: z.boolean() })
);

async function githubIdentity(
  spec: GitHubSpec,
  credentials: ClientCredentials,
  code: string,
  redirectUri: string,
  verifier: string
): Promise<ProviderIdentity> {
  // GitHub answers a refused code with 200 and an `error` member, which this parse refuses.
  const { access_token: accessToken } = parse(
    AccessTokenSchema,
    await tokenRequest(spec.endpoints.token, spec, credentials, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
    'token_response'
  );
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': GITHUB_USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const [user, emails] = await Promise.all([
    call(`${spec.endpoints.api}/user`, { headers }, 'user'),
    call(`${spec.endpoints.api}/user/emails`, { headers }, 'emails'),
  ]);
  const primary = parse(GitHubEmailsSchema, emails, 'emails_response').find(entry => entry.primary);
  const email = normalizeEmail(primary?.email);
  return {
    subject: String(parse(GitHubUserSchema, user, 'user_response').id),
    email,
    emailProven: email !== null && primary?.verified === true,
    workosConnectionId: null,
    workosOrganizationId: null,
  };
}

const DiscordUserSchema = z.looseObject({
  id: z.string().regex(/^\d{1,32}$/),
  email: z.string().nullable().optional(),
  verified: z.boolean().optional(),
});

async function discordIdentity(
  spec: DiscordSpec,
  credentials: ClientCredentials,
  code: string,
  redirectUri: string,
  verifier: string
): Promise<ProviderIdentity> {
  const { access_token: accessToken } = parse(
    AccessTokenSchema,
    await tokenRequest(spec.endpoints.token, spec, credentials, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
    'token_response'
  );
  const user = parse(
    DiscordUserSchema,
    await call(
      spec.endpoints.user,
      { headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` } },
      'user'
    ),
    'user_response'
  );
  const email = normalizeEmail(user.email);
  return {
    subject: user.id,
    email,
    emailProven: email !== null && user.verified === true,
    workosConnectionId: null,
    workosOrganizationId: null,
  };
}

/** The checked identity of a provider callback's code. */
export async function providerIdentity(
  spec: ProviderSpec,
  credentials: ClientCredentials,
  callback: { code: string; redirectUri: string; verifier: string; nonce: string }
): Promise<IdentityResult> {
  try {
    const { code, redirectUri, verifier, nonce } = callback;
    const identity =
      spec.protocol === 'oidc'
        ? await oidcIdentity(spec, credentials, code, redirectUri, verifier, nonce)
        : spec.protocol === 'github'
          ? await githubIdentity(spec, credentials, code, redirectUri, verifier)
          : await discordIdentity(spec, credentials, code, redirectUri, verifier);
    return { status: 'ok', identity };
  } catch (error) {
    if (error instanceof ProviderError) return { status: 'failed', failure: error.failure };
    throw error;
  }
}

const WorkosProfileSchema = z.looseObject({
  profile: z.looseObject({
    id: z.string().min(1).max(512),
    connection_id: z.string().min(1).max(255),
    // WorkOS answers null for a connection that belongs to no organization.
    organization_id: z.string().min(1).max(255).nullable().optional(),
    email: z.string(),
  }),
});

/**
 * WorkOS SSO: the code buys the profile in one call, authenticated by the API key
 * (https://workos.com/docs/reference/sso/profile/get-profile-and-token). The profile's connection
 * is checked against the flow's by the identity store.
 */
export async function workosIdentity(
  endpoint: string,
  clientId: string,
  apiKey: string,
  code: string
): Promise<IdentityResult> {
  try {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: apiKey,
      grant_type: 'authorization_code',
      code,
    });
    const { profile } = parse(
      WorkosProfileSchema,
      await call(
        endpoint,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
        },
        'token'
      ),
      'profile_response'
    );
    return {
      status: 'ok',
      identity: {
        subject: profile.id,
        email: normalizeEmail(profile.email),
        // An SSO sign-in never links by email (design 5.2); its domain is checked instead.
        emailProven: false,
        workosConnectionId: profile.connection_id,
        workosOrganizationId: profile.organization_id ?? null,
      },
    };
  } catch (error) {
    if (error instanceof ProviderError) return { status: 'failed', failure: error.failure };
    throw error;
  }
}
