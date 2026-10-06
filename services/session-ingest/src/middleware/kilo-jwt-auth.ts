import { createMiddleware } from 'hono/factory';
import { extractBearerToken, getCachedSecret } from '@kilocode/worker-utils';
import {
  SESSION_INGEST_AUDIENCE,
  SESSION_INGEST_USER_DELETION_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  verifyKiloBearerAgainstCurrentPepperWithOutcome,
  type KiloBearerRejectionReason,
  type KiloBearerTokenVerificationFailure,
} from '@kilocode/worker-utils/kilo-token-auth';
import {
  CloudAgentNextRuntimeAuthorizationClaimSchema,
  RUNTIME_PROXY_ATTESTATION_HEADER,
  verifyRuntimeProxyAttestation,
} from '@kilocode/worker-utils/runtime-proxy-attestation';
import { decodeJwt } from 'jose';

import type { Env } from '../env';

export type KiloJwtAuthVariables = {
  user_id: string;
  deletionAudience?: boolean;
};

const SESSION_LEAF_DELETE_PATH = /^\/api\/session\/[^/]+$/;

function isSessionLeafDelete(method: string, path: string): boolean {
  return method === 'DELETE' && SESSION_LEAF_DELETE_PATH.test(path);
}

type KiloJwtAuthLogReason =
  | 'missing_ticket'
  | 'invalid_ticket'
  | 'missing_bearer'
  | 'invalid_token'
  | 'invalid_runtime_attestation';

/**
 * One claim predicate shared by the attestation guard and the rejection log, so
 * the two cannot disagree about whether a bearer carries a runtime-authorization
 * claim. A falsy or undecodable token is not claim-bearing.
 */
function parseRuntimeAuthorizationClaim(token: string | null) {
  if (!token) return null;
  try {
    return CloudAgentNextRuntimeAuthorizationClaimSchema.safeParse(
      decodeJwt(token).runtimeAuthorization
    );
  } catch {
    return null;
  }
}

/**
 * Bounded, credential-free rejection log. Only the allowlisted fields below are
 * emitted: no token, header value, body, cookie, user id, session id, error
 * object or message. Observability must never change the response, so this
 * swallows any logging failure.
 */
function logKiloJwtAuthRejection(fields: {
  reason: KiloJwtAuthLogReason;
  token?: string | null;
  hasAttestationHeader: boolean;
  tokenRejectionReason?: KiloBearerRejectionReason;
  verificationFailure?: KiloBearerTokenVerificationFailure;
}): void {
  try {
    console.warn('Kilo JWT auth rejected', {
      event: 'kilo_jwt_auth_rejected',
      reason: fields.reason,
      ...(fields.token !== undefined
        ? {
            hasBearer: Boolean(fields.token),
            hasRuntimeAuthorizationClaim:
              parseRuntimeAuthorizationClaim(fields.token)?.success === true,
          }
        : {}),
      hasAttestationHeader: fields.hasAttestationHeader,
      ...(fields.tokenRejectionReason ? { tokenRejectionReason: fields.tokenRejectionReason } : {}),
      ...(fields.verificationFailure
        ? { tokenVerificationFailure: fields.verificationFailure }
        : {}),
    });
  } catch {
    // Logging failures are ignored so the auth outcome is never affected.
  }
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
      // The bearer-derived fields are not evaluated on the ticket path: they
      // mean "not evaluated", not "no bearer was presented".
      logKiloJwtAuthRejection({
        reason: 'missing_ticket',
        hasAttestationHeader: c.req.header(RUNTIME_PROXY_ATTESTATION_HEADER) !== undefined,
      });
      return c.json({ success: false, error: 'Missing or invalid ticket' }, 401);
    }

    const stub = c.env.CONNECTION_TICKET_DO.get(c.env.CONNECTION_TICKET_DO.idFromName(ticket));
    const consumed = await stub.consume();
    if (!consumed) {
      logKiloJwtAuthRejection({
        reason: 'invalid_ticket',
        hasAttestationHeader: c.req.header(RUNTIME_PROXY_ATTESTATION_HEADER) !== undefined,
      });
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
    logKiloJwtAuthRejection({
      reason: 'missing_bearer',
      token,
      hasAttestationHeader: c.req.header(RUNTIME_PROXY_ATTESTATION_HEADER) !== undefined,
    });
    return c.json({ success: false, error: 'Missing or malformed Authorization header' }, 401);
  }

  let auth;
  let deletionAudience = false;
  let invalidTokenReason: KiloBearerRejectionReason | undefined;
  let invalidTokenVerificationFailure: KiloBearerTokenVerificationFailure | undefined;
  try {
    const deletionOutcome = await verifyKiloBearerAgainstCurrentPepperWithOutcome({
      token,
      nextAuthSecret: c.env.NEXTAUTH_SECRET_PROD,
      connectionString: c.env.HYPERDRIVE.connectionString,
      audience: SESSION_INGEST_USER_DELETION_AUDIENCE,
      allowBlocked: true,
    });
    if (deletionOutcome.ok) {
      if (!isSessionLeafDelete(c.req.method, c.req.path)) {
        return c.json(
          { success: false, error: 'Deletion token cannot be used for this request' },
          403
        );
      }
      auth = deletionOutcome.auth;
      deletionAudience = true;
    } else {
      const genericOutcome = await verifyKiloBearerAgainstCurrentPepperWithOutcome({
        token,
        nextAuthSecret: c.env.NEXTAUTH_SECRET_PROD,
        connectionString: c.env.HYPERDRIVE.connectionString,
        resourceAudience: { audience: SESSION_INGEST_AUDIENCE, mode: 'allow-legacy' },
      });
      if (genericOutcome.ok) {
        auth = genericOutcome.auth;
      } else {
        // Only the generic attempt's rejection reaches the log; the
        // deletion-audience attempt's own failure is never reported.
        invalidTokenReason = genericOutcome.reason;
        invalidTokenVerificationFailure = genericOutcome.verificationFailure;
      }
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
    logKiloJwtAuthRejection({
      reason: 'invalid_token',
      token,
      hasAttestationHeader: c.req.header(RUNTIME_PROXY_ATTESTATION_HEADER) !== undefined,
      tokenRejectionReason: invalidTokenReason,
      verificationFailure: invalidTokenVerificationFailure,
    });
    return c.json({ success: false, error: 'Invalid or expired token' }, 401);
  }

  const runtimeAuthorization = parseRuntimeAuthorizationClaim(token);
  if (runtimeAuthorization?.success) {
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
      logKiloJwtAuthRejection({
        reason: 'invalid_runtime_attestation',
        token,
        hasAttestationHeader: c.req.header(RUNTIME_PROXY_ATTESTATION_HEADER) !== undefined,
      });
      return c.json({ success: false, error: 'Invalid runtime proxy attestation' }, 401);
    }
  }

  c.set('user_id', auth.userId);
  c.set('deletionAudience', deletionAudience);
  return next();
});
