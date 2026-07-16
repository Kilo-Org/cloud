/**
 * The set of fields the agent-sessions list/search endpoints accept as the
 * `orderBy` argument. Today they both default to `updated_at` server-side;
 * the value here MUST stay in sync with the zod enum in the web router
 * (`ListSessionsInputSchema.orderBy` / `SearchInputSchema.orderBy`).
 */
export const AGENT_SESSION_SORT_OPTIONS = ['updated_at', 'created_at'] as const;

export type AgentSessionSortBy = (typeof AGENT_SESSION_SORT_OPTIONS)[number];

export const DEFAULT_AGENT_SESSION_SORT: AgentSessionSortBy = 'updated_at';

const SORT_BY_SET = new Set<string>(AGENT_SESSION_SORT_OPTIONS);

/**
 * Coerce arbitrary persisted/legacy/unknown input into a known sort value.
 * Anything that isn't a recognized field falls back to the default so a bad
 * SecureStore record can never crash the list.
 */
export function parseAgentSessionSortBy(value: unknown): AgentSessionSortBy {
  if (typeof value === 'string' && SORT_BY_SET.has(value)) {
    return value as AgentSessionSortBy;
  }
  return DEFAULT_AGENT_SESSION_SORT;
}

type AgentSessionTimestamps = { created_at: string; updated_at: string };

/**
 * Pick which timestamp string drives ordering and relative-time display
 * for the given sort. Defensive fallback to `updated_at` for a non-`SortBy`
 * input so callers that interpolate from a wider value type can't break the
 * row's meta label.
 */
export function getAgentSessionTimestamp(
  session: AgentSessionTimestamps,
  sortBy: AgentSessionSortBy
): string {
  if (sortBy === 'created_at') {
    return session.created_at;
  }
  return session.updated_at;
}
