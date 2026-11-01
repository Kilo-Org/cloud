/**
 * URL helpers for the `/wasteland/<owner>/<repo>` tree.
 *
 * One address can carry a `wastelandId` query parameter that selects one
 * of several wastelands behind the same upstream, so every link that
 * rebuilds the address has to keep the query string it was built from —
 * otherwise the selection (and any other intent already in the URL, such
 * as `wantedId`) is dropped on the next click.
 */

/** Query parameter that picks one of several wastelands behind an upstream. */
export const SELECTED_WASTELAND_PARAM = 'wastelandId';

/** `<owner>/<repo>` address with a query string appended when present. */
export function repoPathWithQuery(owner: string, repo: string, query: string): string {
  const path = `/wasteland/${owner}/${repo}`;
  return query ? `${path}?${query}` : path;
}

/**
 * The same address with `wastelandId` set to the chosen wasteland and the
 * rest of the current query kept, so picking a candidate in the chooser
 * does not drop a `status`, `q`, or `wantedId` the user already had.
 */
export function repoPathWithSelection(
  owner: string,
  repo: string,
  query: string,
  wastelandId: string
): string {
  const params = new URLSearchParams(query);
  params.set(SELECTED_WASTELAND_PARAM, wastelandId);
  return repoPathWithQuery(owner, repo, params.toString());
}

/**
 * Deep link into the fork view of the wasteland named by `basePath`.
 * `basePath` may already carry a query string, which is preserved and
 * extended with `wantedId`.
 */
export function forkItemHref(basePath: string, wantedId: string): string {
  const [path, existingQuery] = basePath.split('?');
  const params = new URLSearchParams(existingQuery);
  params.set('wantedId', wantedId);
  return `${path}/fork?${params.toString()}`;
}
