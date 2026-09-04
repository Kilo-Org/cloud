import 'server-only';
import crypto from 'node:crypto';
import { NEXTAUTH_SECRET } from '@/lib/config.server';

const HMAC_ALGORITHM = 'sha256';
const NONCE_BYTES = 16;

function hmacSign(data: string): string {
  return crypto.createHmac(HMAC_ALGORITHM, NEXTAUTH_SECRET).update(data).digest('base64url');
}

/**
 * Create an HMAC-signed, time-limited token encoding `payload`.
 *
 * The token also carries an issued-at timestamp and a random nonce, so a
 * behavior change to the signing scheme, expiry policy, or wire format should
 * be applied here once rather than in every signed-token caller.
 *
 * Wire format: `base64url(JSON({ ...payload, iat, nonce })).HMAC-SHA256(...)`.
 */
export function createSignedToken(payload: Record<string, unknown>): string {
  const body = {
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    nonce: crypto.randomBytes(NONCE_BYTES).toString('base64url'),
  };
  const encodedPayload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${encodedPayload}.${hmacSign(encodedPayload)}`;
}

/**
 * Verify a signed token's signature, age, and nonce, then shape-validate it
 * via `parse`. `parse` receives the decoded payload and returns a domain
 * object or `null`.
 *
 * Returns `null` when the token is missing, malformed, tampered with, stale,
 * or rejected by `parse`.
 */
export function verifySignedToken<T>(
  token: string | null,
  options: { ttlSeconds: number; parse: (payload: Record<string, unknown>) => T | null }
): T | null {
  if (!token) return null;

  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return null;

  const encodedPayload = token.slice(0, dotIndex);
  const providedSig = token.slice(dotIndex + 1);
  const expectedSig = hmacSign(encodedPayload);

  if (
    providedSig.length !== expectedSig.length ||
    !crypto.timingSafeEqual(Buffer.from(providedSig), Buffer.from(expectedSig))
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;

    if (typeof payload.iat !== 'number') return null;

    const ageSeconds = Math.floor(Date.now() / 1000) - payload.iat;
    if (ageSeconds < 0 || ageSeconds > options.ttlSeconds) return null;

    if (typeof payload.nonce !== 'string' || payload.nonce.length === 0) return null;

    return options.parse(payload);
  } catch {
    return null;
  }
}
