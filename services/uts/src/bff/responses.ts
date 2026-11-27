import { oauthError } from '../oauth/errors';
import type { WebSession } from './store';

/**
 * Answers of the `kilo-web` endpoints (the browser-session error table of
 * `@kilocode/uts-contracts` `browser-sessions.ts`). Every answer is `no-store`; only 429 and 503
 * carry `Retry-After`, and a client retries only those.
 */

/** Seconds a BFF waits while `kilo-web` is not configured in this environment. */
const UNCONFIGURED_RETRY_AFTER_SECONDS = 60;

/** `kilo-web` is not configured here, or its key set is invalid: 503, never 500. */
export function webClientUnavailable(): Response {
  return oauthError('temporarily_unavailable', 503, 'the web client is not available here', {
    'Retry-After': String(UNCONFIGURED_RETRY_AFTER_SECONDS),
  });
}

/** A missing, bad, expired, replayed or wrong-audience assertion, or an unknown `kid`. */
export function invalidClient(): Response {
  return oauthError('invalid_client', 401, 'client authentication failed');
}

/** The handle names no live session: one answer for every case, so it is no oracle. */
export function invalidSession(): Response {
  return oauthError('invalid_session', 401, 'the session is not live');
}

/** Design 5.11: a step-up lasts 10 minutes, so a scope that needs one asks for that `max_age`. */
const STEP_UP_SECONDS = 600;
const STEP_UP_DESCRIPTION = 'this scope needs a passkey check within the last 10 minutes';

/** RFC 9470: the scope needs a fresher sign-in. */
export function stepUpRequired(): Response {
  return oauthError('insufficient_user_authentication', 401, STEP_UP_DESCRIPTION, {
    'WWW-Authenticate': `Bearer error="insufficient_user_authentication", error_description="${STEP_UP_DESCRIPTION}", max_age="${STEP_UP_SECONDS}"`,
  });
}

/** The handle went past its per-isolate call allowance. */
export function slowDown(retryAfterSeconds: number): Response {
  return oauthError('slow_down', 429, 'too many calls for this session', {
    'Retry-After': String(retryAfterSeconds),
  });
}

const seconds = (time: Date) => Math.floor(time.getTime() / 1000);

/** The session members of a code exchange, a bridge exchange and a `read`. */
export function sessionFields(session: WebSession) {
  return {
    session_id: session.sessionId,
    subject: session.subject,
    auth_time: seconds(session.authTime),
    amr: session.amr,
    ...(session.sso === null
      ? {}
      : {
          sso_connection: session.sso.connection,
          ...(session.sso.organization === null
            ? {}
            : { sso_organization: session.sso.organization }),
        }),
    issued_at: seconds(session.issuedAt),
    idle_expires_at: seconds(session.idleExpiresAt),
    expires_at: seconds(session.expiresAt),
  };
}
