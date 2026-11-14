import 'server-only';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';

const LINKING_COOKIE_NAME = 'account-linking-session';
const LINKING_COOKIE_MAX_AGE = 60 * 15; // 15 minutes
const LINKING_TOKEN_PURPOSE = 'account-linking';
const jwtSigningAlgorithm = 'HS256';

// The linking cookie is signed with the shared NextAuth secret, so the claims
// must carry their own purpose and pass a strict shape check before a callback
// may act on them.
const claimsSchema = z
  .object({
    existingUserId: z.string().min(1),
    targetProvider: z.string().min(1),
    organizationId: z.uuid().optional(),
    chatGptScope: z.literal('shared_services').optional(),
    createdAt: z.number().int().nonnegative(),
    tokenPurpose: z.literal(LINKING_TOKEN_PURPOSE),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict();

type LinkingClaims = z.infer<typeof claimsSchema>;

export type AccountLinkingSession = Pick<
  LinkingClaims,
  'existingUserId' | 'targetProvider' | 'organizationId' | 'chatGptScope' | 'createdAt'
>;

export async function createAccountLinkingSession(
  existingUserId: string,
  targetProvider: string,
  organizationId?: string,
  chatGptScope?: 'shared_services'
): Promise<void> {
  const session: AccountLinkingSession = {
    existingUserId,
    targetProvider,
    ...(organizationId ? { organizationId } : {}),
    ...(chatGptScope ? { chatGptScope } : {}),
    createdAt: Date.now(),
  };

  const signedToken = jwt.sign(
    { ...session, tokenPurpose: LINKING_TOKEN_PURPOSE },
    NEXTAUTH_SECRET,
    {
      algorithm: jwtSigningAlgorithm,
      expiresIn: LINKING_COOKIE_MAX_AGE,
    }
  );

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

  let payload: string | jwt.JwtPayload;
  try {
    payload = jwt.verify(sessionCookie.value, NEXTAUTH_SECRET, {
      algorithms: [jwtSigningAlgorithm],
    });
  } catch (error) {
    console.error('[ACCOUNT-LINKING] Error verifying account linking session JWT:', error);
    return null;
  }

  // A token without this purpose, or with a claim of the wrong type, never
  // reaches a linking decision.
  const claims = claimsSchema.safeParse(payload);
  if (!claims.success) {
    console.error('[ACCOUNT-LINKING] Refused an account linking session with unexpected claims');
    return null;
  }

  // Extra check beyond the JWT expiry: a linking session is spent quickly.
  if (Date.now() - claims.data.createdAt > LINKING_COOKIE_MAX_AGE * 1000) {
    return null;
  }

  return {
    existingUserId: claims.data.existingUserId,
    targetProvider: claims.data.targetProvider,
    ...(claims.data.organizationId ? { organizationId: claims.data.organizationId } : {}),
    ...(claims.data.chatGptScope ? { chatGptScope: claims.data.chatGptScope } : {}),
    createdAt: claims.data.createdAt,
  };
}

async function clearAccountLinkingSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(LINKING_COOKIE_NAME);
}
