import jwt from 'jsonwebtoken';
import { createPublicKey } from 'node:crypto';
import { captureException } from '@sentry/nextjs';
import * as z from 'zod';

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

/**
 * The members of an Apple JWKS entry this module reads. `use` and `alg` are
 * optional JWK members (RFC 7517) and are not consulted here, so an entry that
 * omits them is still usable.
 */
const appleJwkSchema = z.object({
  kty: z.literal('RSA'),
  kid: z.string().min(1),
  n: z.string().min(1),
  e: z.string().min(1),
});

type AppleJwkEntry = z.infer<typeof appleJwkSchema>;

const appleJwksResponseSchema = z.object({ keys: z.array(z.unknown()) });

/**
 * A cached Apple key: the `kid` a token names, and the PEM the verification
 * uses. Keys are converted once per refresh, so a malformed key cannot raise
 * from the per-request verification path.
 */
type ApplePublicKey = { kid: string; pem: string };

let cachedKeys: { keys: ApplePublicKey[]; fetchedAt: number } | null = null;
let refreshInFlight: Promise<ApplePublicKey[]> | null = null;
let lastRefreshStartedAt = 0;
let lastRefreshError: unknown = null;
// Whether the recorded failure has already reached Sentry. The flag covers the
// whole outage: the first request that disposes of the failure reports it — the
// module when verification consumes the fallback set, the receiving route when
// the error propagates — and only a successful refresh clears it. Leaving it
// set across attempts keeps a long outage at one module report instead of one
// per attempt.
let refreshOutageReported = false;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
// Upper bound on how long a failed refresh may keep serving the cached key
// set: past this age, verification fails closed until a refresh succeeds.
export const STALE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const REFRESH_COOLDOWN_MS = 30 * 1000;
const JWKS_FETCH_TIMEOUT_MS = 10_000;

/**
 * Throws the recorded refresh failure after marking the outage reported.
 * Propagating hands the error to a route or the framework handler, which
 * reports it; marking the outage reported keeps a later verification of the
 * same failure from reporting it again.
 */
function throwJwksUnavailable(): never {
  refreshOutageReported = true;
  throw lastRefreshError instanceof Error
    ? lastRefreshError
    : new Error('Apple JWKS is unavailable');
}

// Apple signs with 2048-bit RSA keys. Node's JWK import accepts a truncated or
// non-base64url modulus as a tiny key instead of throwing, so an imported key
// only counts as usable with a signing-strength modulus.
const MIN_RSA_MODULUS_BITS = 2048;

/**
 * Converts one JWK entry to a PEM public key, or `null` when the entry's key
 * material is unusable. Conversion happens during the refresh, so a bad entry
 * cannot raise from the per-request verification path.
 */
function jwkEntryToPem(jwk: AppleJwkEntry): string | null {
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    if (
      key.asymmetricKeyType !== 'rsa' ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_MODULUS_BITS
    ) {
      return null;
    }
    return key.export({ type: 'spki', format: 'pem' }).toString();
  } catch {
    return null;
  }
}

/**
 * Fetches Apple's key set and turns it into `{ kid, pem }` pairs. Entries this
 * module cannot use — another key type, a missing member, unusable key
 * material — are dropped; a body that is not the expected envelope, or that
 * leaves no usable entry, is a refresh failure. Error messages describe the
 * shape problem only and never include key material.
 */
async function fetchApplePublicKeys(): Promise<ApplePublicKey[]> {
  const response = await fetch(appleJwksUrl(), {
    signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Apple JWKS: ${response.status}`);
  }

  const parsed = appleJwksResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Malformed Apple JWKS response: expected an object with a keys array');
  }

  const keys: ApplePublicKey[] = [];
  for (const entry of parsed.data.keys) {
    const jwk = appleJwkSchema.safeParse(entry);
    if (!jwk.success) continue;
    const pem = jwkEntryToPem(jwk.data);
    if (pem) {
      keys.push({ kid: jwk.data.kid, pem });
    }
  }
  if (keys.length === 0) {
    throw new Error('Malformed Apple JWKS response: no usable RSA key');
  }
  return keys;
}

async function refreshAppleKeys(): Promise<ApplePublicKey[]> {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  const now = Date.now();
  if (now - lastRefreshStartedAt < REFRESH_COOLDOWN_MS) {
    if (cachedKeys && now - cachedKeys.fetchedAt <= STALE_CACHE_MAX_AGE_MS) {
      return cachedKeys.keys;
    }
    throwJwksUnavailable();
  }

  lastRefreshStartedAt = now;
  const inFlight = (async () => {
    try {
      const keys = await fetchApplePublicKeys();
      cachedKeys = { keys, fetchedAt: Date.now() };
      lastRefreshError = null;
      refreshOutageReported = false;
      return keys;
    } catch (error) {
      lastRefreshError = error;
      if (cachedKeys && Date.now() - cachedKeys.fetchedAt <= STALE_CACHE_MAX_AGE_MS) {
        // Serve the still-present key set, at most STALE_CACHE_MAX_AGE_MS
        // after the last successful fetch; the next attempt stays on the
        // refresh cooldown while lastRefreshError records the failure. The
        // report state is not reset here: one outage reports once, not once
        // per failed attempt.
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

async function getApplePublicKeys(): Promise<ApplePublicKey[]> {
  if (cachedKeys && Date.now() - cachedKeys.fetchedAt < CACHE_TTL_MS) {
    return cachedKeys.keys;
  }
  return refreshAppleKeys();
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
 * A failed refresh that still serves the cached key set is reported to Sentry
 * once per outage: the first request that disposes of the failure reports it —
 * the module when a token verifies against the fallback set, the receiving route
 * when the error propagates — and later attempts in the same outage add no
 * module report.
 * A key set is validated and converted to PEM during the refresh: a body that
 * is not the expected envelope, or that leaves no usable RSA key, counts as a
 * failed refresh like a fetch error and never replaces a healthy cache.
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
        throwJwksUnavailable();
      }
      throw new AppleJwtClientError('No matching Apple public key');
    }
  }

  if (lastRefreshError !== null && !refreshOutageReported) {
    refreshOutageReported = true;
    captureException(lastRefreshError, { tags: { source: 'apple_jwks_refresh' } });
  }

  let payload: string | jwt.JwtPayload;
  try {
    payload = jwt.verify(token, matchingKey.pem, {
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
