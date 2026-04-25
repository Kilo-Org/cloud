import { createMiddleware } from 'hono/factory';
import { extractBearerToken, getCachedSecret } from '@kilocode/worker-utils';
import { logger } from './util/logger';
import { timingSafeEqual } from '@kilocode/encryption';
import { deriveGatewayToken } from './lib/gateway-token';
import type { AuthContext } from './auth';
import { sandboxIdSchema } from '@kilocode/kilo-chat';

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

  let secret: string;
  try {
    secret = await getCachedSecret(c.env.GATEWAY_TOKEN_SECRET, 'GATEWAY_TOKEN_SECRET');
  } catch {
    return c.json({ error: 'Configuration error' }, 503);
  }

  const expected = await deriveGatewayToken(sandboxId, secret);
  if (!timingSafeEqual(token, expected)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  c.set('callerId', `bot:kiloclaw:${sandboxId}`);
  c.set('callerKind', 'bot');
  logger.setTags({ callerId: `bot:kiloclaw:${sandboxId}`, callerKind: 'bot', sandboxId });
  return next();
});
