import { z } from 'zod';
import { UTS_ENDPOINTS, type UtsEnvironment } from './environment';
import { resourceOriginOf } from './oauth';
import { UTS_SCOPE_REGISTRY } from './scopes';

/**
 * RFC 8414 authorization-server metadata as UTS publishes it. Members are added as the endpoints
 * they name go live; the document never lists an endpoint that does not answer. A reader ignores
 * members it does not know (RFC 8414 section 3.2), so the schema keeps them.
 */
export const AuthorizationServerMetadataSchema = z.looseObject({
  issuer: z.url(),
  jwks_uri: z.url(),
  response_types_supported: z.array(z.string().min(1)),
  /** Present so a reader does not assume the RFC 8414 default of `authorization_code` and `implicit`. */
  grant_types_supported: z.array(z.string().min(1)),
  authorization_endpoint: z.url().optional(),
  token_endpoint: z.url().optional(),
  revocation_endpoint: z.url().optional(),
  introspection_endpoint: z.url().optional(),
  code_challenge_methods_supported: z.array(z.string().min(1)).optional(),
  /** RFC 8628, section 4. */
  device_authorization_endpoint: z.url().optional(),
  token_endpoint_auth_methods_supported: z.array(z.string().min(1)).optional(),
  revocation_endpoint_auth_methods_supported: z.array(z.string().min(1)).optional(),
  introspection_endpoint_auth_methods_supported: z.array(z.string().min(1)).optional(),
  /** RFC 9449, section 5.1. */
  dpop_signing_alg_values_supported: z.array(z.string().min(1)).optional(),
  /** RFC 9207, section 3. */
  authorization_response_iss_parameter_supported: z.boolean().optional(),
  /** OAuth Client ID Metadata Document: a client id may be the HTTPS URL of its metadata. */
  client_id_metadata_document_supported: z.boolean().optional(),
});
export type AuthorizationServerMetadata = z.infer<typeof AuthorizationServerMetadataSchema>;

/** RFC 9728 protected-resource metadata, the members a Kilo resource publishes. */
export const ProtectedResourceMetadataSchema = z.looseObject({
  resource: z.url(),
  authorization_servers: z.array(z.url()).min(1),
  scopes_supported: z.array(z.string().min(1)),
  bearer_methods_supported: z.array(z.literal('header')),
  resource_name: z.string().min(1),
});
export type ProtectedResourceMetadata = z.infer<typeof ProtectedResourceMetadataSchema>;

/**
 * The RFC 9728 metadata of `audience` in `environment`, which the resource serves at
 * `/.well-known/oauth-protected-resource` on its origin: the resource is the audience's origin in
 * `UTS_RESOURCE_ORIGINS` (the one resource indicator besides `urn:kilo:service:<audience>` that UTS
 * accepts for it there), the authorization server is the environment's UTS issuer, and the scopes
 * are the registry's scopes of that audience. Null when the table names no origin for the audience
 * in the environment.
 */
export function protectedResourceMetadataFor(
  environment: UtsEnvironment,
  audience: string,
  resourceName: string
): ProtectedResourceMetadata | null {
  const resource = resourceOriginOf(environment, audience);
  if (resource === null) return null;
  return {
    resource,
    authorization_servers: [UTS_ENDPOINTS[environment].issuer],
    // A scope that only the broker exchange mints cannot be asked for at `/authorize`.
    scopes_supported: Object.entries(UTS_SCOPE_REGISTRY)
      .filter(([, entry]) => entry.audience === audience && entry.issuance === 'grant')
      .map(([scope]) => scope),
    bearer_methods_supported: ['header'],
    resource_name: resourceName,
  };
}
