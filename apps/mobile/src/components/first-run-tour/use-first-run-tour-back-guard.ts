import { useNavigation } from 'expo-router';
import { type RefObject, useRef } from 'react';

import { usePreventRemove } from '@/lib/navigation/prevent-remove';

/**
 * First-run tour removal guard. Registers a predictive-Back-safe guard via
 * `usePreventRemove`, which fires for every removal that reaches
 * react-navigation: the Skip/Finish replays, the iOS swipe gesture, and
 * system-initiated dismissal — so any of those leaving the tour records a
 * decision. Android hardware back reaches JS (and this guard through the
 * replay) only because `app.config.ts` ships
 * `predictiveBackGestureEnabled: false`: with the predictive-back opt-in on,
 * RN 0.86 registers its dispatcher back-callback only when device SDK AND
 * targetSdk are ≥ 36 (`AndroidVersion.isAtLeastTargetSdk36` in
 * `ReactActivity.onCreate`), so on Android 13–15 an opted-in build has no
 * back consumer at all — the system finishes the activity and neither this
 * guard nor any JS `BackHandler` ever fires (e4, re-measured on device
 * 2026-09-08 against a binary built before the flag fix). With the flag off
 * the press is owned by the tour flow's own `BackHandler` subscription in
 * `first-run-tour-flow.tsx`, which dismisses through `router.back()` and so
 * re-enters this guard as a replay.
 *
 * Mirrors the `usePreventRemove` + bypass-ref pattern of
 * `use-new-session-discard-guard.ts` without any prompt: the tour has no
 * draft to lose, so the only choice is which decision to record. The explicit
 * Skip/Finish buttons already record theirs and arm `skipNextGuardRef` right
 * before dismissing; the callback consumes it and replays the captured
 * navigation action. A removal by a BACK-type action (swipe, replayed back)
 * records `skipped` and replays the action in the same tick, because the
 * removal was already prevented.
 *
 * The record deliberately does NOT delay the replay: awaiting the mark first
 * held the prevented modal on screen for the whole storage write — 8.7 s on
 * the e2e emulator under load, with the person staring at a tour that
 * ignored their back press (2026-09-07). Re-showing is instead
 * stopped by the process-lifetime outcome latch the mark sets synchronously
 * (see `@/lib/first-run-tour/tour-state`), so the gate never re-arms even
 * while the write is in flight.
 *
 * Any OTHER removal action (deep-link `RESET`, programmatic navigation) is
 * NOT the person's dismissal: it replays without recording, so the tour
 * re-opens on the next home arrival (see `FirstRunTourGate`). Without this
 * split, the e2e login verification's own profile deep link consumed the
 * freshly auto-opened tour and persisted a skip the user never made — the
 * first sign-in then had no tour on screen (e1, 2026-09-07).
 *
 * `onUserDismissal` must not reject: the mark is contained (draft write
 * failures are reported to Sentry and swallowed), so the fire-and-forget
 * call cannot leak an unhandled rejection into the replay below it.
 *
 * A second removal attempt while the first replay is settling — another
 * hardware-back press, or Skip/Finish tapped in the same window — must not
 * start a second replay, or the extra action pops the screen behind the
 * modal once the first removal lands. `removalStartedRef` latches the first
 * removal: every later interception is swallowed, and the one owned replay
 * does the dismissal.
 */

/**
 * Action types that mean the person left the tour themselves: hardware back
 * / swipe dispatch `GO_BACK`; the native-stack pop path dispatches `POP`.
 * Everything else (`RESET` from a deep link, `NAVIGATE`, …) is a
 * programmatic navigation, not a dismissal decision.
 */
const USER_DISMISSAL_ACTION_TYPES: ReadonlySet<string> = new Set(['GO_BACK', 'POP']);

export function useFirstRunTourBackGuard({
  skipNextGuardRef,
  onUserDismissal,
}: Readonly<{
  skipNextGuardRef: RefObject<boolean>;
  onUserDismissal: () => Promise<void>;
}>): void {
  const navigation = useNavigation();
  // Keep the latest onUserDismissal in a ref so the callback below doesn't
  // depend on it directly — onUserDismissal is a fresh closure every
  // render. Same containment as use-new-session-discard-guard.
  const onUserDismissalRef = useRef(onUserDismissal);
  onUserDismissalRef.current = onUserDismissal;
  // True once a removal has been owned (replayed now, or replayed after the
  // flushed mark resolves). Swallows repeat attempts during the flush window.
  const removalStartedRef = useRef(false);

  usePreventRemove(true, ({ data }) => {
    if (skipNextGuardRef.current) {
      skipNextGuardRef.current = false;
      if (removalStartedRef.current) {
        // An unhandled removal is already flushing and owns the replay; the
        // decision this button pressed is already recorded by dismissWith.
        return;
      }
      removalStartedRef.current = true;
      navigation.dispatch(data.action);
      return;
    }
    if (removalStartedRef.current) {
      return;
    }
    removalStartedRef.current = true;
    if (USER_DISMISSAL_ACTION_TYPES.has(data.action.type)) {
      // Fire-and-forget on purpose: the person left the tour, so the
      // decision must be recorded, but the replay cannot wait for the
      // flushed write (see the doc comment above).
      void onUserDismissalRef.current();
    }
    navigation.dispatch(data.action);
  });
}
