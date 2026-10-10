/**
 * Normalizes a project identifier by extracting the repository name from git URLs
 * and truncating to a maximum length.
 * If the project is a git repository URL, extracts the repository name.
 * Otherwise, returns the project ID as-is.
 * The result is always truncated to 256 characters maximum.
 *
 * @param projectId - The project identifier (could be a URL or plain string)
 * @returns The normalized project name, truncated to 256 characters, or null
 *
 * @example
 * normalizeProjectId('https://github.com/Kilo-Org/handbook.git') // returns 'handbook'
 * normalizeProjectId('https://github.com/Kilo-Org/handbook') // returns 'handbook'
 * normalizeProjectId('git@github.com:Kilo-Org/handbook.git') // returns 'handbook'
 * normalizeProjectId('my-project') // returns 'my-project'
 * normalizeProjectId(null) // returns null
 */
export function normalizeProjectId(projectId: string | null): string | null {
  if (!projectId) {
    return null;
  }

  // Truncate to 256 characters first to prevent processing extremely long strings
  const truncated = projectId.substring(0, 256);

  // Check if it looks like an HTTPS git URL (with or without .git)
  // Must not have trailing spaces, query params, or fragments
  // Accepts any hostname to support on-premise SCM systems
  const httpsRepoPattern = /^https?:\/\/[^/]+\/([^\s?#]+?)(?:\.git)?$/i;
  const httpsMatch = truncated.match(httpsRepoPattern);
  if (httpsMatch) {
    // Extract the path after the domain and get the last component
    const repoPath = httpsMatch[1];
    const parts = repoPath.split('/');
    return parts[parts.length - 1];
  }

  // Check if it looks like an SSH git URL
  // Must not have trailing spaces
  // Accepts any hostname to support on-premise SCM systems
  const sshGitPattern = /^git@[^:]+:([^\s]+?)(?:\.git)?$/i;
  const sshMatch = truncated.match(sshGitPattern);
  if (sshMatch) {
    // Extract the path after the colon and get the last component
    const repoPath = sshMatch[1];
    const parts = repoPath.split('/');
    return parts[parts.length - 1];
  }

  // If it's not a recognized git URL, return as-is (already truncated)
  return truncated;
}
