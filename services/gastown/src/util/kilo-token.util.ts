import { SignJWT } from 'jose';

const JWT_TOKEN_VERSION = 3;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

/**
 * Generate a Kilo API token for a user. Used to create kilocode_tokens
 * for agents to authenticate with the Kilo LLM gateway.
 *
 * This is the CF Worker equivalent of generateApiToken() from src/lib/tokens.ts,
 * using jose (Web Crypto) instead of jsonwebtoken (Node.js).
 */
export async function generateKiloApiToken(
  user: { id: string; api_token_pepper: string | null },
  secret: string,
  expiresInSeconds: number = THIRTY_DAYS_SECONDS
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    kiloUserId: user.id,
    apiTokenPepper: user.api_token_pepper,
    version: JWT_TOKEN_VERSION,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSeconds)
    .sign(new TextEncoder().encode(secret));
}
