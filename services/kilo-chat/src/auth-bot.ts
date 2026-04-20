import { createMiddleware } from 'hono/factory';
import { extractBearerToken } from '@kilocode/worker-utils';
import { deriveGatewayToken } from './lib/gateway-token';
import type { AuthContext } from './auth';
import { SANDBOX_ID_PATTERN } from './routes/schemas';

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
  const sandboxId = c.req.param('sandboxId');
  if (!sandboxId || !SANDBOX_ID_PATTERN.test(sandboxId)) {
    return c.json({ error: 'Invalid sandboxId' }, 400);
  }

  const token = extractBearerToken(c.req.header('authorization'));
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const secret = await c.env.GATEWAY_TOKEN_SECRET.get();
  if (!secret) {
    return c.json({ error: 'Configuration error' }, 503);
  }

  const expected = await deriveGatewayToken(sandboxId, secret);
  if (!(await timingSafeEqual(token, expected))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  c.set('callerId', `bot:kiloclaw:${sandboxId}`);
  c.set('callerKind', 'bot');
  c.set('allowedSandboxIds', []);
  return next();
});
