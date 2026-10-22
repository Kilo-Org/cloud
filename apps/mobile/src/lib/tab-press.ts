import { isFormSheetRoute } from '@/lib/form-sheet-routes';

/**
 * What a press on the Profil tab should do.
 *
 * - `leave`: the tab is not focused, so the press is left to the navigator.
 *   Its tab router focuses the tab and keeps that tab's nested stack, so a
 *   form sheet open on it, and any unsaved draft on a settings screen, are
 *   still there when the user comes back.
 * - `preserve`: the tab is focused and there is nothing to move — either the
 *   focused leaf is a form sheet (the sheet and its typed value stay) or the
 *   tab's stack is already at its root. The press is a no-op, like every other
 *   tab's re-press.
 * - `reset-to-root`: the #5518 re-press behaviour. The tab resets to its root
 *   through a stack pop (`POP_TO_TOP`), which is a removal — so a screen
 *   guarded by `useSettingsBackGuard` shows its unsaved-changes dialog instead
 *   of being left silently, and Discard/Save replay the pop.
 */
export type ProfileTabPressPlan = 'leave' | 'preserve' | 'reset-to-root';

/**
 * The slice of the pressed tab's navigation object the tab press reads and
 * dispatches through: the tab navigator's state, to find the tab's nested
 * stack, and a dispatch that reaches that stack by key.
 */
export type TabPressNavigation = {
  getState: () =>
    | {
        routes: { name: string; state?: { key?: string; index?: number } }[];
      }
    | undefined;
  dispatch: (action: { type: string; target?: string }) => void;
};

export function planProfileTabPress({
  profileFocused,
  segments,
  profileStackIndex,
}: Readonly<{
  profileFocused: boolean;
  segments: readonly string[];
  profileStackIndex: number | undefined;
}>): ProfileTabPressPlan {
  if (!profileFocused) {
    return 'leave';
  }
  if (isFormSheetRoute(segments) || profileStackIndex === undefined || profileStackIndex === 0) {
    return 'preserve';
  }
  return 'reset-to-root';
}
