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

export type SignedTokenVerificationFailureReason =
  | 'token_missing'
  | 'token_malformed'
  | 'signature_invalid'
  | 'token_expired'
  | 'token_from_future'
  | 'payload_invalid';

export type SignedTokenVerificationResult<T> =
  | { status: 'valid'; value: T }
  | { status: 'invalid'; reason: SignedTokenVerificationFailureReason };

type SignedTokenVerificationOptions<T> = {
  ttlSeconds: number;
  parse: (payload: Record<string, unknown>) => T | null;
};

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
  options: SignedTokenVerificationOptions<T>
): T | null {
  const result = verifySignedTokenDetailed(token, options);
  return result.status === 'valid' ? result.value : null;
}

export function verifySignedTokenDetailed<T>(
  token: string | null,
  options: SignedTokenVerificationOptions<T>
): SignedTokenVerificationResult<T> {
  if (!token) return { status: 'invalid', reason: 'token_missing' };

  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return { status: 'invalid', reason: 'token_malformed' };

  const encodedPayload = token.slice(0, dotIndex);
  const providedSig = token.slice(dotIndex + 1);
  const expectedSig = hmacSign(encodedPayload);
  const providedSigBytes = Buffer.from(providedSig);
  const expectedSigBytes = Buffer.from(expectedSig);

  if (
    providedSigBytes.length !== expectedSigBytes.length ||
    !crypto.timingSafeEqual(providedSigBytes, expectedSigBytes)
  ) {
    return { status: 'invalid', reason: 'signature_invalid' };
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { status: 'invalid', reason: 'payload_invalid' };
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return { status: 'invalid', reason: 'payload_invalid' };
  }

  let value: T | null;
  try {
    value = options.parse(payload);
  } catch {
    return { status: 'invalid', reason: 'payload_invalid' };
  }
  if (value === null) return { status: 'invalid', reason: 'payload_invalid' };

  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
    return { status: 'invalid', reason: 'payload_invalid' };
  }

  if (typeof payload.nonce !== 'string' || payload.nonce.length === 0) {
    return { status: 'invalid', reason: 'payload_invalid' };
  }

  const ageSeconds = Math.floor(Date.now() / 1000) - payload.iat;
  if (ageSeconds < 0) return { status: 'invalid', reason: 'token_from_future' };
  if (ageSeconds > options.ttlSeconds) return { status: 'invalid', reason: 'token_expired' };

  return { status: 'valid', value };
}
