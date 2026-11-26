import { z } from 'zod';
import { UTS_ENDPOINTS, type UtsEnvironment } from './environment';
import { KILO_API_RESOURCES } from './oauth';
import { KILO_API_AUDIENCE, UTS_SCOPE_REGISTRY } from './scopes';

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
  token_endpoint_auth_methods_supported: z.array(z.string().min(1)).optional(),
  revocation_endpoint_auth_methods_supported: z.array(z.string().min(1)).optional(),
  introspection_endpoint_auth_methods_supported: z.array(z.string().min(1)).optional(),
  /** RFC 9449, section 5.1. */
  dpop_signing_alg_values_supported: z.array(z.string().min(1)).optional(),
  /** RFC 9207, section 3. */
  authorization_response_iss_parameter_supported: z.boolean().optional(),
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
 * The Kilo API's RFC 9728 metadata in `environment`, which the web app serves at
 * `/.well-known/oauth-protected-resource`: the resource is the environment's app origin
 * (`KILO_API_RESOURCES`), the one resource indicator besides `urn:kilo:service:kilo-api` that UTS
 * accepts for the `kilo-api` audience, and the scopes are the registry's `kilo-api` scopes.
 */
export function kiloApiProtectedResourceMetadata(
  environment: UtsEnvironment
): ProtectedResourceMetadata {
  return {
    resource: KILO_API_RESOURCES[environment],
    authorization_servers: [UTS_ENDPOINTS[environment].issuer],
    scopes_supported: Object.entries(UTS_SCOPE_REGISTRY)
      .filter(([, entry]) => entry.audience === KILO_API_AUDIENCE)
      .map(([scope]) => scope),
    bearer_methods_supported: ['header'],
    resource_name: 'Kilo API',
  };
}
