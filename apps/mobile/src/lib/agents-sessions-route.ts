import { type Href } from 'expo-router';

/**
 * The Agents tab's sessions list. Actions whose label promises the sessions
 * list ("Back to sessions", the Home sessions section) navigate here. The
 * group's own path is its `index` route, so this names the sessions list
 * itself rather than wherever the `(2_agents)` stack happens to sit (its other
 * route is the stored-session history page).
 */
export const AGENTS_SESSIONS_HREF: Href = '/(app)/(tabs)/(2_agents)';

/**
 * The same sessions list, reached with an object href and an empty `params`.
 *
 * Expo Router merges a bare string href into the target route's existing
 * params, so a `status` filter the Home card set on a previous visit survives
 * the return and silently narrows the list. An object href with `params: {}`
 * replaces them, so every "back to the full sessions list" action uses this
 * constant while {@link AGENTS_SESSIONS_HREF} stays for comparisons and for
 * actions that must preserve the route's params.
 */
export const AGENTS_SESSIONS_INDEX_HREF = {
  pathname: '/(app)/(tabs)/(2_agents)',
  params: {},
} as const satisfies Href;

/** How a screen leaves for the sessions list. */
export type AgentsSessionsExit = 'dismiss' | 'replace';

/**
 * How a screen that shows the sessions list's own route leaves for it.
 *
 * `router.dismissTo` dispatches POP_TO, which pops back to `(tabs)` while that
 * route is beneath the screen. A session route opened as its stack's only route
 * — a cold deep link, with no `(tabs)` beneath it — has nothing to dismiss to,
 * and POP_TO then rewrites the stack in one commit, the remove-and-insert shape
 * the Android native stack drops. Taking the screen's place lands on the list
 * instead, so the press never leaves the reader on the screen it refuses.
 *
 * `currentIndex` is the index of the screen in its own stack: the sessions
 * route sits at the bottom of the app's authenticated stack, so anything above
 * index 0 has it beneath.
 */
export function agentsSessionsExit({
  currentIndex,
}: Readonly<{ currentIndex: number }>): AgentsSessionsExit {
  return currentIndex > 0 ? 'dismiss' : 'replace';
}
