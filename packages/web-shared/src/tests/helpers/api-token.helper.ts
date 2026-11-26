import type { User } from '@kilocode/db/schema';
import { KILO_TOKEN_VERSION } from '@kilocode/worker-utils/kilo-token';
import jwt from 'jsonwebtoken';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import type { JWTTokenExtraPayload } from '@kilocode/web-shared/lib/tokens';

/*
 * The signers live in apps/web, which tests here cannot import. These mint the
 * same shapes; apps/web's `kilo-token-signing.test.ts` checks that both produce
 * the same claims.
 */

/** Signs a user API token in the shape `generateApiToken` issues. */
export function signTestApiToken(
  { id, api_token_pepper }: Pick<User, 'id' | 'api_token_pepper'>,
  extraPayload: JWTTokenExtraPayload | undefined,
  options: { expiresIn: number }
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
    { algorithm: 'HS256', expiresIn: options.expiresIn }
  );
}

/** Signs an internal assertion in the shape `generateInternalServiceToken` issues. */
export function signTestInternalServiceToken(
  userId: string,
  options?: { expiresIn?: number; audience?: string; organizationId?: string }
): string {
  return jwt.sign(
    {
      kiloUserId: userId,
      version: KILO_TOKEN_VERSION,
      ...(options?.organizationId ? { organizationId: options.organizationId } : {}),
    },
    NEXTAUTH_SECRET,
    {
      algorithm: 'HS256',
      expiresIn: options?.expiresIn ?? 60 * 60,
      ...(options?.audience ? { audience: options.audience } : {}),
    }
  );
}
