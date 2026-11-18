/**
 * Reversible base64url encoding of raw bytes.
 *
 * Uses TextEncoder/TextDecoder-safe byte handling so non-Latin1 byte values
 * encode without throwing. `bytesToBase64url` + `base64urlToBytes` roundtrip
 * any byte sequence.
 */

export function bytesToBase64url(bytes: Uint8Array): string {
  const binString = Array.from(bytes, b => String.fromCodePoint(b)).join('');
  return btoa(binString).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlToBytes(encoded: string): Uint8Array {
  let b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) {
    b64 += '=';
  }
  const binString = atob(b64);
  return Uint8Array.from(binString, c => c.codePointAt(0) ?? 0);
}
