/**
 * Pure render-hold decision for the stored session list.
 *
 * `reconcileFirstPage` empties the cached pages of the stored infinite query
 * before refetching page one (departure of a live session, mutation settle).
 * During that refetch the cache legitimately holds zero rows, but the list
 * must keep rendering the last non-empty rows: blanking flashes "No sessions
 * yet" and unmounts the SectionList, which resets scroll to the top.
 *
 * The hold is scoped to the query key: a filter or sort change builds a new
 * key and must keep its designed skeleton loading state instead of showing
 * the previous filter's rows.
 */

export type StoredSessionsHold<T> = {
  /** JSON-encoded infinite query key the held sessions belong to. */
  key: string;
  sessions: T[];
};

type ResolvedStoredSessionsHold<T> = {
  /** Sessions to render: the live rows, or the held rows during a blank refetch. */
  sessions: T[];
  /** Hold to carry into the next render, or null when the hold is released. */
  hold: StoredSessionsHold<T> | null;
};

export function resolveStoredSessionsHold<T>(input: {
  /** Sessions collected from the live cache (may be empty mid-refetch). */
  current: T[];
  /** `stored.isFetching` — true while the blank+refetch is in flight. */
  isFetching: boolean;
  /** JSON-encoded current infinite query key. */
  queryKeyJson: string;
  /** Hold captured by the previous render, or null. */
  previousHold: StoredSessionsHold<T> | null;
}): ResolvedStoredSessionsHold<T> {
  const { current, isFetching, queryKeyJson, previousHold } = input;
  if (current.length > 0) {
    return { sessions: current, hold: { key: queryKeyJson, sessions: current } };
  }
  if (isFetching && previousHold?.key === queryKeyJson) {
    return { sessions: previousHold.sessions, hold: previousHold };
  }
  return { sessions: current, hold: null };
}
