/**
 * Whether the session list should scroll to top after a committed search
 * query change. Skips the initial mount (`prev === null`, offset already 0)
 * and no-ops when the committed query is unchanged.
 */
export function shouldResetScrollOnCommittedQuery(prev: string | null, next: string): boolean {
  if (prev === null) {
    return false;
  }
  return prev !== next;
}
