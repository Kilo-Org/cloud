const MULTIPLE_GITHUB_INSTALLATION_ORGANIZATION_IDS = new Set([
  '9d278969-5453-4ae3-a51f-a8d2274a7b56',
  '30f1620a-4aad-4456-bf4d-550f335e6f55',
]);

export function canOrganizationUseMultipleGitHubInstallations(organizationId: string): boolean {
  return MULTIPLE_GITHUB_INSTALLATION_ORGANIZATION_IDS.has(organizationId);
}
