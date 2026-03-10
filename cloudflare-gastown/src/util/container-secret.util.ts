/**
 * Container secret — HMAC-based authentication for container→worker API calls.
 *
 * Replaces the per-agent JWT system with a per-container shared secret that
 * never expires (lives as long as the container). When the container sleeps
 * and restarts, a new secret is minted automatically.
 *
 * Token format: `<townId>:<nonce>:<hmac-hex>`
 *   - townId: scopes the token to a specific town
 *   - nonce: random UUID, unique per container boot
 *   - hmac: HMAC-SHA256(secret, townId + ":" + nonce) — proves the worker minted it
 *
 * Verification is stateless — no DO lookup needed. The worker checks the HMAC
 * using the shared GASTOWN_JWT_SECRET (same key used for agent JWTs).
 */

import { z } from 'zod';

const encoder = new TextEncoder();

async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacVerify(secret: string, data: string, signature: string): Promise<boolean> {
  const expected = await hmacSign(secret, data);
  // Constant-time comparison to prevent timing attacks
  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Mint a container secret token. Called once per container boot.
 * The token has no expiry — it lives as long as the container does.
 */
export async function mintContainerSecret(jwtSecret: string, townId: string): Promise<string> {
  const nonce = crypto.randomUUID();
  const data = `${townId}:${nonce}`;
  const hmac = await hmacSign(jwtSecret, data);
  return `${townId}:${nonce}:${hmac}`;
}

/** Parsed and verified container secret payload. */
export const ContainerSecretPayload = z.object({
  townId: z.string(),
  nonce: z.string(),
});
export type ContainerSecretPayload = z.infer<typeof ContainerSecretPayload>;

/**
 * Verify a container secret token. Stateless — only needs the shared secret.
 * Returns the parsed payload on success, or an error string on failure.
 */
export async function verifyContainerSecret(
  token: string,
  jwtSecret: string
): Promise<{ success: true; payload: ContainerSecretPayload } | { success: false; error: string }> {
  const parts = token.split(':');
  if (parts.length !== 3) {
    return { success: false, error: 'Invalid token format' };
  }
  const [townId, nonce, hmac] = parts;
  if (!townId || !nonce || !hmac) {
    return { success: false, error: 'Invalid token format' };
  }

  const data = `${townId}:${nonce}`;
  const valid = await hmacVerify(jwtSecret, data, hmac);
  if (!valid) {
    return { success: false, error: 'Invalid token signature' };
  }

  return { success: true, payload: { townId, nonce } };
}
