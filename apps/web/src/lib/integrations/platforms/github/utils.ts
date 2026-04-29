export function extractBranchNameFromRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}

/**
 * Normalize a git URL into a canonical comparison key.
 *
 * Accepts both https and ssh forms (with or without a trailing `.git`) and
 * returns a canonical `https://<host>/<owner>/<repo>` value with the host and
 * path lower-cased and the `.git` suffix stripped.
 *
 * Examples:
 *   https://GitHub.com/Owner/Repo.git -> https://github.com/owner/repo
 *   git@github.com:Owner/Repo.git     -> https://github.com/owner/repo
 *   ssh://git@github.com/Owner/Repo   -> https://github.com/owner/repo
 *
 * Inputs that do not parse as a recognizable git remote are returned trimmed +
 * lower-cased so that equal strings still compare equal without crashing.
 */
export function normalizeGitUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';

  // scp-style ssh: git@host:owner/repo(.git)
  const scpMatch = trimmed.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  if (scpMatch) {
    const [, host, path] = scpMatch;
    return buildCanonicalGitUrl(host, path);
  }

  try {
    // Covers https://, http://, ssh://, git://
    const parsed = new URL(trimmed);
    return buildCanonicalGitUrl(parsed.host, parsed.pathname);
  } catch {
    return trimmed.toLowerCase().replace(/\.git$/i, '');
  }
}

function buildCanonicalGitUrl(host: string, rawPath: string): string {
  const cleanHost = host.toLowerCase();
  const cleanPath = rawPath
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
  return `https://${cleanHost}/${cleanPath}`;
}
