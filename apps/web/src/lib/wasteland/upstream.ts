/**
 * Parse a `dolthub_upstream` slug ("owner/repo") into its components.
 *
 * Returns `null` when the input is empty, missing the slash, has an empty
 * owner or repo, or contains extra slashes. Safe to import from both client
 * and server code (no `'server-only'`).
 */
export function parseDolthubUpstream(
  upstream: string | null | undefined
): { owner: string; repo: string } | null {
  if (!upstream) return null;
  const slash = upstream.indexOf('/');
  if (slash <= 0 || slash === upstream.length - 1) return null;
  const owner = upstream.slice(0, slash);
  const repo = upstream.slice(slash + 1);
  if (!owner || !repo || repo.includes('/')) return null;
  return { owner, repo };
}
