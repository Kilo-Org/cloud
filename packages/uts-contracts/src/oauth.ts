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
 * The HTTPS resource origins each environment accepts as RFC 8707 resource indicators, and the
 * audience each names; RFC 9728 metadata names the same origin (`protectedResourceMetadataFor`).
 * A table per environment, so an origin of another environment names nothing.
 *
 * - Production: the web app (`kilo-api`; the origin `resolveAppUrl` in
 *   `packages/web-shared/src/lib/constants.ts` uses), the UTS issuer (`uts`, the account API), and
 *   the Workers that accept UTS tokens on their own origins, from their route configs. An entry
 *   here does not activate a service: the service proves its caller before it accepts the tokens.
 * - Staging: the staging web app and the staging issuer only. Another staging origin joins once a
 *   deployment of that Worker on it is confirmed.
 * - Development: loopback only: the local web app on its default port (`PORT` unset), the local
 *   issuer, and each Worker on its local development port (session ingest on 8821, since its
 *   default port is the issuer's).
 */
export const UTS_RESOURCE_ORIGINS: Readonly<
  Record<UtsEnvironment, Readonly<Record<string, string>>>
> = {
  production: {
    'https://app.kilo.ai': KILO_API_AUDIENCE,
    [UTS_ENDPOINTS.production.issuer]: UTS_ACCOUNT_AUDIENCE,
    'https://ai-attribution.kiloapps.io': 'ai-attribution',
    'https://session-sync.kiloapps.io': 'session-sync',
    'https://notifications.kiloapps.io': 'notifications',
    'https://events.kiloapps.io': 'event-service',
    'https://chat.kiloapps.io': 'kilo-chat',
    'https://ingest.kilosessions.ai': 'session-ingest',
    'https://user-data-export.kilosessions.ai': 'user-data-export',
    'https://git-token-service.kilosessions.ai': 'git-token-service',
    'https://cloud-agent-next.kilosessions.ai': 'cloud-agent-next',
  },
  staging: {
    'https://staging-app.kilo.ai': KILO_API_AUDIENCE,
    [UTS_ENDPOINTS.staging.issuer]: UTS_ACCOUNT_AUDIENCE,
  },
  development: {
    'http://localhost:3000': KILO_API_AUDIENCE,
    [UTS_ENDPOINTS.development.issuer]: UTS_ACCOUNT_AUDIENCE,
    'http://localhost:8787': 'ai-attribution',
    'http://localhost:8817': 'session-sync',
    'http://localhost:8804': 'notifications',
    'http://localhost:8809': 'event-service',
    'http://localhost:8808': 'kilo-chat',
    'http://localhost:8821': 'session-ingest',
    'http://localhost:8818': 'user-data-export',
    'http://localhost:8802': 'git-token-service',
    'http://localhost:8794': 'cloud-agent-next',
  },
};

/** The resource origin of `audience` in `environment`, or null when the table names none. */
export function resourceOriginOf(environment: UtsEnvironment, audience: string): string | null {
  const found = Object.entries(UTS_RESOURCE_ORIGINS[environment]).find(
    ([, named]) => named === audience
  );
  return found === undefined ? null : found[0];
}

/**
 * The audience a resource indicator names in `environment`, or null when it names no Kilo service
 * there. Two forms, each an exact string: `urn:kilo:service:<audience>`, and an origin of the
 * environment's `UTS_RESOURCE_ORIGINS` table. Another environment's origin, a path, a trailing
 * slash or a query names nothing.
 */
export function audienceOfResource(resource: string, environment: UtsEnvironment): string | null {
  const origins = UTS_RESOURCE_ORIGINS[environment];
  if (Object.hasOwn(origins, resource)) return origins[resource] ?? null;
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
