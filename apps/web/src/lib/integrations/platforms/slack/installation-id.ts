// Slack Enterprise Grid IDs are uppercase E followed by 8-15 uppercase alphanumeric characters.
export function isSlackEnterpriseInstallationId(installationId: string): boolean {
  return /^E[A-Z0-9]{8,15}$/.test(installationId);
}
