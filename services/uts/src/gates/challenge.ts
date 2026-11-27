import { jsonResponse } from '../responses';

/**
 * Credential-change gates (design 5.11). The identity store decides every gate inside the
 * statement of the gated action (migration 0005): tier B, for creating a PAT or an org bot key, is
 * a sign-in within 10 minutes or a passkey step-up of the same session within 10 minutes. The
 * action's statement records the pass as consumed by its one row, so a pass serves one action of
 * its own account once.
 *
 * A refusal answers with the RFC 9470 step-up challenge: the client signs in again (or completes a
 * passkey check) and retries. `max_age` is the 10-minute window, so an RFC 9470 client asks the
 * authorization server for a sign-in at most that old.
 */

/** Design 5.11: a gate accepts a sign-in or a passkey check at most this old. */
export const GATE_WINDOW_SECONDS = 600;

const DESCRIPTION = 'sign in again or complete a passkey check, then retry within 10 minutes';

export function gateRequiredResponse(): Response {
  return jsonResponse(
    { error: 'insufficient_user_authentication', error_description: DESCRIPTION },
    401,
    {
      'WWW-Authenticate': `Bearer error="insufficient_user_authentication", error_description="${DESCRIPTION}", max_age="${GATE_WINDOW_SECONDS}"`,
    }
  );
}
