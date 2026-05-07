/**
 * Shared utilities for parsing, validating, and sanitizing git remote URLs.
 *
 * Supports both HTTPS (`https://host/owner/repo[.git]`) and SSH
 * (`git@host:owner/repo[.git]`) forms across GitHub, gitlab.com, and
 * self-hosted GitLab instances.
 */

export type RepoCoordinates = {
  platform: 'github' | 'gitlab';
  /**
   * Repository owner. For GitLab subgroups this is the full group path
   * (e.g. `group/subgroup`), since GitLab uses the entire path as the
   * project namespace.
   */
  owner: string;
  repo: string;
};

function hostnameOf(urlStr: string): string | null {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return null;
  }
}

function isGitLabHost(host: string, gitlabInstanceUrl?: string): boolean {
  if (host === 'gitlab.com') return true;
  if (gitlabInstanceUrl && hostnameOf(gitlabInstanceUrl) === host) return true;
  return false;
}

/**
 * Returns true when `url` is a syntactically valid HTTPS or SSH git URL.
 *
 * Does not validate that the host is a known git platform — use
 * `parseGitUrl` for that.
 */
export function isValidGitUrl(url: string): boolean {
  if (url.startsWith('git@') && url.includes(':')) return true;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Strip embedded credentials, query parameters, and fragments from a git URL
 * so it is safe to log or display.
 *
 * Returns the input unchanged when parsing fails. Call `isValidGitUrl` first
 * if you want to reject malformed URLs.
 */
export function sanitizeGitUrl(url: string): string {
  const sshMatch = url.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    const host = sshMatch[1];
    const path = sshMatch[2].split('?')[0];
    return `git@${host}:${path}`;
  }

  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Parse a git URL into platform/owner/repo coordinates. Supports HTTPS and
 * SSH formats, GitHub, gitlab.com, and self-hosted GitLab when the instance
 * URL is provided. Returns `null` when the URL doesn't match a recognized
 * platform.
 *
 * GitLab subgroups are flattened into `owner` (e.g. `group/subgroup`) with
 * `repo` set to the final path segment.
 */
export function parseGitUrl(gitUrl: string, gitlabInstanceUrl?: string): RepoCoordinates | null {
  // Normalize: strip trailing .git and embedded credentials (e.g. https://token@github.com/...)
  const url = gitUrl.replace(/\.git$/, '').replace(/\/\/[^@]+@/, '//');

  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/(.+)/);
  if (httpsMatch) {
    return coordinatesFromHostAndPath(httpsMatch[1], httpsMatch[2], gitlabInstanceUrl);
  }

  const sshMatch = url.match(/^git@([^:]+):(.+)/);
  if (sshMatch) {
    return coordinatesFromHostAndPath(sshMatch[1], sshMatch[2], gitlabInstanceUrl);
  }

  return null;
}

function coordinatesFromHostAndPath(
  host: string,
  fullPath: string,
  gitlabInstanceUrl?: string
): RepoCoordinates | null {
  if (host === 'github.com') {
    // GitHub clone URLs always have exactly two segments (owner/repo).
    const parts = fullPath.split('/');
    if (parts.length >= 2) {
      return { platform: 'github', owner: parts[0], repo: parts[1] };
    }
    return null;
  }

  if (isGitLabHost(host, gitlabInstanceUrl)) {
    // GitLab supports subgroups; owner is everything except the last segment.
    const lastSlash = fullPath.lastIndexOf('/');
    if (lastSlash > 0) {
      return {
        platform: 'gitlab',
        owner: fullPath.slice(0, lastSlash),
        repo: fullPath.slice(lastSlash + 1),
      };
    }
    return null;
  }

  return null;
}

/**
 * Compose a `${owner}/${repo}` string suitable for repo-binding lookups.
 * Returns `undefined` when the URL can't be matched against a known platform.
 */
export function repoFullNameFromGitUrl(
  gitUrl: string,
  gitlabInstanceUrl?: string
): string | undefined {
  const coords = parseGitUrl(gitUrl, gitlabInstanceUrl);
  if (!coords) return undefined;
  return `${coords.owner}/${coords.repo}`;
}
