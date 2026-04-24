import { createMiddleware } from 'hono/factory';
import { extractBearerToken, getCachedSecret } from '@kilocode/worker-utils';
import { deriveGatewayToken } from './lib/gateway-token';
import type { AuthContext } from './auth';
import { sandboxIdSchema } from './routes/schemas';

/** Timing-safe string comparison using Web Crypto. */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const ka = await crypto.subtle.importKey(
    'raw',
    enc.encode(a),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const kb = await crypto.subtle.importKey(
    'raw',
    enc.encode(b),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const msg = enc.encode('kilo-chat:timing');
  const [sa, sb] = await Promise.all([
    crypto.subtle.sign('HMAC', ka, msg),
    crypto.subtle.sign('HMAC', kb, msg),
  ]);
  if (sa.byteLength !== sb.byteLength) return false;
  const va = new Uint8Array(sa);
  const vb = new Uint8Array(sb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= (va[i] ?? 0) ^ (vb[i] ?? 0);
  return diff === 0;
}

/**
 * Bot HTTP auth — verifies per-sandbox HMAC gateway token.
 *
 * Expects the route to have a `:sandboxId` param. Derives the expected
 * token from GATEWAY_TOKEN_SECRET and timing-safe compares.
 */
export const botAuthMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: AuthContext;
}>(async (c, next) => {
  const result = sandboxIdSchema.safeParse(c.req.param('sandboxId'));
  if (!result.success) {
    return c.json({ error: 'Invalid sandboxId' }, 400);
  }
  const sandboxId = result.data;

  const token = extractBearerToken(c.req.header('authorization'));
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const secret = await getCachedSecret(c.env.GATEWAY_TOKEN_SECRET, 'GATEWAY_TOKEN_SECRET');

  const expected = await deriveGatewayToken(sandboxId, secret);
  if (!(await timingSafeEqual(token, expected))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  c.set('callerId', `bot:kiloclaw:${sandboxId}`);
  c.set('callerKind', 'bot');
  return next();
});
