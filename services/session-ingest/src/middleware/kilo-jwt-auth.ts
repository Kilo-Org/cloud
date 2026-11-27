import { createMiddleware } from 'hono/factory';
import { extractBearerToken, getCachedSecret } from '@kilocode/worker-utils';
import {
  SESSION_INGEST_AUDIENCE,
  SESSION_INGEST_USER_DELETION_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import { verifyKiloBearerOrInternalAssertionAgainstCurrentPepper } from '@kilocode/worker-utils/kilo-token-auth';
import {
  CloudAgentNextRuntimeAuthorizationClaimSchema,
  RUNTIME_PROXY_ATTESTATION_HEADER,
  verifyRuntimeProxyAttestation,
} from '@kilocode/worker-utils/runtime-proxy-attestation';
import { decodeJwt } from 'jose';

import type { Env } from '../env';
import { resolveConnectionTicket } from '../dos/connection-ticket';

export type KiloJwtAuthVariables = {
  user_id: string;
  deletionAudience?: boolean;
};

const SESSION_LEAF_DELETE_PATH = /^\/api\/session\/[^/]+$/;
const CLI_WEBSOCKET_PATH = '/api/user/cli';

function isSessionLeafDelete(method: string, path: string): boolean {
  return method === 'DELETE' && SESSION_LEAF_DELETE_PATH.test(path);
}

// The CLI client (kilocode packages/opencode/src/kilo-sessions/remote-ws.ts)
// treats close codes 4401, 4403 and 4409 as permanent, but an HTTP status before
// the upgrade only reaches it as an abnormal close (1006), which it retries with
// backoff forever. A websocket that fails authentication is therefore accepted
// and immediately closed with 4401 so a stale token stops retrying.
function rejectCliWebsocket(): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].close(4401, 'unauthorized');
  return new Response(null, { status: 101, webSocket: pair[0] });
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

    const resolved = resolveConnectionTicket(c.env.CONNECTION_TICKET_DO, ticket);
    const consumed = resolved ? await resolved.stub.consume(resolved.secret) : null;
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

  const cliWebsocketUpgrade =
    c.req.method === 'GET' &&
    c.req.path === CLI_WEBSOCKET_PATH &&
    c.req.header('Upgrade') === 'websocket';

  if (!token) {
    if (cliWebsocketUpgrade) return rejectCliWebsocket();
    return c.json({ success: false, error: 'Missing or malformed Authorization header' }, 401);
  }

  let auth;
  let deletionAudience = false;
  try {
    const deletionAuth = await verifyKiloBearerOrInternalAssertionAgainstCurrentPepper({
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
      auth = await verifyKiloBearerOrInternalAssertionAgainstCurrentPepper({
        token,
        nextAuthSecret: c.env.NEXTAUTH_SECRET_PROD,
        connectionString: c.env.HYPERDRIVE.connectionString,
        resourceAudience: { audience: SESSION_INGEST_AUDIENCE, mode: 'allow-legacy' },
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
    if (cliWebsocketUpgrade) return rejectCliWebsocket();
    return c.json({ success: false, error: 'Invalid or expired token' }, 401);
  }

  const runtimeAuthorization = CloudAgentNextRuntimeAuthorizationClaimSchema.safeParse(
    decodeJwt(token).runtimeAuthorization
  );
  if (runtimeAuthorization.success) {
    let attested: boolean;
    try {
      const secret = await getCachedSecret(c.env.NEXTAUTH_SECRET_PROD, 'NEXTAUTH_SECRET');
      attested = await verifyRuntimeProxyAttestation({
        value: c.req.header(RUNTIME_PROXY_ATTESTATION_HEADER),
        secret,
        audience: SESSION_INGEST_AUDIENCE,
        userId: auth.userId,
        authorizationId: runtimeAuthorization.data.id,
        resourceId: runtimeAuthorization.data.resourceId,
        bearer: token,
      });
    } catch (error) {
      console.error('Auth infrastructure failure', {
        operation: 'runtime-proxy-attestation-verify',
        errorClass: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return c.json({ success: false, error: 'Service temporarily unavailable' }, 503);
    }
    if (!attested) {
      return c.json({ success: false, error: 'Invalid runtime proxy attestation' }, 401);
    }
  }

  c.set('user_id', auth.userId);
  c.set('deletionAudience', deletionAudience);
  return next();
});
