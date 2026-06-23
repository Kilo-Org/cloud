export function buildGitHubInstallState(ownerToken: string, returnTo?: string): string {
  return returnTo ? `${ownerToken}|return=${encodeURIComponent(returnTo)}` : ownerToken;
}
