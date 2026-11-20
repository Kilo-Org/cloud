import { type NativeStackNavigationProp, useNavigation } from 'expo-router';
import { useEffect, useRef } from 'react';

/**
 * `useStackSafeReplace` pushes the destination and retires the source screen a
 * transition later, from the source screen's own listener. That retire cannot
 * run when the push leaves the source covered for good: a native Stack stops
 * running a covered screen's code (`profile-stack-retirement.ts`), so the
 * source's `transitionEnd` listener never fires and the source survives — the
 * trigger-create hand-off landed on `/triggers/<id>` with `/triggers/new` still
 * beneath it, and one Back returned to the form instead of the list.
 *
 * This hook flips the ownership: the *destination* screen mounts it, and on its
 * first settled `transitionEnd` (or straight at mount, when that end already
 * ran) removes the `sourceName` entry directly beneath itself with one plain
 * `navigation.reset` — the commit shape the Android native stack commits
 * cleanly once a push has settled, the same one `stack-safe-replace.ts` uses.
 *
 * The judgment only removes one two-route shape, so no other route pair moves:
 *
 * - directly above: `sourceName` — the hand-off's create screen, still mounted;
 * - directly beneath: `guardBelow` — the parent the source needs beneath it.
 *
 * Anything else — a deep-linked detail with the list beneath and no form, a
 * screen another navigation wedged between — is left exactly as the navigator
 * holds it. Removed or unmatched, the hook never touches the navigator again:
 * one judgment per mount, keyed by a ref this screen owns.
 */
export function useRetireCoveredSource(sourceName: string, guardBelow: string): void {
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, undefined>>>();
  // One judgment per mount: a flag the effect and its listener read, so a
  // second `transitionEnd` after the reset is a no-op.
  const doneRef = useRef(false);

  useEffect(() => {
    const retire = () => {
      if (doneRef.current) {
        return;
      }
      const state = navigation.getState();
      const focused = state.routes[state.index];
      if (focused === undefined) {
        return;
      }
      const sourceIndex = state.index - 1;
      const source = state.routes[sourceIndex];
      const below = state.routes[sourceIndex - 1];
      if (source === undefined || source.name !== sourceName || below?.name !== guardBelow) {
        return;
      }
      doneRef.current = true;
      const nextRoutes = [
        ...state.routes.slice(0, sourceIndex),
        ...state.routes.slice(sourceIndex + 1),
      ];
      navigation.reset({ ...state, routes: nextRoutes, index: state.index - 1 });
    };
    // A destination whose transition already ended before this effect ran (a
    // repair's re-push carries `animation: 'none'`) has no further event to
    // wait for, so the mount itself is judged too.
    retire();
    return navigation.addListener('transitionEnd', retire);
  }, [navigation, guardBelow, sourceName]);
}
