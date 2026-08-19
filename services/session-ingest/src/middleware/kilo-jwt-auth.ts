import { createMiddleware } from 'hono/factory';
import { extractBearerToken } from '@kilocode/worker-utils';
import { SESSION_INGEST_USER_DELETION_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { verifyKiloBearerAgainstCurrentPepper } from '@kilocode/worker-utils/kilo-token-auth';

import type { Env } from '../env';

export type KiloJwtAuthVariables = {
  user_id: string;
  deletionAudience?: boolean;
};

const SESSION_LEAF_DELETE_PATH = /^\/api\/session\/[^/]+$/;

function isSessionLeafDelete(method: string, path: string): boolean {
  return method === 'DELETE' && SESSION_LEAF_DELETE_PATH.test(path);
}

export const kiloJwtAuthMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: KiloJwtAuthVariables;
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

  let auth;
  let deletionAudience = false;
  try {
    const deletionAuth = await verifyKiloBearerAgainstCurrentPepper({
      token,
      nextAuthSecret: c.env.NEXTAUTH_SECRET_PROD,
      connectionString: c.env.HYPERDRIVE.connectionString,
      audience: SESSION_INGEST_USER_DELETION_AUDIENCE,
      allowBlocked: true,
    });
    if (deletionAuth) {
      if (!isSessionLeafDelete(c.req.method, c.req.path)) {
        return c.json(
          { success: false, error: 'Deletion token cannot be used for this request' },
          403
        );
      }
      auth = deletionAuth;
      deletionAudience = true;
    } else {
      auth = await verifyKiloBearerAgainstCurrentPepper({
        token,
        nextAuthSecret: c.env.NEXTAUTH_SECRET_PROD,
        connectionString: c.env.HYPERDRIVE.connectionString,
      });
    }
  } catch (error) {
    // Secret-store or database failure. Stay retryable: a 401 here would tell
    // the client its credential is bad and stop it from retrying.
    console.error('Auth infrastructure failure', {
      operation: 'kilo-bearer-verify',
      errorClass: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return c.json({ success: false, error: 'Service temporarily unavailable' }, 503);
  }

  if (!auth) {
    return c.json({ success: false, error: 'Invalid or expired token' }, 401);
  }

  c.set('user_id', auth.userId);
  c.set('deletionAudience', deletionAudience);
  return next();
});
