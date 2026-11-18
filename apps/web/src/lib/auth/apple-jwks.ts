import jwt from 'jsonwebtoken';
import { createPublicKey } from 'node:crypto';
import { captureException } from '@sentry/nextjs';

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
// Local verification runs can serve a fixture key set through this override.
// The override applies only outside production deployments.
function appleJwksUrl(): string {
  const override = process.env['APPLE_JWKS_URL_OVERRIDE'];
  if (override && process.env.NODE_ENV !== 'production' && !process.env.VERCEL_ENV) {
    return override;
  }
  return APPLE_JWKS_URL;
}

/** Thrown for malformed tokens or unresolvable keys — caller error, not a server fault. */
export class AppleJwtClientError extends Error {}

type AppleJWK = {
  kty: string;
  kid: string;
  use: string;
  alg: string;
  n: string;
  e: string;
};

let cachedKeys: { keys: AppleJWK[]; fetchedAt: number } | null = null;
let refreshInFlight: Promise<AppleJWK[]> | null = null;
let lastRefreshStartedAt = 0;
let lastRefreshError: unknown = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
// Upper bound on how long a failed refresh may keep serving the cached key
// set: past this age, verification fails closed until a refresh succeeds.
export const STALE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const REFRESH_COOLDOWN_MS = 30 * 1000;
const JWKS_FETCH_TIMEOUT_MS = 10_000;

async function fetchApplePublicKeys(): Promise<AppleJWK[]> {
  const response = await fetch(appleJwksUrl(), {
    signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Apple JWKS: ${response.status}`);
  }

  const { keys } = (await response.json()) as { keys: AppleJWK[] };
  return keys;
}

async function refreshAppleKeys(): Promise<AppleJWK[]> {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  const now = Date.now();
  if (now - lastRefreshStartedAt < REFRESH_COOLDOWN_MS) {
    if (cachedKeys && now - cachedKeys.fetchedAt <= STALE_CACHE_MAX_AGE_MS) {
      return cachedKeys.keys;
    }
    throw lastRefreshError instanceof Error
      ? lastRefreshError
      : new Error('Apple JWKS is unavailable');
  }

  lastRefreshStartedAt = now;
  const inFlight = (async () => {
    try {
      const keys = await fetchApplePublicKeys();
      cachedKeys = { keys, fetchedAt: Date.now() };
      lastRefreshError = null;
      return keys;
    } catch (error) {
      lastRefreshError = error;
      if (cachedKeys && Date.now() - cachedKeys.fetchedAt <= STALE_CACHE_MAX_AGE_MS) {
        // Serve the still-present key set, at most STALE_CACHE_MAX_AGE_MS
        // after the last successful fetch; the next attempt stays on the
        // refresh cooldown while lastRefreshError records the failure. The
        // error never reaches a caller in this case, so report it here to
        // keep an Apple JWKS outage visible. Past the stale bound the error
        // rethrows instead, and the caller-side reporting covers it.
        captureException(error, { tags: { source: 'apple_jwks_refresh' } });
        return cachedKeys.keys;
      }
      throw error;
    } finally {
      refreshInFlight = null;
    }
  })();
  refreshInFlight = inFlight;
  return inFlight;
}

async function getApplePublicKeys(): Promise<AppleJWK[]> {
  if (cachedKeys && Date.now() - cachedKeys.fetchedAt < CACHE_TTL_MS) {
    return cachedKeys.keys;
  }
  return refreshAppleKeys();
}

function jwkToPem(jwk: AppleJWK): string {
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  return key.export({ type: 'spki', format: 'pem' }) as string;
}

/**
 * Verifies a JWT signed by Apple against Apple's JWKS, with a bounded refresh:
 * if the token's `kid` isn't in the cached key set, the module refreshes the key
 * set at most once per cooldown through a single shared in-flight fetch, keeping
 * the current cached keys for at most 24 hours after the last successful fetch;
 * past that bound, or when no cached set exists, a failed refresh propagates to
 * the caller. When the fallback key set cannot resolve the `kid` and the latest
 * refresh failed, the refresh error propagates too: a fetch failure is a server
 * fault, while a kid absent from a successfully fetched set is rejected as a
 * client error.
 *
 * @param token - The Apple-signed JWT to verify
 * @param audience - Expected `aud` claim (Apple client ID(s))
 * @returns The verified JWT payload
 * @throws if the JWT is invalid, expired, or no matching Apple public key is found
 */
export async function verifyAppleJwtWithJwks(
  token: string,
  audience: string | string[]
): Promise<jwt.JwtPayload> {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === 'string') {
    throw new AppleJwtClientError('Invalid JWT');
  }

  const { kid } = decoded.header;
  if (!kid) {
    throw new AppleJwtClientError('Missing kid in JWT header');
  }

  const keys = await getApplePublicKeys();
  let matchingKey = keys.find(k => k.kid === kid);
  if (!matchingKey) {
    const refreshedKeys = await refreshAppleKeys();
    matchingKey = refreshedKeys.find(k => k.kid === kid);
    if (!matchingKey) {
      // The most recent refresh attempt failed, so the key set just served is
      // the stale fallback (a success clears lastRefreshError): the missing
      // kid may be a rotated one that a healthy fetch would resolve. A fetch
      // failure is a server fault, not a caller error, so it propagates and
      // routes answer 500 instead of misreporting an invalid token.
      if (lastRefreshError !== null) {
        throw lastRefreshError instanceof Error
          ? lastRefreshError
          : new Error('Apple JWKS is unavailable');
      }
      throw new AppleJwtClientError('No matching Apple public key');
    }
  }

  const pem = jwkToPem(matchingKey);
  let payload: string | jwt.JwtPayload;
  try {
    payload = jwt.verify(token, pem, {
      algorithms: ['RS256'],
      issuer: 'https://appleid.apple.com',
      audience: audience as jwt.VerifyOptions['audience'],
    });
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      throw new AppleJwtClientError(error.message, { cause: error });
    }
    throw error;
  }
  if (typeof payload === 'string' || !payload) {
    throw new AppleJwtClientError('Invalid JWT payload');
  }

  return payload;
}
