import { type Href } from 'expo-router';

/**
 * The Agents tab's sessions list. Actions whose label promises the sessions
 * list ("Back to sessions", the Home sessions section) navigate here. The
 * trailing slash pins the group's `index` route, so the destination is the
 * sessions list itself rather than wherever the `(2_agents)` stack happens to
 * sit (its other route is the stored-session history page).
 */
export const AGENTS_SESSIONS_HREF = '/(app)/(tabs)/(2_agents)/' as Href;
