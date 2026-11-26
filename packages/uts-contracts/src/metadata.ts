import { z } from 'zod';

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
});
export type AuthorizationServerMetadata = z.infer<typeof AuthorizationServerMetadataSchema>;
