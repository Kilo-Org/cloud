// Slack Enterprise Grid IDs are uppercase E followed by uppercase alphanumeric characters.
export function isSlackEnterpriseInstallationId(installationId: string): boolean {
  return /^E[A-Z0-9]+$/.test(installationId);
}
