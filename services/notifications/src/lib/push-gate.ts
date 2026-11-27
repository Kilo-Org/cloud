/**
 * Staging push gate. A deployment with `WORKER_ENV=staging` reaches no push
 * provider unless `NOTIFICATIONS_PUSH_ENABLED` is exactly the string `'true'`:
 * an absent, empty, `false`, non-string or otherwise malformed value keeps it
 * off. It then sends no Expo push or receipt check, publishes no receipt work
 * and sends no APNs Live Activity or widget push; the local push sink does not
 * stand in for a gated dispatch, and an acceptance recorded before the gate
 * closed settles without its database or queue bookkeeping. Every other
 * `WORKER_ENV` keeps its normal push behavior and ignores the switch.
 *
 * The push entrypoints (the send RPCs, internal dispatch, the user DO's
 * dispatch and glanceable refresh, and its alarm's trailing refresh flush)
 * check the gate before any presence call, database read or snapshot fetch,
 * so a gated deployment needs only the badge routes' bindings. The provider
 * call sites check it again before they read a credential, so a staging
 * deployment without the Expo, APNs or receipt queue bindings never touches
 * them. An intentional skip logs `notifications_push_disabled` with the surface
 * it refused; it is never reported as a delivery or a retryable failure.
 */

type PushGateEnv = { WORKER_ENV?: string; NOTIFICATIONS_PUSH_ENABLED?: string };

type PushSurface =
  | 'push_entrypoint'
  | 'glanceable_refresh'
  | 'expo_push'
  | 'expo_receipts'
  | 'accepted_bookkeeping'
  | 'apns';

/** True, after logging the refused surface, when this deployment must not reach a push provider. */
export function skipProviderPush(env: PushGateEnv, surface: PushSurface): boolean {
  if (env.WORKER_ENV !== 'staging' || env.NOTIFICATIONS_PUSH_ENABLED === 'true') return false;
  console.log('notifications_push_disabled', { surface });
  return true;
}
