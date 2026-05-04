import { createMiddleware } from 'hono/factory';
import type { Env } from '../env';

/**
 * HMAC signature verification for bench → cloud ingest calls.
 *
 * The bench service (backend/app.py on bench.s1lv.com) signs the raw
 * request body with a shared secret and includes the signature + a
 * timestamp in request headers:
 *
 *     X-Ingest-Signature: <hex(hmac_sha256(SECRET, body))>
 *     X-Ingest-Timestamp: <unix seconds>
 *
 * This middleware:
 *
 * 1. Rejects requests whose timestamp is more than `MAX_SKEW_SECONDS`
 *    out of sync with the worker's wall clock — limits the replay
 *    window if a signature is ever captured in transit.
 * 2. Recomputes the HMAC over the raw body and compares in constant
 *    time. A mismatch is indistinguishable from a missing secret from
 *    the client's perspective (both are 401) to avoid leaking which
 *    check failed.
 * 3. Caches the raw body on the Hono context as `c.var.rawBody` so
 *    downstream handlers can parse it as JSON without re-reading the
 *    request stream (which can only be read once in Workers runtime).
 *
 * NOTE: there is no per-user auth here. The bench dashboard already
 * gates operators via oauth2-proxy to @kilocode.ai; cloud trusts the
 * bench service as a whole. The `promoted_by_email` field in the
 * payload is informational audit data, not a claim cloud validates.
 */

const MAX_SKEW_SECONDS = 5 * 60; // 5 minutes

/** Exported for tests. Converts a hex string to a Uint8Array. */
export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) return null;
    out[i] = b;
  }
  return out;
}

/** Compute HMAC-SHA-256 over `body` using `secret`. Exported for tests. */
export async function computeSignature(secret: string, body: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return new Uint8Array(sig);
}

/**
 * Constant-time byte-array compare.
 *
 * Workers runtime exposes `crypto.subtle.timingSafeEqual`, but that's a
 * Cloudflare extension and doesn't exist under Node (which the unit
 * tests run on). A branch-free XOR loop works identically in both
 * environments and is a few lines — worth the portability.
 */
function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export const hmacAuthMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: {
    rawBody: string;
  };
}>(async (c, next) => {
  const signatureHex = c.req.header('X-Ingest-Signature');
  const timestampHeader = c.req.header('X-Ingest-Timestamp');

  if (!signatureHex || !timestampHeader) {
    return c.json({ success: false, error: 'Missing signature or timestamp' }, 401);
  }

  const timestamp = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(timestamp)) {
    return c.json({ success: false, error: 'Invalid timestamp' }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > MAX_SKEW_SECONDS) {
    return c.json({ success: false, error: 'Timestamp out of allowed skew window' }, 401);
  }

  const signatureBytes = hexToBytes(signatureHex);
  if (!signatureBytes) {
    return c.json({ success: false, error: 'Invalid signature encoding' }, 401);
  }

  const secret = await c.env.MODEL_EVAL_INGEST_SECRET.get();
  if (!secret) {
    // Logged; the client sees a generic 401 so we don't distinguish
    // "cloud is misconfigured" from "caller has no access".
    console.error('MODEL_EVAL_INGEST_SECRET is not configured');
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const body = await c.req.text();
  const expected = await computeSignature(secret, body);

  if (!timingSafeEqualBytes(signatureBytes, expected)) {
    return c.json({ success: false, error: 'Invalid signature' }, 401);
  }

  c.set('rawBody', body);
  return next();
});
