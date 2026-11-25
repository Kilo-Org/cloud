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
});
export type AuthorizationServerMetadata = z.infer<typeof AuthorizationServerMetadataSchema>;
