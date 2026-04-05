import 'server-only';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { NEXTAUTH_SECRET } from '@/lib/config.server';

const LINKING_COOKIE_NAME = 'account-linking-session';
const LINKING_COOKIE_MAX_AGE = 60 * 5; // 5 minutes
const jwtSigningAlgorithm = 'HS256';

export type AccountLinkingSession = {
  existingUserId: string;
  targetProvider: string;
  createdAt: number;
};

export async function createAccountLinkingSession(
  existingUserId: string,
  targetProvider: string
): Promise<void> {
  const session: AccountLinkingSession = {
    existingUserId,
    targetProvider,
    createdAt: Date.now(),
  };

  const signedToken = jwt.sign(session, NEXTAUTH_SECRET, {
    algorithm: jwtSigningAlgorithm,
    expiresIn: LINKING_COOKIE_MAX_AGE,
  });

  const cookieStore = await cookies();
  // For OAuth round-trips we prefer SameSite=None; Secure so cookies are sent on cross-site redirects.
  // However, on local http development, browsers may drop Secure cookies. Fall back to lax in dev.
  const isDev = process.env.NODE_ENV === 'development';
  cookieStore.set(LINKING_COOKIE_NAME, signedToken, {
    httpOnly: true,
    secure: !isDev, // only mark Secure outside dev to ensure cookie is stored locally
    sameSite: isDev ? 'lax' : 'none',
    maxAge: LINKING_COOKIE_MAX_AGE,
    path: '/',
  });
}

export async function getAccountLinkingSession(): Promise<AccountLinkingSession | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(LINKING_COOKIE_NAME);

  if (!sessionCookie?.value) {
    return null;
  }
  await clearAccountLinkingSession();

  let session: jwt.JwtPayload & AccountLinkingSession;
  try {
    session = jwt.verify(sessionCookie.value, NEXTAUTH_SECRET, {
      algorithms: [jwtSigningAlgorithm],
    }) as jwt.JwtPayload & AccountLinkingSession;
  } catch (error) {
    console.error('[ACCOUNT-LINKING] Error verifying account linking session JWT:', error);
    return null;
  }

  // Check if session is expired (5 minutes) - extra check beyond JWT expiry
  if (Date.now() - session.createdAt > LINKING_COOKIE_MAX_AGE * 1000) {
    return null;
  }

  return {
    existingUserId: session.existingUserId,
    targetProvider: session.targetProvider,
    createdAt: session.createdAt,
  };
}

async function clearAccountLinkingSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(LINKING_COOKIE_NAME);
}
