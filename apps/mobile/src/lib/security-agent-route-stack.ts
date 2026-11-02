/**
 * Rules for a Security Agent screen's place in its group's Stack.
 *
 * Every screen under `security-agent/[scope]/` is a sibling route of one Stack
 * whose `index` is the scope dashboard — the `anchor` the group declares in
 * `unstable_settings`. A screen opened from the dashboard has it beneath it.
 * A screen that a navigation building a fresh destination opens can instead be
 * the Stack's ONLY route: the anchor is honoured by `withAnchor` navigations
 * and the relaunch repair, not by every delivery of a link. That screen has
 * nothing to pop, so its Back — the header control, the Android back gesture,
 * the hardware key — resolves on the root stack and pops the entire Security
 * Agent group. The reader lands outside the feature, and a group whose segment
 * is rebuilt without its params paints the terminal "page not found" state
 * whose Zurück replaces to the scope picker.
 *
 * These rules name the dashboard such a screen is missing, so the layout can
 * put it back beneath the screen the reader is on.
 *
 * No React or React Native imports: every function here is unit-tested
 * directly in `security-agent-route-stack.test.ts`.
 */

/** The route name of the group's dashboard: the `[scope]` Stack's `anchor`. */
export const SCOPE_DASHBOARD_ROUTE_NAME = 'index';

/** The parts of a Stack's state these rules read. */
export type ScopeStackState = {
  /** The index of the focused route in `routes`. */
  readonly index: number;
  /** The routes of the Stack, bottom first. */
  readonly routes: readonly { readonly name: string }[];
};

/**
 * Whether the focused screen has no dashboard beneath it.
 *
 * Only the routes BELOW the focused one count: a dashboard above it is a
 * screen the reader moved on from, not a parent. The dashboard itself needs no
 * parent — leaving it is how the reader leaves the feature.
 */
export function isScopeDashboardMissing({ index, routes }: ScopeStackState): boolean {
  const focused = routes[index];
  if (focused === undefined || focused.name === SCOPE_DASHBOARD_ROUTE_NAME) {
    return false;
  }
  return !routes
    .slice(0, Math.max(index, 0))
    .some(route => route.name === SCOPE_DASHBOARD_ROUTE_NAME);
}
