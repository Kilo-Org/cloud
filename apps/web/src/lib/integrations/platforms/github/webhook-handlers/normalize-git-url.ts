/**
 * Normalize a git remote URL to a canonical lower-cased https form so that
 * equivalent https/ssh/`.git`-suffixed variants of the same repo compare equal.
 *
 * - Strips a trailing `.git`
 * - Lower-cases host + owner/repo path
 * - Converts `git@host:owner/repo` ssh form into `https://host/owner/repo`
 * - Leaves non-http(s) URLs that it cannot parse as-is (lower-cased, `.git` stripped)
 *
 * Pure helper; no IO.
 */
export function normalizeGitUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed === '') return '';

  const sshMatch = trimmed.match(/^git@([^:]+):(.+)$/);
  const httpsForm = sshMatch ? `https://${sshMatch[1]}/${sshMatch[2]}` : trimmed;

  try {
    const parsed = new URL(httpsForm);
    const host = parsed.host.toLowerCase();
    let pathname = parsed.pathname.toLowerCase();
    if (pathname.endsWith('.git')) {
      pathname = pathname.slice(0, -'.git'.length);
    }
    while (pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    return `${parsed.protocol.toLowerCase()}//${host}${pathname}`;
  } catch {
    const lower = httpsForm.toLowerCase();
    return lower.endsWith('.git') ? lower.slice(0, -'.git'.length) : lower;
  }
}
