import { device_sessions, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { verifyKiloToken } from '@kilocode/worker-utils/kilo-token';
import { KILO_API_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  isKiloCredentialExchangeEligible,
  verifyKiloTokenForPolicy,
} from '@kilocode/worker-utils/kilo-token-policy';
import { db } from '@/lib/drizzle';
import { expect } from '@jest/globals';
import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';
import { APP_URL } from '@/lib/constants';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { validateAuthorizationHeader } from '@/lib/tokens';
import { POST as exchangeNativeCredentials } from '@/app/api/auth/native/exchange/route';

export async function expectNonExchangeableSystemToken(
  token: string,
  user: User,
  tokenSource: string
): Promise<void> {
  const claims = jwt.verify(token, NEXTAUTH_SECRET, { algorithms: ['HS256'] });
  if (typeof claims === 'string') throw new Error('Expected an object JWT payload');

  expect(claims).toMatchObject({
    env: process.env.NODE_ENV,
    kiloUserId: user.id,
    apiTokenPepper: user.api_token_pepper,
    version: 3,
    tokenSource,
  });
  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') {
    throw new Error('Expected numeric issued-at and expiration claims');
  }
  expect(claims.exp - claims.iat).toBe(157_680_000);
  expect(Object.keys(claims).sort()).toEqual(
    ['apiTokenPepper', 'env', 'exp', 'iat', 'kiloUserId', 'tokenSource', 'version'].sort()
  );

  const authorization = validateAuthorizationHeader(
    new Headers({ Authorization: `Bearer ${token}` })
  );
  expect(authorization).toMatchObject({
    kiloUserId: user.id,
    apiTokenPepper: user.api_token_pepper,
    tokenSource,
  });

  await expect(verifyKiloToken(token, NEXTAUTH_SECRET)).resolves.toMatchObject({
    kiloUserId: user.id,
    tokenSource,
  });
  const context = await verifyKiloTokenForPolicy(token, NEXTAUTH_SECRET, {
    audience: KILO_API_AUDIENCE,
    mode: 'allow-legacy',
  });
  expect(isKiloCredentialExchangeEligible(context, { legacy: 'five-year-api' })).toBe(false);

  const getSessions = () =>
    db
      .select({ id: device_sessions.id })
      .from(device_sessions)
      .where(eq(device_sessions.kilo_user_id, user.id))
      .orderBy(device_sessions.id);
  const sessionsBefore = await getSessions();
  const response = await exchangeNativeCredentials(
    new NextRequest(`${APP_URL}/api/auth/native/exchange`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
  );
  expect(response.status).toBe(401);
  const body = await response.json();
  expect(body).not.toHaveProperty('token');
  expect(body).not.toHaveProperty('refreshToken');
  expect(await getSessions()).toEqual(sessionsBefore);
}
