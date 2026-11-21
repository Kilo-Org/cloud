/**
 * The Agents tab's two views and the one route parameter that names them.
 *
 * The view is addressable: `…/(2_agents)?view=todos` opens the To-dos list,
 * which is how a link (and the forced-state tool) reaches that surface. The
 * parameter is a payload for one arrival — the tab reads it, shows that view,
 * and clears it — so a link can pick the view without that choice following
 * every later navigation to the tab.
 *
 * Kept apart from `components/todos/agents-view-segment.tsx` because that file
 * renders `react-native` and this rule is pure, so the node test project can
 * read it.
 */
export type AgentsView = 'sessions' | 'todos';

/**
 * Read the `view` route parameter as the view a link names.
 *
 * Only `todos` selects the To-dos list: to-dos is the surface a link asks for
 * by name, while sessions is the tab's own first view, so an absent or empty
 * value keeps it. A repeated value reads its first entry, as `parseStatusFilterKind`
 * does for the sessions list's own status filter, and an unknown value falls
 * back to sessions rather than guessing.
 */
export function parseAgentsViewParam(value: string | string[] | undefined): AgentsView {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === 'todos' ? 'todos' : 'sessions';
}
