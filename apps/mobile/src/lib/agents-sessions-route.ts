import { type Href } from 'expo-router';

/**
 * The Agents tab's sessions list. Actions whose label promises the sessions
 * list ("Back to sessions", the Home sessions section) navigate here. The
 * trailing slash pins the group's `index` route, so the destination is the
 * sessions list itself rather than wherever the `(2_agents)` stack happens to
 * sit (its other route is the stored-session history page).
 */
export const AGENTS_SESSIONS_HREF = '/(app)/(tabs)/(2_agents)/' as Href;

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
  pathname: '/(app)/(tabs)/(2_agents)/',
  params: {},
} as const satisfies Href;
