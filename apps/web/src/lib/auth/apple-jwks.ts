import jwt from 'jsonwebtoken';
import { createPublicKey } from 'node:crypto';

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';

/** Thrown for malformed tokens or unresolvable keys — caller error, not a server fault. */
export class AppleJwtClientError extends Error {}

type AppleJWK = {
  kty: string;
  kid: string;
  use: string;
  alg: string;
  n: string;
  e: string;
};

let cachedKeys: { keys: AppleJWK[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getApplePublicKeys(): Promise<AppleJWK[]> {
  if (cachedKeys && Date.now() - cachedKeys.fetchedAt < CACHE_TTL_MS) {
    return cachedKeys.keys;
  }

  const response = await fetch(APPLE_JWKS_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch Apple JWKS: ${response.status}`);
  }

  const { keys } = (await response.json()) as { keys: AppleJWK[] };
  cachedKeys = { keys, fetchedAt: Date.now() };
  return keys;
}

function jwkToPem(jwk: AppleJWK): string {
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  return key.export({ type: 'spki', format: 'pem' }) as string;
}

/**
 * Verifies a JWT signed by Apple against Apple's JWKS, retrying once with a
 * freshly-fetched key set if the token's `kid` isn't found in the cache.
 *
 * @param token - The Apple-signed JWT to verify
 * @param audience - Expected `aud` claim (Apple client ID(s))
 * @returns The verified JWT payload
 * @throws if the JWT is invalid, expired, or no matching Apple public key is found
 */
export async function verifyAppleJwtWithJwks(
  token: string,
  audience: string | string[]
): Promise<jwt.JwtPayload> {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === 'string') {
    throw new AppleJwtClientError('Invalid JWT');
  }

  const { kid } = decoded.header;
  if (!kid) {
    throw new AppleJwtClientError('Missing kid in JWT header');
  }

  const keys = await getApplePublicKeys();
  let matchingKey = keys.find(k => k.kid === kid);
  if (!matchingKey) {
    // Key not found — clear cache and retry once
    cachedKeys = null;
    const freshKeys = await getApplePublicKeys();
    matchingKey = freshKeys.find(k => k.kid === kid);
    if (!matchingKey) {
      throw new AppleJwtClientError('No matching Apple public key');
    }
  }

  const pem = jwkToPem(matchingKey);
  let payload: string | jwt.JwtPayload;
  try {
    payload = jwt.verify(token, pem, {
      algorithms: ['RS256'],
      issuer: 'https://appleid.apple.com',
      audience: audience as jwt.VerifyOptions['audience'],
    });
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      throw new AppleJwtClientError(error.message, { cause: error });
    }
    throw error;
  }
  if (typeof payload === 'string' || !payload) {
    throw new AppleJwtClientError('Invalid JWT payload');
  }

  return payload;
}
