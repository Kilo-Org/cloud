import { z } from 'zod';
import { GatewayMcpAccessScope } from './types';

export const NativeMcpResourcePath = '/mcp';
export const NativeMcpTokenUse = 'native_mcp';

export function nativeMcpResourceUrl(appBaseUrl: string) {
  return new URL(NativeMcpResourcePath, appBaseUrl).toString();
}

export const NativeMcpTokenClaimsSchema = z.object({
  iss: z.string().url(),
  sub: z.string().min(1),
  aud: z.string().url(),
  exp: z.number().int().positive(),
  iat: z.number().int().positive(),
  scope: z.string(),
  token_use: z.literal(NativeMcpTokenUse),
  client_id: z.string().min(1),
});

export type NativeMcpTokenClaims = z.infer<typeof NativeMcpTokenClaimsSchema>;

export function isNativeMcpResource(resource: string | undefined, appBaseUrl: string) {
  return resource === nativeMcpResourceUrl(appBaseUrl);
}

export function nativeMcpProtectedResourceMetadata(appBaseUrl: string) {
  return {
    resource: nativeMcpResourceUrl(appBaseUrl),
    authorization_servers: [appBaseUrl],
    scopes_supported: [GatewayMcpAccessScope],
  };
}

export function nativeMcpProtectedResourceMetadataUrl(appBaseUrl: string) {
  return new URL('/.well-known/oauth-protected-resource/mcp', appBaseUrl).toString();
}

export function nativeMcpAuthorizationUrl(appBaseUrl: string) {
  return new URL('/api/mcp-gateway/oauth/authorize', appBaseUrl).toString();
}
