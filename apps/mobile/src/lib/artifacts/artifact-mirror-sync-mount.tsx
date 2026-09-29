import { useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';

import {
  MIRROR_SYNC_MIN_INTERVAL_MS,
  syncArtifactMirror,
} from '@/lib/artifacts/artifact-mirror-sync';
import { registerArtifactsProviderDomain } from '@/lib/artifacts/artifact-provider-native';
import { useAuth } from '@/lib/auth/auth-context';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';

/**
 * Keeps the artifact mirror in step with the signed-in user while the app runs.
 *
 * The mirror has no progress UI, so every trigger is fire-and-forget and lands
 * on the engine's own single-flight and minimum-interval gates:
 *
 * - once per signed-in context (forced), so a cold start mirrors promptly and
 *   the iOS File Provider domain is registered;
 * - on each `AppState` `active` transition the {@link shouldSyncOnForeground}
 *   policy accepts, so a return to the foreground after the interval picks up
 *   what changed while the app was away.
 *
 * A token alone is not enough to start: the engine resolves the user from the
 * `user.getMe` cache, so the first run waits for `useCurrentUserId` instead of
 * being skipped as `no-user` and leaving the mirror empty until the next
 * foreground.
 *
 * The signed-out half of the contract is not here: sign-out calls
 * `clearSessionScopedState`, which deletes the mirror, so a signed-out device
 * shows nothing to browse.
 */
export type ArtifactMirrorForegroundInput = {
  /** Wall clock of this mount's most recent run, or `null` for none yet. */
  lastRunAt: number | null;
  now: number;
  signedIn: boolean;
  /** True while sign-out teardown is in progress. */
  signingOut: boolean;
};

/**
 * Whether an `AppState` `active` transition should start a mirror run: a
 * signed-in user, no sign-out in progress, and the engine's minimum interval
 * elapsed since the last run. A clock that moved backwards counts as elapsed,
 * matching the engine's own gate — a backwards clock must not lock the mirror
 * out.
 */
export function shouldSyncOnForeground({
  lastRunAt,
  now,
  signedIn,
  signingOut,
}: ArtifactMirrorForegroundInput): boolean {
  if (!signedIn || signingOut) {
    return false;
  }
  if (lastRunAt === null) {
    return true;
  }
  const elapsed = now - lastRunAt;
  return elapsed < 0 || elapsed >= MIRROR_SYNC_MIN_INTERVAL_MS;
}

function useArtifactMirrorSync(): void {
  const { token, isLoading, isSigningOut, authEpoch } = useAuth();
  const { userId, isLoading: isUserIdLoading, isError: isUserIdError } = useCurrentUserId();
  const lastRunAt = useRef<number | null>(null);
  const signedIn =
    Boolean(token) &&
    userId !== undefined &&
    !isLoading &&
    !isUserIdLoading &&
    !isUserIdError &&
    !isSigningOut;
  // The foreground listener runs outside a render, so it reads the live scope
  // through a ref: a sign-out that starts between the transition and the
  // listener must still be seen.
  const scope = useMemo(
    () => ({ signedIn, signingOut: isSigningOut || isSignOutActive() }),
    [signedIn, isSigningOut]
  );
  const currentScope = useRef(scope);
  currentScope.current = scope;

  useEffect(() => {
    if (!scope.signedIn || scope.signingOut) {
      return undefined;
    }

    // Registration is idempotent and a no-op on Android and without the native
    // module; the domain it registers outlives the session.
    registerArtifactsProviderDomain();

    lastRunAt.current = Date.now();
    void syncArtifactMirror({ force: true });

    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState !== 'active') {
        return;
      }
      const now = Date.now();
      if (
        !shouldSyncOnForeground({
          lastRunAt: lastRunAt.current,
          now,
          ...currentScope.current,
        })
      ) {
        return;
      }
      lastRunAt.current = now;
      // Not forced: the engine's persisted `lastRunAt` is the authority.
      void syncArtifactMirror();
    });

    return () => {
      subscription.remove();
    };
  }, [scope, authEpoch]);
}

export function ArtifactMirrorSyncMount(): null {
  useArtifactMirrorSync();
  return null;
}
