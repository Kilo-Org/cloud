import 'server-only';
import { createHash } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { verifyAppleJwtWithJwks } from '@/lib/auth/apple-jwks';
import {
  APPLE_APP_BUNDLE_ID,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_IOS_CLIENT_ID,
} from '@kilocode/web-shared/lib/config.server';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { isReleaseToggleEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { captureMessage } from '@sentry/nextjs';

/** Thrown when a native (mobile) ID token fails verification — maps to 401 INVALID_TOKEN. */
export class NativeIdTokenError extends Error {}

/** Thrown when the single-use record cannot be written — maps to 503, retryable. */
export class NonceStoreUnavailableError extends Error {}

// Upper bound for the single-use record: the longest Apple ID-token lifetime.
const NONCE_TTL_CAP_SECONDS = 10 * 60;

/**
 * End instant for the transition window: the nonce requirement applies from
 * this instant onward. Before it, the deployment can enable a runtime toggle
 * (below) to keep accepting earlier request shapes. Unset (or passed) ⇒ the
 * requirement applies unconditionally. Read per call so a deployment can
 * change it without a redeploy.
 */
function relaxedPathEnd(): Date | null {
  const raw = getEnvVariable('NATIVE_APPLE_NONCE_REQUIRED_SINCE');
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Deployment switch for the transition window: while enabled and before the
 * end instant, the nonce requirement is deferred. It reads as false whenever
 * the check cannot complete, so the requirement stays active by default.
 */
const RELAXED_NONCE_PATH_TOGGLE = 'native-apple-signin-nonce-relaxed-path';

async function relaxedNoncePathAllowed(): Promise<boolean> {
  const end = relaxedPathEnd();
  if (!end || end <= new Date()) return false;
  // Local verification runs without PostHog credentials opt in explicitly;
  // the toggle still governs every other environment.
  if (
    process.env.NODE_ENV === 'development' &&
    process.env.VERCEL_ENV === undefined &&
    getEnvVariable('NATIVE_APPLE_NONCE_TRANSITION_LOCAL') === 'true'
  ) {
    return true;
  }
  try {
    return await isReleaseToggleEnabled(RELAXED_NONCE_PATH_TOGGLE);
  } catch {
    return false;
  }
}

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
  // The Apple identity token's `aud` claim is the native app's bundle ID.  Use
  // the configured bundle ID and fall back to the shipped default so
  // deployments that have not set APPLE_APP_BUNDLE_ID keep accepting tokens
  // from the current release.
  const audience = APPLE_APP_BUNDLE_ID || 'com.kilocode.kiloapp';
  const payload = await verifyAppleJwtWithJwks(idToken, audience);

  // The mobile client pre-computes the SHA-256 digest of the raw nonce and passes the
  // digest to AppleAuthentication.signInAsync.  Apple embeds the digest in the identity
  // token payload as-is (no second hash).  The server must compute SHA-256 of the raw
  // nonce the mobile client sent and compare against payload.nonce.
  //
  // Each digest is accepted once: the record below exists only for a digest that
  // is not yet present, and it expires with the token.
  if (nonce === undefined || nonce === '') {
    if (!(await relaxedNoncePathAllowed())) {
      throw new NativeIdTokenError('Apple nonce missing');
    }
    captureMessage('native_apple_nonce_legacy_count: 1');
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

  const expectedNonce = createHash('sha256').update(nonce).digest('hex');
  if (payload.nonce !== expectedNonce) {
    throw new NativeIdTokenError('Apple nonce mismatch');
  }
  // The record lives as long as the identity token it binds, bounded by the
  // longest Apple ID-token lifetime. A store write that cannot complete
  // refuses the sign-in, keeping the acceptance rule uniform.
  const ttlSeconds = (() => {
    if (typeof payload.exp !== 'number') return NONCE_TTL_CAP_SECONDS;
    const remaining = Math.floor(payload.exp - Date.now() / 1000);
    return Math.max(1, Math.min(remaining, NONCE_TTL_CAP_SECONDS));
  })();
  let recorded: string | null = null;
  try {
    recorded = await redisClient.set(`auth:apple-signin-nonce:${expectedNonce}`, '1', {
      nx: true,
      ex: ttlSeconds,
    });
  } catch {
    throw new NonceStoreUnavailableError('Apple nonce check unavailable');
  }
  if (recorded !== 'OK') {
    throw new NativeIdTokenError('Apple nonce already used');
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

/** Issuers Google uses for ID tokens, shared by every native Google path. */
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

// Upper bound for the single-use record: the longest Google ID-token lifetime.
const GOOGLE_TOKEN_TTL_CAP_SECONDS = 60 * 60;

/**
 * Consume a verified Google ID token so it signs in exactly once. The record
 * lives as long as the token it binds (bounded by the longest Google ID-token
 * lifetime), and a store write that cannot complete refuses the sign-in, so
 * the acceptance rule never depends on the store being reachable.
 */
async function recordSingleUseGoogleToken(
  idToken: string,
  expiresAt: number | undefined
): Promise<void> {
  const digest = createHash('sha256').update(idToken).digest('hex');
  const ttlSeconds = (() => {
    if (typeof expiresAt !== 'number') return GOOGLE_TOKEN_TTL_CAP_SECONDS;
    const remaining = Math.floor(expiresAt - Date.now() / 1000);
    return Math.max(1, Math.min(remaining, GOOGLE_TOKEN_TTL_CAP_SECONDS));
  })();
  let recorded: string | null = null;
  try {
    recorded = await redisClient.set(`auth:google-signin-token:${digest}`, '1', {
      nx: true,
      ex: ttlSeconds,
    });
  } catch {
    throw new NonceStoreUnavailableError('Google token record unavailable');
  }
  if (recorded !== 'OK') {
    throw new NativeIdTokenError('Google ID token already used');
  }
}

type GoogleVerificationMessages = {
  /** Message for a token the JWT verification rejects. */
  verificationFailed: string;
  /** Message for a verified ticket that carries no payload. */
  invalidPayload: string;
};

/**
 * Verify a Google ID token against one audience and apply the acceptance rules
 * every native Google path shares: a payload with a verified email and both
 * `email` and `sub`, mapped onto VerifiedGoogleIdToken.
 *
 * The certificate fetch stays outside the try so provider or network failures
 * propagate as server errors (5xx); only a rejected token becomes a
 * NativeIdTokenError (401).
 */
async function verifyGoogleIdTokenWith(
  client: OAuth2Client,
  idToken: string,
  audience: string[],
  messages: GoogleVerificationMessages
): Promise<VerifiedGoogleIdToken> {
  const { certs } = await client.getFederatedSignonCertsAsync();
  let ticket;
  try {
    ticket = await client.verifySignedJwtWithCertsAsync(idToken, certs, audience, GOOGLE_ISSUERS);
  } catch (error) {
    throw new NativeIdTokenError(messages.verificationFailed, { cause: error });
  }
  const payload = ticket.getPayload();

  if (!payload) {
    throw new NativeIdTokenError(messages.invalidPayload);
  }
  if (!payload.email_verified) {
    throw new NativeIdTokenError('Google email not verified');
  }
  if (!payload.email || !payload.sub) {
    throw new NativeIdTokenError('Google ID token missing email or sub');
  }

  // Both Google paths — the legacy `idToken` field and the ID token returned
  // by the server-auth-code exchange — run through here, so an assertion is
  // accepted for one sign-in whichever path delivered it.
  await recordSingleUseGoogleToken(idToken, payload.exp);

  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
    hd: payload.hd,
  };
}

export async function verifyNativeGoogleIdToken(idToken: string): Promise<VerifiedGoogleIdToken> {
  const audience = [GOOGLE_CLIENT_ID, GOOGLE_IOS_CLIENT_ID].filter(Boolean);
  return verifyGoogleIdTokenWith(getGoogleClient(), idToken, audience, {
    verificationFailed: 'Google ID token verification failed',
    invalidPayload: 'Invalid Google ID token payload',
  });
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

  // Verify the returned ID token against the web client audience through the
  // shared helper, so both Google paths apply the same payload checks. The
  // helper fetches the certificates outside its try: cert/network failures
  // surface as 5xx; invalid tokens surface as 401.
  return verifyGoogleIdTokenWith(client, idToken, [GOOGLE_CLIENT_ID], {
    verificationFailed: 'Google ID token verification failed after code exchange',
    invalidPayload: 'Invalid Google ID token payload from code exchange',
  });
}
