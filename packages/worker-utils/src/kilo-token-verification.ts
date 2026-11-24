import { decodeProtectedHeader, errors, jwtVerify } from 'jose';
import type { JSONWebKeySet, JWTPayload } from 'jose';
import { validateCloudAgentAuthorityClaims } from './cloud-agent-authority';
import type { KiloTokenAcceptedIssuers, KiloTokenIssuerId } from './kilo-token-issuers';

export type KiloTokenKeyMaterial = {
  /** The shared HS256 secret (`NEXTAUTH_SECRET`) that signs every Kilo token today. */
  legacyHs256Secret: string;
  /** Public keys of every issuer. Not read yet: ES256 tokens are refused until it is wired. */
  publicJwks?: JSONWebKeySet;
};

export type KiloTokenAlgorithmLabel = 'HS256' | 'ES256' | 'none' | 'other' | 'malformed';

export type KiloTokenAudienceForm = 'absent' | 'string' | 'array';

export type KiloTokenLifetimeBucket =
  | 'unknown'
  | 'up-to-5m'
  | 'up-to-1h'
  | 'up-to-1d'
  | 'up-to-30d'
  | 'up-to-1y'
  | 'over-1y';

export type KiloTokenVerificationRejection =
  | 'malformed'
  | 'unsupported-algorithm'
  | 'invalid-signature'
  | 'expired'
  | 'invalid-claims'
  | 'other';

/**
 * One signature verification, without user IDs or token content. Claim
 * presence is reported only for verified tokens.
 */
export type KiloTokenVerificationEvent =
  | {
      outcome: 'verified';
      alg: 'HS256' | 'ES256';
      issuer: KiloTokenIssuerId | 'legacy';
      expectedAudience: string | null;
      audienceForm: KiloTokenAudienceForm;
      lifetimeBucket: KiloTokenLifetimeBucket;
      hasTokenPurpose: boolean;
      hasBotId: boolean;
      hasInternalApiUse: boolean;
    }
  | {
      outcome: 'rejected';
      reason: KiloTokenVerificationRejection;
      alg: KiloTokenAlgorithmLabel;
      expectedAudience: string | null;
    };

export type KiloTokenVerifier = {
  keys: KiloTokenKeyMaterial;
  /**
   * Issuers this call site accepts. HS256 tokens carry no issuer, so the list
   * applies only to ES256 tokens.
   */
  acceptedIssuers: KiloTokenAcceptedIssuers;
  onVerification?: (event: KiloTokenVerificationEvent) => void;
};

function algorithmLabel(token: string): KiloTokenAlgorithmLabel {
  let alg: unknown;
  try {
    alg = decodeProtectedHeader(token).alg;
  } catch {
    return 'malformed';
  }
  if (alg === 'HS256' || alg === 'ES256' || alg === 'none') return alg;
  return typeof alg === 'string' && alg.length > 0 ? 'other' : 'malformed';
}

function audienceForm(audience: unknown): KiloTokenAudienceForm {
  if (audience === undefined) return 'absent';
  return Array.isArray(audience) ? 'array' : 'string';
}

const lifetimeBuckets: readonly [number, KiloTokenLifetimeBucket][] = [
  [5 * 60, 'up-to-5m'],
  [60 * 60, 'up-to-1h'],
  [24 * 60 * 60, 'up-to-1d'],
  [30 * 24 * 60 * 60, 'up-to-30d'],
  [366 * 24 * 60 * 60, 'up-to-1y'],
];

function lifetimeBucket(payload: JWTPayload): KiloTokenLifetimeBucket {
  if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') return 'unknown';
  const lifetime = payload.exp - payload.iat;
  return lifetimeBuckets.find(([limit]) => lifetime <= limit)?.[1] ?? 'over-1y';
}

function rejectionReason(error: unknown): KiloTokenVerificationRejection {
  if (error instanceof errors.JOSEAlgNotAllowed) return 'unsupported-algorithm';
  if (error instanceof errors.JWSSignatureVerificationFailed) return 'invalid-signature';
  if (error instanceof errors.JWTExpired) return 'expired';
  if (error instanceof errors.JWTClaimValidationFailed) return 'invalid-claims';
  if (error instanceof errors.JWSInvalid || error instanceof errors.JWTInvalid) return 'malformed';
  return 'other';
}

function report(verifier: KiloTokenVerifier, event: KiloTokenVerificationEvent): void {
  try {
    verifier.onVerification?.(event);
  } catch {
    // A failing sink must not change the verification outcome.
  }
}

async function verifyLegacyHs256(
  token: string,
  secret: string,
  options?: { currentDate?: Date; audience?: string; issuer?: string }
): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ['HS256'],
    ...(options?.currentDate === undefined ? {} : { currentDate: options.currentDate }),
    ...(options?.audience === undefined ? {} : { audience: options.audience }),
    ...(options?.issuer === undefined ? {} : { issuer: options.issuer }),
  });
  return payload;
}

/**
 * Verifies a Kilo JWT signature, dispatching on its `alg` header. Only HS256
 * with the legacy secret is accepted; every other algorithm is refused.
 *
 * `currentDate` pins the clock jose validates against; omit it to use the system
 * clock. `audience` and `issuer` delegate those claim checks to jose; omit each
 * to skip it. Each verifier passes only what its own contract requires.
 * `expectedAudience` names the audience a caller checks itself afterwards; it is
 * only reported to `onVerification`.
 */
export async function verifyKiloTokenSignature(
  token: string,
  verifier: KiloTokenVerifier,
  options?: { currentDate?: Date; audience?: string; issuer?: string; expectedAudience?: string }
): Promise<{ payload: JWTPayload }> {
  const alg = algorithmLabel(token);
  const expectedAudience = options?.expectedAudience ?? options?.audience ?? null;
  try {
    if (alg === 'malformed') throw new errors.JWSInvalid('Invalid Compact JWS');
    if (alg !== 'HS256') {
      throw new errors.JOSEAlgNotAllowed('"alg" (Algorithm) Header Parameter value not allowed');
    }
    const payload = await verifyLegacyHs256(token, verifier.keys.legacyHs256Secret, options);
    report(verifier, {
      outcome: 'verified',
      alg,
      issuer: 'legacy',
      expectedAudience,
      audienceForm: audienceForm(payload.aud),
      lifetimeBucket: lifetimeBucket(payload),
      hasTokenPurpose: payload.tokenPurpose !== undefined,
      hasBotId: payload.botId !== undefined,
      hasInternalApiUse: payload.internalApiUse !== undefined,
    });
    return { payload };
  } catch (error) {
    report(verifier, {
      outcome: 'rejected',
      reason: rejectionReason(error),
      alg,
      expectedAudience,
    });
    throw error;
  }
}

/**
 * Validates the `cloudAgentAuthority` claim when the token carries it, and
 * reports whether it was present. A token without the claim passes through
 * untouched.
 */
export function checkKiloTokenAuthorityClaims(payload: JWTPayload): boolean {
  if (!Object.hasOwn(payload, 'cloudAgentAuthority')) return false;
  validateCloudAgentAuthorityClaims(payload);
  return true;
}

export function assertKiloTokenIssuedAt(iat: unknown, nowSeconds: number): void {
  if (typeof iat !== 'number') throw new Error('Missing or invalid token issued-at');
  if (iat > nowSeconds) throw new Error('Token issued in the future');
}
