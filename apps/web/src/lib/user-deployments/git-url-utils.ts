export function isHTTPsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract a display-friendly repo name from a git URL (HTTPS only)
 */
export function extractRepoNameFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);
    // Get last two parts (owner/repo) or just repo name
    const repoPath = pathParts.slice(-2).join('-');
    return repoPath.replace(/\.git$/, '');
  } catch {
    // Fallback: generate a random name
    return `repo-${Math.random().toString(36).substring(2, 8)}`;
  }
}

/**
 * Extract display name for logging (hides sensitive parts)
 */
export function extractDisplayNameFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    // Remove credentials if present
    urlObj.username = '';
    urlObj.password = '';
    return urlObj.toString();
  } catch {
    return 'repository';
  }
}
