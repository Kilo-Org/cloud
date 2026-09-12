// Slack uses E-prefixed enterprise IDs as the installation key for org-wide installs.
export function isSlackEnterpriseInstallationId(installationId: string): boolean {
  return installationId.startsWith('E');
}
