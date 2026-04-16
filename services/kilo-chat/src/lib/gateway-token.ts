/**
 * Per-sandbox gateway token derivation using Web Crypto HMAC.
 * Identical to services/kiloclaw/src/auth/gateway-token.ts — kept in
 * sync manually (10 lines, not worth a shared package).
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
