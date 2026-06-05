import {
  GatewayTokenClaimsSchema,
  createGatewayError,
  GatewayErrorCode,
} from '@kilocode/mcp-gateway';
import { createLocalJWKSet, jwtVerify, type JWK } from 'jose';
import { z } from 'zod';

const JWKSchema = z
  .object({
    kid: z.string().min(1),
    kty: z.string().min(1),
  })
  .passthrough();

const JWKSResponseSchema = z.object({
  keys: z.array(JWKSchema).min(1),
});

function parseJwks(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw createGatewayError(GatewayErrorCode.ServerError, 'Gateway JWKS is malformed', 500);
  }
  return JWKSResponseSchema.parse(parsed);
}

export async function verifyGatewayToken(params: {
  token: string;
  jwksJson: string;
  issuer: string;
  expectedAudience: string;
}) {
  const keyset = parseJwks(params.jwksJson);
  const keys: JWK[] = keyset.keys;
  const jwks = createLocalJWKSet({ keys });
  const { payload } = await jwtVerify(params.token, jwks, {
    algorithms: ['RS256'],
    issuer: params.issuer,
    audience: params.expectedAudience,
  });
  const claims = GatewayTokenClaimsSchema.parse(payload);
  if (claims.aud !== params.expectedAudience) {
    throw createGatewayError(GatewayErrorCode.InvalidGrant, 'Token audience mismatch', 401);
  }
  return claims;
}
