import { createMiddleware } from 'hono/factory';
import { extractBearerToken, verifyKiloToken } from '@kilocode/worker-utils';

export type AuthContext = {
  callerId: string;
  callerKind: 'user' | 'bot';
};

/**
 * Public HTTP auth for kilo-chat. Only humans authenticate over HTTP; their
 * bearer is a Kilo JWT verified with NEXTAUTH_SECRET.
 *
 * Bots (kiloclaw sandboxes) do NOT come in here. They reach the bot surface
 * exclusively via the kilo-chat WorkerEntrypoint's RPC methods, invoked from
 * the kiloclaw CF Worker over a trusted service binding after kiloclaw has
 * verified the caller's per-sandbox gateway token. There is no shared API
 * token to leak and no `x-kilo-sandbox-id` header to spoof.
 */
export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: AuthContext;
}>(async (c, next) => {
  const token = extractBearerToken(c.req.header('authorization'));
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const jwtSecret = await c.env.NEXTAUTH_SECRET.get();
    if (!jwtSecret) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const payload = await verifyKiloToken(token, jwtSecret);
    c.set('callerId', payload.kiloUserId);
    c.set('callerKind', 'user');
    return next();
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }
});
