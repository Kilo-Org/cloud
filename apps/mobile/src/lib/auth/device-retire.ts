import { CONTROL_PLANE_DEADLINE_MS, withDeadline } from '@kilocode/event-service';

import { trpcClient } from '@/lib/trpc';
import { isTrpcClientError, readTrpcErrorField } from '@/lib/trpc-error';

/** What the push-token unregister answered; `rejected` means the row may remain. */
export type PushUnregisterOutcome = { status: 'fulfilled' | 'rejected' };

/** What the device-session revoke answered; `retryable` means the row may remain. */
export type SessionRevokeOutcome = { status: 'revoked' | 'retryable' };

export type DeviceRetireOutcome = {
  push: PushUnregisterOutcome;
  revoke: SessionRevokeOutcome;
};

/**
 * Share of `CONTROL_PLANE_DEADLINE_MS` the push-token unregister may spend on
 * its own. A stalled unregister is abandoned here, so the revoke that follows
 * always starts with at least the other half of the budget.
 */
const PUSH_UNREGISTER_DEADLINE_MS = Math.floor(CONTROL_PLANE_DEADLINE_MS / 2);

/**
 * Retire this device's remote rows while the session still authenticates the
 * calls, holding the whole pair to ONE `CONTROL_PLANE_DEADLINE_MS` budget.
 *
 * The device push token is unregistered FIRST, then the current device session
 * is revoked. The order is required: the revoke ends this credential's auth, so
 * a deletion that lands after it is refused with "Device session is no longer
 * active", and an account that cannot sign back in never retries.
 *
 * The unregister is capped at `PUSH_UNREGISTER_DEADLINE_MS`, half of the
 * budget. A stalled unregister is therefore abandoned in time for the revoke to
 * run on the remaining budget: it can neither delay the revoke nor extend local
 * sign-out past one `CONTROL_PLANE_DEADLINE_MS`.
 *
 * A failed revoke is NOT accepted as harmless. The device deletes its credential
 * pair, but the session row stays live, and the server's Home widget verifier
 * accepts the widget's own 30-day credential for as long as the row is
 * unrevoked with a live refresh token. So the caller receives `retryable` and
 * records the refresh token for the next launch or foreground
 * (`lib/auth/pending-device-revoke`).
 *
 * A budget that expires reports each step as of that moment: the push step is
 * `fulfilled` only when the unregister had already answered, and the revoke is
 * `revoked` only when it had already returned. The deadline never invents a
 * failure for work that completed, and never claims completion for work it
 * abandoned.
 *
 * Never throws: every failure is reported through the returned outcome.
 */
export async function retireDeviceRemoteState(
  pushToken: string | null
): Promise<DeviceRetireOutcome> {
  // Declared beside the pair so a deadline that fires during the revoke still
  // reports the unregister its real answer, and vice versa. Until a step
  // settles its outcome is the conservative one.
  let push: PushUnregisterOutcome =
    pushToken === null ? { status: 'fulfilled' } : { status: 'rejected' };
  let revoke: SessionRevokeOutcome = { status: 'retryable' };
  const pair = withDeadline(CONTROL_PLANE_DEADLINE_MS, async signal => {
    const user = trpcClient.user;
    if (pushToken !== null) {
      try {
        // The nested deadline abandons a stalled unregister at half the budget,
        // so the revoke below still gets its attempt. An outer abort forwards
        // into this controller, so the pair keeps one total bound.
        await withDeadline(
          PUSH_UNREGISTER_DEADLINE_MS,
          pushSignal =>
            user.unregisterPushToken.mutate({ token: pushToken }, { signal: pushSignal }),
          signal
        );
        push = { status: 'fulfilled' };
      } catch {
        push = { status: 'rejected' };
      }
    }
    try {
      await user.revokeCurrentDeviceSession.mutate(undefined, { signal });
      revoke = { status: 'revoked' };
    } catch (error) {
      // A denied revocation leaves the session (and its widget credential)
      // alive, so it is retried by refresh token unless the server said there is
      // no such session. `NOT_FOUND` is the one definitive answer: the route
      // revokes its own session, so nothing can be left to revoke.
      const definitive =
        isTrpcClientError(error) && readTrpcErrorField(error, 'code') === 'NOT_FOUND';
      revoke = definitive ? { status: 'revoked' } : { status: 'retryable' };
    }
    return { push, revoke };
  });
  try {
    return await pair;
  } catch {
    // The shared budget expired. Report what each step actually answered: a row
    // it already removed must not be recorded as still owed, or the caller
    // retries a deletion that succeeded and withholds the notification event
    // that marks the token gone.
    return { push, revoke };
  }
}
