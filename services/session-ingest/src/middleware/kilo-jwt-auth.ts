import { createMiddleware } from 'hono/factory';
import { extractBearerToken } from '@kilocode/worker-utils';
import { verifyKiloBearerAgainstCurrentPepper } from '@kilocode/worker-utils/kilo-token-auth';

import type { Env } from '../env';

export const kiloJwtAuthMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: {
    user_id: string;
  };
}>(async (c, next) => {
  // One-use web ticket path. The /api/user/web websocket upgrade consumes an
  // opaque ticket minted by POST /api/user/web-ticket. This branch runs before
  // the JWT path so a missing ticket is not mistaken for a missing JWT, and so
  // the Authorization header / ?token= query are never read on this path.
  if (c.req.header('Upgrade') === 'websocket' && c.req.path === '/api/user/web') {
    const ticket = c.req.query('ticket');
    if (!ticket) {
      return c.json({ success: false, error: 'Missing or invalid ticket' }, 401);
    }

    const stub = c.env.CONNECTION_TICKET_DO.get(c.env.CONNECTION_TICKET_DO.idFromName(ticket));
    const consumed = await stub.consume();
    if (!consumed) {
      return c.json({ success: false, error: 'Invalid or expired ticket' }, 401);
    }

    c.set('user_id', consumed.userId);
    return next();
  }

  let token = extractBearerToken(c.req.header('Authorization'));
  if (!token && c.req.header('Upgrade') === 'websocket') {
    token = c.req.query('token') ?? null;
  }

  if (!token) {
    return c.json({ success: false, error: 'Missing or malformed Authorization header' }, 401);
  }

  const auth = await verifyKiloBearerAgainstCurrentPepper({
    token,
    nextAuthSecret: c.env.NEXTAUTH_SECRET_PROD,
    connectionString: c.env.HYPERDRIVE.connectionString,
  });

  if (!auth) {
    return c.json({ success: false, error: 'Invalid or expired token' }, 401);
  }

  c.set('user_id', auth.userId);
  return next();
});
