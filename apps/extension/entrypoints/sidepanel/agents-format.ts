/**
 * Display helpers shared by the agents session list and session view.
 */

/**
 * Reduce a git remote to `owner/repo` for display.
 *
 * Handles every form the wire carries: bare `github.com/org/repo` from cloud
 * sessions, and the CLI heartbeat's raw remote — `https://host/org/repo.git`,
 * `ssh://git@host/org/repo.git`, or scp-style `git@host:org/repo.git`. A value
 * that already looks like `owner/repo` (no host segment) passes through.
 */
export const displayRepoName = (gitUrl: string): string => {
  const withoutScheme = gitUrl.trim().replace(/^[a-z][a-z\d+.-]*:\/\//i, '');
  const withoutUser = withoutScheme.replace(/^[^@/]+@/, '');
  // Strip the leading segment only when it looks like a host (contains a dot),
  // So a plain `owner/repo` keeps its owner. An explicit port goes with it.
  const withoutHost = withoutUser.replace(/^[^/:]*\.[^/:]*(?::\d+)?[:/]+/, '');
  return withoutHost.replace(/\.git$/i, '');
};

export const relativeTime = (dateStr: string): string => {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) {
    return 'Just now';
  }
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) {
    return `${diffDays}d ago`;
  }
  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths}mo ago`;
};
