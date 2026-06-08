import { z } from 'zod';
import {
  GatewayAuthMode,
  GatewayExecutionContextSchema,
  GatewayOAuthClientAuthMethod,
  GatewaySupportedScopes,
} from './types';

export const GatewayScopeSchema = z.enum(GatewaySupportedScopes);
export const GatewayScopeListSchema = z.array(GatewayScopeSchema);

export const GatewayTokenClaimsSchema = z.object({
  iss: z.string().url(),
  sub: z.string().min(1),
  aud: z.string().url(),
  exp: z.number().int().positive(),
  iat: z.number().int().positive(),
  scope: z.string(),
  MCPID: z.string().min(1),
  owner_scope: z.enum(['personal', 'organization']),
  owner_id: z.string().min(1),
  config_id: z.string().uuid(),
  route_key: z.string().min(1),
  instance_id: z.string().uuid(),
  execution_context: GatewayExecutionContextSchema,
  config_version: z.number().int().positive(),
});

export type GatewayTokenClaims = z.infer<typeof GatewayTokenClaimsSchema>;

export const GatewayTokenMintInputSchema = GatewayTokenClaimsSchema.omit({
  iss: true,
  aud: true,
  exp: true,
  iat: true,
  scope: true,
  MCPID: true,
});

export type GatewayTokenMintInput = z.infer<typeof GatewayTokenMintInputSchema>;

const OAuthRedirectUriSchema = z
  .string()
  .url()
  .refine(value => {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  }, 'Redirect URI must use HTTPS or loopback HTTP');

export const OAuthClientMetadataSchema = z
  .object({
    client_name: z.string().min(1).max(200).optional(),
    redirect_uris: z.array(OAuthRedirectUriSchema).min(1),
    token_endpoint_auth_method: z.enum([
      GatewayOAuthClientAuthMethod.None,
      GatewayOAuthClientAuthMethod.ClientSecretPost,
      GatewayOAuthClientAuthMethod.ClientSecretBasic,
    ]),
    grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).min(1),
    response_types: z.array(z.literal('code')).min(1),
    scope: z
      .string()
      .min(1)
      .refine(value => value.trim().length > 0, 'Scope is required'),
  })
  .strip();

export type OAuthClientMetadata = z.infer<typeof OAuthClientMetadataSchema>;

export const OAuthAuthorizationQuerySchema = z
  .object({
    client_id: z.string().regex(/^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/),
    redirect_uri: OAuthRedirectUriSchema,
    response_type: z.literal('code'),
    scope: z.string().optional(),
    state: z.string().min(1).max(2048).optional(),
    resource: z.string().url().optional(),
    code_challenge: z.string().min(43).max(128).optional(),
    code_challenge_method: z.literal('S256').optional(),
  })
  .strict();

export type OAuthAuthorizationQuery = z.infer<typeof OAuthAuthorizationQuerySchema>;

export const OAuthTokenRequestSchema = z
  .object({
    grant_type: z.enum(['authorization_code', 'refresh_token']),
    code: z.string().min(1).optional(),
    refresh_token: z.string().min(1).optional(),
    redirect_uri: OAuthRedirectUriSchema.optional(),
    client_id: z.string().min(1).optional(),
    client_secret: z.string().min(1).optional(),
    code_verifier: z.string().min(43).max(128).optional(),
    resource: z.string().url().optional(),
  })
  .strict();

export type OAuthTokenRequest = z.infer<typeof OAuthTokenRequestSchema>;

export const ProviderAuthorizationServerMetadataSchema = z
  .object({
    issuer: z.string().url(),
    authorization_endpoint: z.string().url(),
    token_endpoint: z.string().url(),
    registration_endpoint: z.string().url().optional(),
    code_challenge_methods_supported: z.array(z.string()).optional(),
  })
  .passthrough();

export type ProviderAuthorizationServerMetadata = z.infer<
  typeof ProviderAuthorizationServerMetadataSchema
>;

export const RemoteProtectedResourceMetadataSchema = z
  .object({
    resource: z.string().url().optional(),
    authorization_servers: z.array(z.string().url()).optional(),
  })
  .passthrough();

export type RemoteProtectedResourceMetadata = z.infer<typeof RemoteProtectedResourceMetadataSchema>;

export const ProviderTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().min(1).optional(),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().int().positive().optional(),
    scope: z.string().optional(),
  })
  .passthrough();

export type ProviderTokenResponse = z.infer<typeof ProviderTokenResponseSchema>;

export const ProviderGrantBundleSchema = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
    expiresAt: z.string().datetime().nullable(),
    scope: z.string().optional(),
    tokenType: z.string().min(1),
  })
  .strict();

export type ProviderGrantBundle = z.infer<typeof ProviderGrantBundleSchema>;

export const ConfigSecretBundleSchema = z
  .object({
    kind: z.enum(['static_provider_credentials', 'dynamic_registration', 'static_headers']),
    value: z.record(z.string(), z.unknown()),
  })
  .strict();

export const GatewayConfigInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    remoteUrl: z.string().url(),
    authMode: z.enum([
      GatewayAuthMode.None,
      GatewayAuthMode.StaticHeaders,
      GatewayAuthMode.OAuthDynamic,
      GatewayAuthMode.OAuthStatic,
    ]),
    sharingMode: z.enum(['single_user', 'multi_user']),
    pathPassthrough: z.boolean().default(false),
  })
  .strict();

export function parseScopeString(scope: string | undefined): string[] {
  if (!scope) return [];
  return scope
    .split(/\s+/)
    .map(value => value.trim())
    .filter(value => value.length > 0);
}

export function filterSupportedScopes(scopes: string[]): string[] {
  const supportedScopes = new Set<string>(GatewaySupportedScopes);
  return scopes.filter(scope => supportedScopes.has(scope));
}
