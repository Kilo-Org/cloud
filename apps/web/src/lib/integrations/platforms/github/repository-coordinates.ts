/**
 * Repository coordinates: the charset rules GitHub names follow, the parser
 * that turns a stored git URL into `owner`/`repo`, and the checks that every
 * caller applies before those values leave the process.
 *
 * The parsers return `null` for a value outside the charset, so a caller never
 * receives an owner or repo that GitHub could not have issued itself.
 */

/** GitHub owner (user or organization) names: alphanumerics and hyphens. */
export const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9-]+$/;

/** GitHub repository names: alphanumerics, hyphens, underscores and dots. */
export const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isGitHubOwnerName(value: string): boolean {
  return GITHUB_OWNER_PATTERN.test(value);
}

export function isGitHubRepositoryName(value: string): boolean {
  return GITHUB_REPOSITORY_PATTERN.test(value);
}

/**
 * Parse a git URL into `{ owner, repo }` when it points at GitHub and both
 * parts stay inside GitHub's name charset. Returns `null` for non-GitHub hosts,
 * for URLs that cannot be parsed into exactly `owner/repo`, and for parts that
 * no GitHub repository could carry. Handles https, ssh:// and SCP-style
 * (`git@github.com:owner/repo.git`) URLs, plus trailing `.git` suffixes.
 */
export function parseGitHubOwnerRepo(url: string): { owner: string; repo: string } | null {
  const sshMatch = url.match(/^git@([^:]+):(.+)$/);
  let host: string;
  let path: string;
  if (sshMatch) {
    host = sshMatch[1].toLowerCase();
    path = sshMatch[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && parsed.protocol !== 'ssh:') {
      return null;
    }
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname.replace(/^\/+/, '');
  }

  if (host !== 'github.com' && host !== 'www.github.com') {
    return null;
  }

  // Strip trailing slashes first, so `owner/repo.git/` loses its `.git` too.
  const cleaned = path.replace(/\/+$/, '').replace(/\.git$/i, '');
  const segments = cleaned.split('/').filter(Boolean);
  if (segments.length !== 2) {
    return null;
  }
  const [owner, repo] = segments;
  if (!isGitHubOwnerName(owner) || !isGitHubRepositoryName(repo)) {
    return null;
  }
  return { owner, repo };
}
