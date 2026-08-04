import 'server-only';
import { createHash } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { verifyAppleJwtWithJwks } from '@/lib/auth/apple-jwks';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_IOS_CLIENT_ID } from '@/lib/config.server';
import { captureMessage } from '@sentry/nextjs';

/** Thrown when a native (mobile) ID token fails verification — maps to 401 INVALID_TOKEN. */
export class NativeIdTokenError extends Error {}

/** Returns true when the error carries an HTTP response from Google's servers,
 *  as opposed to a network or infrastructure failure. */
function hasResponse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    (error as { response: unknown }).response !== undefined
  );
}

export type VerifiedAppleIdToken = { sub: string; email: string };

export type VerifiedGoogleIdToken = {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
  hd?: string;
};

export async function verifyNativeAppleIdToken(
  idToken: string,
  nonce?: string
): Promise<VerifiedAppleIdToken> {
  const payload = await verifyAppleJwtWithJwks(idToken, 'com.kilocode.kiloapp');

  // The mobile client pre-computes the SHA-256 digest of the raw nonce and passes the
  // digest to AppleAuthentication.signInAsync.  Apple embeds the digest in the identity
  // token payload as-is (no second hash).  The server must compute SHA-256 of the raw
  // nonce the mobile client sent and compare against payload.nonce.
  if (nonce !== undefined) {
    const expectedNonce = createHash('sha256').update(nonce).digest('hex');
    if (payload.nonce !== expectedNonce) {
      throw new NativeIdTokenError('Apple nonce mismatch');
    }
  } else {
    // ponytail: remove legacy no-nonce path after all shipped builds send a nonce
    // and the legacy counter has drained.
    captureMessage('native_apple_nonce_legacy_count: 1');
  }

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

/**
 * Exchanges a Google server authorization code for tokens, then verifies the
 * returned ID token.  Uses the web app client credentials because the mobile
 * app passes `GOOGLE_WEB_CLIENT_ID` as `webClientId`, which must equal the
 * server `GOOGLE_CLIENT_ID` — they are the same OAuth client.
 */
export async function exchangeNativeGoogleAuthCode(
  serverAuthCode: string
): Promise<VerifiedGoogleIdToken> {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is not configured');
  }

  const client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);

  let tokenResponse;
  try {
    tokenResponse = await client.getToken(serverAuthCode);
  } catch (error) {
    // A replayed or expired authorization code surfaces as an OAuth error from
    // Google with a response body.  Network or infrastructure failures have no
    // response — propagate those as server errors so the route returns 5xx.
    if (hasResponse(error)) {
      throw new NativeIdTokenError('Google authorization code exchange failed', { cause: error });
    }
    throw error;
  }

  const idToken = tokenResponse.tokens.id_token;
  if (!idToken) {
    throw new NativeIdTokenError('Google token response missing id_token');
  }

  // Verify the returned ID token against the web client audience and apply
  // the same payload checks as the direct idToken path.  Follow the same
  // cert-fetch-outside / JWT-verify-inside pattern as verifyNativeGoogleIdToken:
  // cert/network failures surface as 5xx; invalid tokens surface as 401.
  const { certs } = await client.getFederatedSignonCertsAsync();
  let ticket;
  try {
    ticket = await client.verifySignedJwtWithCertsAsync(
      idToken,
      certs,
      [GOOGLE_CLIENT_ID],
      ['accounts.google.com', 'https://accounts.google.com']
    );
  } catch (error) {
    throw new NativeIdTokenError('Google ID token verification failed after code exchange', {
      cause: error,
    });
  }
  const payload = ticket.getPayload();

  if (!payload) {
    throw new NativeIdTokenError('Invalid Google ID token payload from code exchange');
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
