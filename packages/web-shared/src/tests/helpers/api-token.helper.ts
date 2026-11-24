import type { User } from '@kilocode/db/schema';
import { KILO_TOKEN_VERSION } from '@kilocode/worker-utils/kilo-token';
import jwt from 'jsonwebtoken';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import type { JWTTokenExtraPayload } from '@kilocode/web-shared/lib/tokens';

/**
 * Signs a user API token in the shape `generateApiToken` issues. The signer
 * lives in apps/web, which tests here cannot import; apps/web's
 * `kilo-token-signing.test.ts` checks that both produce the same claims.
 */
export function signTestApiToken(
  { id, api_token_pepper }: Pick<User, 'id' | 'api_token_pepper'>,
  extraPayload?: JWTTokenExtraPayload,
  options?: { expiresIn?: number }
): string {
  return jwt.sign(
    {
      env: process.env.NODE_ENV,
      kiloUserId: id,
      apiTokenPepper: api_token_pepper,
      version: KILO_TOKEN_VERSION,
      ...extraPayload,
    },
    NEXTAUTH_SECRET,
    { algorithm: 'HS256', expiresIn: options?.expiresIn ?? 5 * 365 * 24 * 60 * 60 }
  );
}
