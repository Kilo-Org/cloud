import { signKiloToken } from '@kilocode/worker-utils';

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

/**
 * Generate a Kilo API token for a user. Used to create kilocode_tokens
 * for agents to authenticate with the Kilo LLM gateway.
 *
 * This is the CF Worker equivalent of generateApiToken() from src/lib/tokens.ts.
 */
export async function generateKiloApiToken(
  user: { id: string; api_token_pepper: string | null },
  secret: string,
  expiresInSeconds: number = THIRTY_DAYS_SECONDS
): Promise<string> {
  const { token } = await signKiloToken({
    userId: user.id,
    pepper: user.api_token_pepper,
    secret,
    expiresInSeconds,
  });
  return token;
}
