import { type NativeStackNavigationProp, useNavigation } from 'expo-router';
import { useEffect, useRef } from 'react';

/**
 * The index of the covered `sourceName` route this judgment retires, or `null`
 * when the stack is not one a hand-off produced.
 *
 * The source is looked for by walking DOWN from the focused route, and only the
 * nearest entry of that name is judged: a stack holding several screens with
 * the source's name still hands off from the one closest to the focused screen,
 * and the entries below it are the history the reader moved on from.
 *
 * The judged source is accepted in exactly the two shapes a hand-off produces,
 * both of which read "the source sits directly beneath the destination and the
 * guard sits next to the source":
 *
 * - `... guardBelow, sourceName, FOCUSED` — the create flow's own order: the
 *   source was pushed above its guard, then the destination above the source.
 * - `... sourceName, guardBelow, FOCUSED` — the same pair after a scene repair
 *   spliced the guard in directly beneath the focused screen
 *   (`use-repair-security-agent-scope-stack`), which puts the guard between the
 *   source and the destination instead of beneath the source.
 *
 * Anything else is left exactly as the navigator holds it: a different screen
 * wedged between the source and its guard, a screen between the source and the
 * destination (the destination did not land on that hand-off), a source that is
 * not beneath the focused route, or a stack with no room to drop a route.
 */
function coveredSourceIndex(
  state: { routes: { name: string }[]; index: number },
  sourceName: string,
  guardBelow: string
): number | null {
  for (let sourceIndex = state.index - 1; sourceIndex >= 0; sourceIndex -= 1) {
    if (state.routes[sourceIndex]?.name !== sourceName) {
      continue;
    }
    // The nearest entry of the source's name: its own shape decides, so a
    // nearer source in an unrecognized shape never lets a farther one move.
    // The source has to sit directly under the destination, or - for the
    // repair's splice - directly under the guard the destination landed on.
    const beneathDestination = sourceIndex === state.index - 1;
    const directlyAboveSource = state.routes[sourceIndex + 1];
    if (
      (beneathDestination && state.routes[sourceIndex - 1]?.name === guardBelow) ||
      (sourceIndex === state.index - 2 && directlyAboveSource?.name === guardBelow)
    ) {
      return sourceIndex;
    }
    return null;
  }
  return null;
}

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
 * ran) removes the `sourceName` entry beneath itself with one plain
 * `navigation.reset` — the commit shape the Android native stack commits
 * cleanly once a push has settled, the same one `stack-safe-replace.ts` uses.
 *
 * The removed route is the nearest `sourceName` beneath the focused screen, and
 * only when `guardBelow` — the parent the source needs beneath it — is next to
 * it: directly beneath the source (`... guard, source, focused`), or directly
 * beneath the focused screen with the source directly beneath that
 * (`... source, guard, focused`), the shape a scene repair produces when it
 * splices the guard under the screen a hand-off just pushed.
 *
 * Anything else — a deep-linked detail with the list beneath and no form, a
 * screen another navigation wedged between the source and its guard — is left
 * exactly as the navigator holds it. Every route that stays keeps its key, the
 * focused route included, and the focused index falls by one because a route
 * beneath it was dropped. Removed or unmatched, the hook never touches the
 * navigator again: one judgment per mount, keyed by a ref this screen owns.
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
      if (state.routes[state.index] === undefined) {
        return;
      }
      const sourceIndex = coveredSourceIndex(state, sourceName, guardBelow);
      if (sourceIndex === null) {
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
