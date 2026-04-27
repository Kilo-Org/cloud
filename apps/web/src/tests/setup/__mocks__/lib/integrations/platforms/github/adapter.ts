/**
 * Mock implementation of GitHub adapter for testing
 */

export type GitHubAppType = 'standard' | 'lite';

export function verifyGitHubWebhookSignature(_payload: string, _signature: string): boolean {
  return true;
}

export async function generateGitHubInstallationToken(_installationId: string): Promise<string> {
  return `mock-token-${_installationId}`;
}

export async function deleteGitHubInstallation(_installationId: string): Promise<void> {
  // Mock implementation - no-op
  return;
}

export async function getCollaboratorPermissionLevel(
  _installationId: string,
  _owner: string,
  _repo: string,
  _username: string
): Promise<'admin' | 'write' | 'read' | 'none' | null> {
  return 'write';
}

export async function isMergeCommit(
  _installationId: string,
  _owner: string,
  _repo: string,
  _commitSha: string,
  _appType: GitHubAppType = 'standard'
): Promise<boolean> {
  return false;
}

export async function addReactionToPR(
  _installationId: string,
  _owner: string,
  _repo: string,
  _issueNumber: number,
  _reaction: string,
  _appType: GitHubAppType = 'standard'
): Promise<void> {
  return;
}

export async function createCheckRun(
  _installationId: string,
  _owner: string,
  _repo: string,
  _headSha: string,
  _options: unknown,
  _appType: GitHubAppType = 'standard'
): Promise<number> {
  return 0;
}

export async function updateCheckRun(
  _installationId: string,
  _owner: string,
  _repo: string,
  _checkRunId: number,
  _updates: unknown,
  _appType: GitHubAppType = 'standard'
): Promise<void> {
  return;
}
