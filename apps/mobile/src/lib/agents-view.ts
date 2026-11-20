/**
 * The Agents tab's two views and the one route parameter that names them.
 *
 * The view is addressable: `…/(2_agents)?view=todos` opens the To-dos list,
 * which is how a link reaches that surface, and a press on the segment writes
 * the same parameter, so one value names the selected view whether a link or a
 * person chose it.
 *
 * Kept apart from `components/todos/agents-view-segment.tsx` because that file
 * renders `react-native` and this rule is pure, so the node test project can
 * read it.
 */
export type AgentsView = 'sessions' | 'todos';

/**
 * Read the `view` route parameter as the selected segment. An absent, empty,
 * repeated or unknown value is the Sessions list: that is the tab's own first
 * view, and a link that names nothing else must not present To-dos.
 */
export function parseAgentsViewParam(value: string | string[] | undefined): AgentsView {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === 'todos' ? 'todos' : 'sessions';
}

/**
 * The parameter value that names a view. Sessions is the tab's default, so it
 * is written as an absent value instead of a redundant name.
 */
export function agentsViewParam(view: AgentsView): string | undefined {
  return view === 'todos' ? 'todos' : undefined;
}
