/**
 * PKCE (RFC 7636) primitives for the MCP OAuth flow. S256 is the only
 * challenge method this server accepts (MCP requires PKCE with S256).
 *
 * Digests go through WebCrypto; comparisons are constant-time so a failed
 * verifier leaks no byte-level timing signal.
 */

/** code_challenge: base64url of a SHA-256 digest — 43 chars; length 43..128 tolerated per RFC 7636 §4.2. */
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

/** code_verifier: [A-Za-z0-9\-._~], 43..128 chars (RFC 7636 §4.1). */
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidCodeChallenge(challenge: string | null | undefined): challenge is string {
  return typeof challenge === 'string' && CODE_CHALLENGE_PATTERN.test(challenge);
}

export function isValidCodeVerifier(verifier: string | null | undefined): verifier is string {
  return typeof verifier === 'string' && CODE_VERIFIER_PATTERN.test(verifier);
}

/** BASE64URL(SHA-256(verifier)) — the S256 transformation. */
export async function codeChallengeFromVerifier(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** True when `verifier` hashes to `challenge` under S256. */
export async function verifyPkceS256(verifier: string, challenge: string): Promise<boolean> {
  const computed = await codeChallengeFromVerifier(verifier);
  const encoder = new TextEncoder();
  return constantTimeBytesEqual(encoder.encode(challenge), encoder.encode(computed));
}

/** Cryptographically random PKCE verifier (test helpers + future client-side use). */
export function generateCodeVerifier(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return base64UrlEncode(bytes);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  try {
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Length-checked constant-time byte equality (no `crypto.subtle.timingSafeEqual` dependency). */
export function constantTimeBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
