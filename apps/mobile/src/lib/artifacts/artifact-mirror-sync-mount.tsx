import { useEffect, useMemo, useRef, useState } from 'react';
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
 * How long the mirror waits after the app's own request burst starts.
 *
 * The mirror is derived data with no progress UI and nothing the user sees
 * waits on it, so its `cliSessionsV2.list` read must not join the burst of
 * requests the app issues on the same transition:
 *
 * - the launch burst, which is what paints the first frame (device check e12
 *   counts the requests before the first frame);
 * - the foreground-regain burst, where the stored history's page-one reconcile
 *   issues its own `cliSessionsV2.list` in the first moments after `AppState`
 *   goes `active` (device check p2 counts the requests around the transition).
 *
 * One interaction frame is not enough for either: the burst runs for seconds
 * after the tree mounts or regains the foreground. The run still happens once
 * per signed-in context and once per accepted foreground transition, just after
 * the burst has settled.
 */
export const MIRROR_BURST_SETTLE_MS = 5000;

/** True once the launch's own request burst has settled. */
function useAfterLaunchSettle(): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(true);
    }, MIRROR_BURST_SETTLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return settled;
}

/**
 * Keeps the artifact mirror in step with the signed-in user while the app runs.
 *
 * The mirror has no progress UI, so every trigger is fire-and-forget and lands
 * on the engine's own single-flight and minimum-interval gates:
 *
 * - once per signed-in context (forced), deferred past the launch's own request
 *   burst so the burst and the first frame it paints do not carry the mirror's
 *   session-list read, and the iOS File Provider domain is registered;
 * - on each `AppState` `active` transition the {@link shouldSyncOnForeground}
 *   policy accepts, so a return to the foreground after the interval picks up
 *   what changed while the app was away. The run waits out the same transition's
 *   own request burst ({@link MIRROR_BURST_SETTLE_MS}) for the same reason.
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

  // The first run waits for the launch's request burst to settle. The mirror is
  // derived data with no progress UI, so the burst — and the first frame it
  // paints — must not carry its session-list read; the cold start otherwise
  // issued a `cliSessionsV2.list` request before the app had painted. The
  // foreground listener is registered on the same settled edge, because it only
  // reacts to a later transition.
  const launchSettled = useAfterLaunchSettle();

  useEffect(() => {
    if (!launchSettled) {
      return undefined;
    }
    if (!scope.signedIn || scope.signingOut) {
      return undefined;
    }

    // Registration is idempotent and a no-op on Android and without the native
    // module; the domain it registers outlives the session.
    registerArtifactsProviderDomain();

    lastRunAt.current = Date.now();
    void syncArtifactMirror({ force: true });

    // The transition is accepted here, but the run itself waits out the
    // foreground-regain burst: the stored history's page-one reconcile issues
    // its own `cliSessionsV2.list` right after `active`, and the mirror's read
    // must not join it (device check p2 counts the requests around the
    // transition). The timer is cancelled when the app leaves the foreground
    // or the mount goes away, so this stays a foreground-only trigger, and the
    // run claims `lastRunAt` only when it actually fires — a cancelled
    // transition is not a run.
    let foregroundRun: ReturnType<typeof setTimeout> | null = null;
    const subscription = AppState.addEventListener('change', nextState => {
      if (foregroundRun !== null) {
        clearTimeout(foregroundRun);
        foregroundRun = null;
      }
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
      foregroundRun = setTimeout(() => {
        foregroundRun = null;
        const live = currentScope.current;
        if (!live.signedIn || live.signingOut) {
          return;
        }
        lastRunAt.current = Date.now();
        // Not forced: the engine's persisted `lastRunAt` is the authority.
        void syncArtifactMirror();
      }, MIRROR_BURST_SETTLE_MS);
    });

    return () => {
      subscription.remove();
      if (foregroundRun !== null) {
        clearTimeout(foregroundRun);
      }
    };
  }, [launchSettled, scope, authEpoch]);
}

export function ArtifactMirrorSyncMount(): null {
  useArtifactMirrorSync();
  return null;
}
