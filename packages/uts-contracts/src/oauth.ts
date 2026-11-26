import { z } from 'zod';
import { UTS_ENDPOINTS, type UtsEnvironment } from './environment';
import { KILO_API_AUDIENCE, UTS_ACCOUNT_AUDIENCE } from './scopes';
import { UTS_MAX_TOKENS_PER_CALL, UtsAudienceSchema, UtsScopeSchema } from './token';

/** Paths of the mint Worker's OAuth endpoints on the issuer origin (design 5.4). */
export const UTS_AUTHORIZE_PATH = '/authorize';
export const UTS_TOKEN_PATH = '/token';
export const UTS_REVOKE_PATH = '/revoke';
export const UTS_INTROSPECT_PATH = '/introspect';

export const UTS_GRANT_TYPES = {
  authorizationCode: 'authorization_code',
  refreshToken: 'refresh_token',
  deviceCode: 'urn:ietf:params:oauth:grant-type:device_code',
} as const;

/** The DPoP proof algorithms UTS accepts (RFC 9449): asymmetric only. */
export const UTS_DPOP_ALGORITHMS = ['EdDSA', 'ES256'] as const;

/**
 * RFC 8707 resource indicator of a Kilo service: `urn:kilo:service:<audience>`. A client names
 * the services it needs at the authorization endpoint; each becomes one token audience.
 */
export const UTS_RESOURCE_PREFIX = 'urn:kilo:service:';

export function resourceOfAudience(audience: string): string {
  return `${UTS_RESOURCE_PREFIX}${UtsAudienceSchema.parse(audience)}`;
}

/**
 * The Kilo API's resource in each environment: the canonical HTTPS origin of the web app, which its
 * RFC 9728 metadata names. Production and staging are the origins `resolveAppUrl` in
 * `packages/web-shared/src/lib/constants.ts` uses (see also `ENVIRONMENT.md`, `APP_URL_OVERRIDE`).
 * Development is the local web app on its default port (`PORT` unset), the loopback fixture of the
 * local end-to-end runs; staging and production never accept a loopback origin.
 */
export const KILO_API_RESOURCES: Readonly<Record<UtsEnvironment, string>> = {
  production: 'https://app.kilo.ai',
  staging: 'https://staging-app.kilo.ai',
  development: 'http://localhost:3000',
};

/**
 * The audience a resource indicator names in `environment`, or null when it names no Kilo service
 * there. Three forms, each an exact string: `urn:kilo:service:<audience>`; the environment's Kilo
 * API origin (`KILO_API_RESOURCES`) for `kilo-api`; and the environment's UTS issuer, the resource
 * of the account API, for `uts`. Another environment's origin, a path, a trailing slash or a query
 * names nothing.
 */
export function audienceOfResource(resource: string, environment: UtsEnvironment): string | null {
  if (resource === KILO_API_RESOURCES[environment]) return KILO_API_AUDIENCE;
  if (resource === UTS_ENDPOINTS[environment].issuer) return UTS_ACCOUNT_AUDIENCE;
  if (!resource.startsWith(UTS_RESOURCE_PREFIX)) return null;
  const audience = UtsAudienceSchema.safeParse(resource.slice(UTS_RESOURCE_PREFIX.length));
  return audience.success ? audience.data : null;
}

/** Error codes of RFC 6749 sections 4.1.2.1 and 5.2, RFC 7009, RFC 8707 and RFC 9449. */
export const OAUTH_ERROR_CODES = [
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'unsupported_response_type',
  'unsupported_token_type',
  'invalid_scope',
  'invalid_target',
  'invalid_dpop_proof',
  'access_denied',
  'server_error',
  'temporarily_unavailable',
] as const;
export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

export const OAuthErrorSchema = z.strictObject({
  error: z.enum(OAUTH_ERROR_CODES),
  error_description: z.string().optional(),
});
export type OAuthError = z.infer<typeof OAuthErrorSchema>;

/** One access token of a token response: one audience and one scope. */
export const IssuedTokenSchema = z.strictObject({
  access_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  audience: UtsAudienceSchema,
  scope: UtsScopeSchema,
});
export type IssuedToken = z.infer<typeof IssuedTokenSchema>;

/**
 * A token response (RFC 6749, section 5.1). One call mints one token per scope, up to 8:
 * `issued_tokens` lists every token, and the RFC 6749 members describe the first one, so a client
 * that asked for one scope reads the standard members only. Access tokens are bearer tokens; the
 * first-party refresh grant is the DPoP-bound credential. `refresh_token` is present when the call
 * created a grant or rotated a third-party token; a first-party refresh keeps its grant.
 */
export const TokenResponseSchema = z
  .strictObject({
    access_token: z.string().min(1),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive(),
    scope: UtsScopeSchema,
    issued_tokens: z.array(IssuedTokenSchema).min(1).max(UTS_MAX_TOKENS_PER_CALL),
    refresh_token: z.string().min(1).optional(),
    refresh_token_expires_in: z.number().int().positive().optional(),
  })
  .refine(
    response =>
      response.issued_tokens[0]?.access_token === response.access_token &&
      response.issued_tokens[0].scope === response.scope,
    'the standard members describe the first issued token'
  )
  .refine(
    response =>
      (response.refresh_token === undefined) === (response.refresh_token_expires_in === undefined),
    'refresh_token and refresh_token_expires_in come together'
  );
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

/**
 * An introspection response (RFC 7662, section 2.2). UTS introspects the refresh credentials it
 * issues; an access token is a JWT that every service verifies locally (design 5.4), so it, like
 * any unknown, expired, revoked or foreign token, answers `{ active: false }`.
 */
export const IntrospectionResponseSchema = z.discriminatedUnion('active', [
  z.strictObject({ active: z.literal(false) }),
  z.strictObject({
    active: z.literal(true),
    token_type: z.literal('refresh_token'),
    client_id: z.string().min(1),
    sub: z.string().min(1),
    scope: z.string().min(1),
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
    iss: z.url(),
    sid: z.uuid(),
  }),
]);
export type IntrospectionResponse = z.infer<typeof IntrospectionResponseSchema>;
