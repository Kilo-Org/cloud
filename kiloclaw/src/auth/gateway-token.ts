/**
 * Per-sandbox gateway token derivation using Web Crypto HMAC.
 *
 * Each sandbox gets a deterministic token derived from its sandboxId
 * and the worker's GATEWAY_TOKEN_SECRET. This replaces the single
 * shared OPENCLAW_GATEWAY_TOKEN from the single-tenant setup.
 */
export async function deriveGatewayToken(sandboxId: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sandboxId));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
