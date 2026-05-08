/**
 * Normalize a git URL so that `https://github.com/acme/Widgets.git`,
 * `https://github.com/ACME/widgets`, `git@github.com:acme/widgets.git`,
 * and `ssh://git@github.com/acme/widgets` all compare equal.
 *
 * Normalization rules:
 *   - strip trailing `.git`
 *   - convert SCP-style `git@host:owner/repo` to `https://host/owner/repo`
 *   - convert `ssh://git@host/owner/repo` to `https://host/owner/repo`
 *   - lower-case the host and the owner/repo path
 *   - drop any `user@` prefix in the URL
 *
 * Returns the input unchanged if it cannot be parsed — caller still uses the
 * raw value as a fallback query, so this never throws.
 */
export function normalizeGitUrl(url: string): string {
  if (!url) return url;

  let candidate = url.trim();

  // git@github.com:owner/repo(.git) → https://github.com/owner/repo
  const scp = candidate.match(/^([^@\s]+)@([^:\s]+):(.+)$/);
  if (scp) {
    const host = scp[2];
    const path = scp[3].replace(/^\/+/, '');
    candidate = `https://${host}/${path}`;
  }

  // ssh://git@github.com/owner/repo(.git) → https://github.com/owner/repo
  if (candidate.startsWith('ssh://')) {
    candidate = 'https://' + candidate.slice('ssh://'.length);
  }

  // Trim trailing .git (after protocol normalization).
  if (candidate.endsWith('.git')) {
    candidate = candidate.slice(0, -'.git'.length);
  }

  // Trim trailing slash.
  if (candidate.endsWith('/')) {
    candidate = candidate.slice(0, -1);
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return candidate.toLowerCase();
  }

  const host = parsed.host.toLowerCase();
  const pathname = parsed.pathname.toLowerCase().replace(/\/+$/, '');
  const protocol = parsed.protocol.toLowerCase();

  return `${protocol}//${host}${pathname}`;
}
