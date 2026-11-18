const SEED_TOKEN_ENV = 'development';

/**
 * Signing parameters for a dev seed token with a caller-chosen lifetime.
 *
 * Shared code because several topics mint a token: `dev/seed/AGENTS.md` keeps
 * topics independent of one another.
 */
export function seedTokenSigningParams(expiresInSeconds: number): {
  expiresInSeconds: number;
  env: string;
} {
  return {
    expiresInSeconds,
    env: SEED_TOKEN_ENV,
  };
}
