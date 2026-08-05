/** Build the state parameter for a GitHub App installation URL. The return_to path is stored in the database row and the callback reads it from there. The state parameter carries only the bare database token. */
export function buildGitHubInstallState(stateToken: string): string {
  return stateToken;
}
