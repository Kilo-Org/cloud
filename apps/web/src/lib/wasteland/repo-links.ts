/**
 * URL helpers for the `/wasteland/<owner>/<repo>` tree.
 *
 * One address can carry a `wastelandId` query parameter that selects one
 * of several wastelands behind the same upstream, so every link that
 * rebuilds the address has to keep the query string it was built from —
 * otherwise the selection (and any other intent already in the URL, such
 * as `wantedId`) is dropped on the next click.
 */

/** `<owner>/<repo>` address with a query string appended when present. */
export function repoPathWithQuery(owner: string, repo: string, query: string): string {
  const path = `/wasteland/${owner}/${repo}`;
  return query ? `${path}?${query}` : path;
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
