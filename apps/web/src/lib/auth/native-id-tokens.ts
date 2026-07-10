import 'server-only';
import { OAuth2Client } from 'google-auth-library';
import { verifyAppleJwtWithJwks } from '@/lib/auth/apple-jwks';
import { GOOGLE_CLIENT_ID, GOOGLE_IOS_CLIENT_ID } from '@/lib/config.server';

/** Thrown when a native (mobile) ID token fails verification — maps to 401 INVALID_TOKEN. */
export class NativeIdTokenError extends Error {}

export type VerifiedAppleIdToken = { sub: string; email: string };

export type VerifiedGoogleIdToken = {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
  hd?: string;
};

export async function verifyNativeAppleIdToken(idToken: string): Promise<VerifiedAppleIdToken> {
  const payload = await verifyAppleJwtWithJwks(idToken, 'com.kilocode.kiloapp');

  if (typeof payload.email !== 'string' || !payload.email) {
    throw new NativeIdTokenError('Apple ID token missing email');
  }
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    throw new NativeIdTokenError('Apple email not verified');
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new NativeIdTokenError('Apple ID token missing sub');
  }

  return { sub: payload.sub, email: payload.email };
}

// Lazily constructed so module import order doesn't matter for tests mocking OAuth2Client.
let googleClient: OAuth2Client | undefined;
function getGoogleClient(): OAuth2Client {
  googleClient ??= new OAuth2Client();
  return googleClient;
}

export async function verifyNativeGoogleIdToken(idToken: string): Promise<VerifiedGoogleIdToken> {
  const audience = [GOOGLE_CLIENT_ID, GOOGLE_IOS_CLIENT_ID].filter(Boolean);
  const googleClient = getGoogleClient();
  const { certs } = await googleClient.getFederatedSignonCertsAsync();
  let ticket;
  try {
    ticket = await googleClient.verifySignedJwtWithCertsAsync(idToken, certs, audience, [
      'accounts.google.com',
      'https://accounts.google.com',
    ]);
  } catch (error) {
    throw new NativeIdTokenError('Google ID token verification failed', { cause: error });
  }
  const payload = ticket.getPayload();

  if (!payload) {
    throw new NativeIdTokenError('Invalid Google ID token payload');
  }
  if (!payload.email_verified) {
    throw new NativeIdTokenError('Google email not verified');
  }
  if (!payload.email || !payload.sub) {
    throw new NativeIdTokenError('Google ID token missing email or sub');
  }

  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
    hd: payload.hd,
  };
}
