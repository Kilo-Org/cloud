import { z } from 'zod';
import { GatewayMcpAccessScope } from './types';

export const NativeMcpResourcePath = '/mcp';
export const NativeMcpResourceUrl = 'https://app.kilocode.ai/mcp';
export const NativeMcpTokenUse = 'native_mcp';

export const NativeMcpTokenClaimsSchema = z.object({
  iss: z.string().url(),
  sub: z.string().min(1),
  aud: z.literal(NativeMcpResourceUrl),
  exp: z.number().int().positive(),
  iat: z.number().int().positive(),
  scope: z.string(),
  token_use: z.literal(NativeMcpTokenUse),
  client_id: z.string().min(1),
});

export type NativeMcpTokenClaims = z.infer<typeof NativeMcpTokenClaimsSchema>;

export function isNativeMcpResource(
  resource: string | undefined
): resource is typeof NativeMcpResourceUrl {
  return resource === NativeMcpResourceUrl;
}

export function nativeMcpProtectedResourceMetadata(authorizationServer: string) {
  return {
    resource: NativeMcpResourceUrl,
    authorization_servers: [authorizationServer],
    scopes_supported: [GatewayMcpAccessScope],
  };
}

export function nativeMcpProtectedResourceMetadataUrl(appBaseUrl: string) {
  return new URL('/.well-known/oauth-protected-resource/mcp', appBaseUrl).toString();
}

export function nativeMcpAuthorizationUrl(appBaseUrl: string) {
  return new URL('/api/mcp-gateway/oauth/authorize', appBaseUrl).toString();
}
