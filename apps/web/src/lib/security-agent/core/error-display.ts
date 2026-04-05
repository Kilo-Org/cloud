const GITHUB_INTEGRATION_ERROR_NEEDLES = [
  'GitHub token',
  'GitHub installation',
  'installation_id',
  'Bad credentials',
  'Forbidden',
  'Resource not accessible',
  // Match user-friendly messages from classifyAnalysisError
  'GitHub authentication failed',
  'Failed to clone the repository',
  'Repository not found',
];

/** Detect GitHub integration errors so the UI can show "reconnect your GitHub App" guidance. */
export function isGitHubIntegrationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return GITHUB_INTEGRATION_ERROR_NEEDLES.some(needle => message.includes(needle));
}
