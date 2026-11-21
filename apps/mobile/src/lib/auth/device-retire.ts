import { CONTROL_PLANE_DEADLINE_MS, withDeadline } from '@kilocode/event-service';

import { trpcClient } from '@/lib/trpc';

/** What the push-token unregister answered; `rejected` means the row may remain. */
export type PushUnregisterOutcome = { status: 'fulfilled' | 'rejected' };

/**
 * Retire this device's remote rows while the session still authenticates the
 * calls, holding the whole pair to ONE `CONTROL_PLANE_DEADLINE_MS` budget.
 *
 * The device push token is unregistered FIRST, then the current device session
 * is revoked. The order is required: the revoke ends this credential's auth, so
 * a deletion that lands after it is refused with "Device session is no longer
 * active", and an account that cannot sign back in never retries it.
 *
 * The two calls are serial under one shared budget, so a stalled first call can
 * hold local sign-out for at most that budget instead of twice it: the push
 * outcome becomes `rejected` (so the caller records the token for retry) and the
 * revoke is not attempted. An abandoned revoke is accepted, because the device
 * has already destroyed the refresh token and the orphaned session row dies
 * with the access token.
 *
 * Never throws: every failure is reported through the returned outcome.
 */
export async function retireDeviceRemoteState(
  pushToken: string | null
): Promise<PushUnregisterOutcome> {
  const pair = withDeadline(CONTROL_PLANE_DEADLINE_MS, async signal => {
    const user = trpcClient.user;
    let push: PushUnregisterOutcome = { status: 'fulfilled' };
    if (pushToken !== null) {
      try {
        await user.unregisterPushToken.mutate({ token: pushToken }, { signal });
      } catch {
        push = { status: 'rejected' };
      }
    }
    try {
      await user.revokeCurrentDeviceSession.mutate(undefined, { signal });
    } catch {
      // An abandoned revoke is accepted: the device already destroyed the
      // refresh token, so the orphaned session row dies with the access token.
    }
    return push;
  });
  try {
    return await pair;
  } catch {
    // The shared budget expired: the push row may remain, so the caller
    // records the token for retry, and the revoke was not attempted.
    return { status: 'rejected' };
  }
}
