/**
 * Mock implementation of GitHub adapter for testing
 */

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
