import { base64url } from 'jose';
import { z } from 'zod';

/**
 * Compact JWS decoding for access tokens and signed feed heads. Each part is decoded once; the
 * caller checks the header, verifies the signature over the exact received bytes, and validates
 * the payload it got here, so nothing is decoded twice.
 */

const HeaderSchema = z.record(z.string(), z.unknown());

export type DecodedJws = {
  header: Record<string, unknown>;
  /** The parsed payload JSON; any JSON value. */
  payload: unknown;
  /** `<header>.<payload>` as received: the bytes the signature covers. */
  signingInput: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
};

/** Splits and decodes a compact JWS; null when it is not three base64url JSON parts. */
export function decodeJws(compact: string): DecodedJws | null {
  const parts = compact.split('.');
  if (parts.length !== 3) return null;
  const [headerPart = '', payloadPart = '', signaturePart = ''] = parts;
  const text = new TextDecoder();
  try {
    const header = HeaderSchema.safeParse(JSON.parse(text.decode(base64url.decode(headerPart))));
    if (!header.success) return null;
    return {
      header: header.data,
      payload: JSON.parse(text.decode(base64url.decode(payloadPart))),
      signingInput: new TextEncoder().encode(`${headerPart}.${payloadPart}`),
      signature: new Uint8Array(base64url.decode(signaturePart)),
    };
  } catch {
    return null;
  }
}

/**
 * Whether the header names a JWS extension. `crit` (RFC 7515 4.1.11) and `b64` (RFC 7797) change
 * how a JWS is processed; no Kilo issuer uses them, so a header with either is refused.
 */
export function hasJwsExtension(header: Record<string, unknown>): boolean {
  return Object.hasOwn(header, 'crit') || Object.hasOwn(header, 'b64');
}

/** Ed25519 verification of `jws` under `key`; false for a bad signature of any length. */
export async function verifyEd25519(key: CryptoKey, jws: DecodedJws): Promise<boolean> {
  try {
    return await crypto.subtle.verify('Ed25519', key, jws.signature, jws.signingInput);
  } catch {
    return false;
  }
}
