import { LRUCache } from 'lru-cache';

const tokenCache = new LRUCache<string, string>({
  max: 1024,
  ttl: 5 * 60 * 1000,
});

/**
 * Per-sandbox gateway token derivation using Web Crypto HMAC.
 * Identical to services/kiloclaw/src/auth/gateway-token.ts — kept in
 * sync manually (10 lines, not worth a shared package).
 *
 * Results are cached per sandboxId since the derivation is deterministic
 * and the secret doesn't change within an isolate's lifetime.
 */
export async function deriveGatewayToken(sandboxId: string, secret: string): Promise<string> {
  const cacheKey = `${sandboxId}\0${secret}`;
  const cached = tokenCache.get(cacheKey);
  if (cached) return cached;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sandboxId));
  const token = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  tokenCache.set(cacheKey, token);
  return token;
}
