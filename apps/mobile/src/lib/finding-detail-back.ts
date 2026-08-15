import { type Href } from 'expo-router';

/**
 * Profile tab root. This is the fixed landing target when a push/deep-link
 * opened a finding report with no in-app history beneath it. The group href
 * (no trailing `/index`) is the route expo-router matches — the `/index`
 * suffix resolves to the not-found screen.
 */
export const PROFILE_TAB_ROOT = '/(app)/(tabs)/(3_profile)' as Href;

export type FindingDetailBackTarget = { kind: 'pop' } | { kind: 'replace'; href: Href };

/**
 * Does the finding detail's own navigator (the nested `security-agent/[scope]`
 * Stack) have a screen beneath it?
 *
 * The local state `index` is the correct signal. The navigator's `canGoBack()`
 * is recursive: it also reports parent (tab/root) history, so a push/deep-link
 * open that holds only the detail route (`index === 0`) would still report
 * "can go back" through the parents. `index > 0` means the normal
 * findings-list -> detail flow pushed the detail on top of the list.
 */
export function findingDetailHasLocalHistory(state: { index: number } | undefined): boolean {
  return (state?.index ?? 0) > 0;
}

/**
 * Decide the finding-detail back action from the local-history signal.
 *
 * - `pop` when there is local history: the normal findings-list -> finding
 *   flow must return to the list, so back pops normally.
 * - `replace` to the profile root when there is no local history: a
 *   push/deep-link opened the report with nothing beneath it, so a bare `pop`
 *   is a no-op and back must land on the profile root — never an intermediate
 *   security-agent screen.
 */
export function findingDetailBackTarget(hasLocalHistory: boolean): FindingDetailBackTarget {
  if (hasLocalHistory) {
    return { kind: 'pop' };
  }
  return { kind: 'replace', href: PROFILE_TAB_ROOT };
}
