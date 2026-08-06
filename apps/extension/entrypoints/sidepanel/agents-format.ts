/**
 * Display helpers shared by the agents session list and session view.
 */

/** Strip the host prefix from a stored git URL: "github.com/org/repo" → "org/repo". */
export const displayRepoName = (gitUrl: string): string =>
  gitUrl.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//, '');

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
