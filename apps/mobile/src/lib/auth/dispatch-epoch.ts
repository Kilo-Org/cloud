// The auth session that dispatched a tRPC call, recorded on the error object
// that call failed with.
//
// The auth epoch is the only signal that names the session which issued a call.
// The two sign-out booleans cannot: a sign-in clears both before a previous
// session's refusal settles, so a refusal dispatched by the account that signed
// out can arrive after a new sign-in opened every boolean fence (see
// `query-client.ts`: React Query 5 awaits `MutationCache.config.onError` even
// after `queryClient.clear()`). Comparing the epoch captured when the operation
// started with the current one answers exactly the question the raise path
// needs: does this refusal belong to the session the app is now serving?
//
// The recording is per error object rather than per call site because the cache
// hooks receive only the error. `trpc.ts` tags every operation's error with the
// epoch it captured at dispatch, and the raise path asks whether that recorded
// epoch is still current.

import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';

const dispatchEpochs = new WeakMap<object, number>();

/**
 * Whether this rejection can carry a recorded session at all. The caches hand
 * the raise path an `unknown` rejection, and a primitive one cannot key the map,
 * so it carries no session; declared as a type guard so neither caller needs an
 * assertion to reach the map.
 */
function isTrackable(error: unknown): error is object {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the caches hand the raise path an `unknown` rejection
  return typeof error === 'object' && error !== null;
}

/** Records `epoch` as the session that dispatched the call this error came from. */
export function tagDispatchSessionAt(error: unknown, epoch: number): void {
  if (!isTrackable(error)) {
    return;
  }
  dispatchEpochs.set(error, epoch);
}

/** Records the current auth session as the one that dispatched this call. */
export function tagDispatchSession(error: unknown): void {
  tagDispatchSessionAt(error, currentAuthEpoch());
}

/**
 * True only when this exact error object was tagged with an epoch that is still
 * the current one. An untagged error, and a tagged error from a session that has
 * since ended, both answer false.
 */
export function isFromCurrentDispatchSession(error: unknown): boolean {
  if (!isTrackable(error)) {
    return false;
  }
  const epoch = dispatchEpochs.get(error);
  return epoch !== undefined && isCurrentAuthEpoch(epoch);
}
