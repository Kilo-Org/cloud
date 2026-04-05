/**
 * Sanitize a git URL for safe logging by stripping credentials, query params, and fragments.
 * Handles both HTTPS and SSH (`git@host:path`) URLs.
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
