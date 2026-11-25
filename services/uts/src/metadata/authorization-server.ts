import type { AuthorizationServerMetadata } from '@kilocode/uts-contracts';
import type { UtsConfig } from '../env';

/**
 * RFC 8414 metadata for the issuer. It lists only what answers today: the issuer and the key set
 * on the feed Worker. The authorization, token, device, revocation and introspection endpoints join
 * as their slices ship. Empty `response_types_supported` and `grant_types_supported` say that no
 * flow runs yet; without the second, a reader would assume `authorization_code` and `implicit`.
 */
export function authorizationServerMetadata(config: UtsConfig): AuthorizationServerMetadata {
  return {
    issuer: config.endpoints.issuer,
    jwks_uri: config.endpoints.jwksUri,
    response_types_supported: [],
    grant_types_supported: [],
  };
}
