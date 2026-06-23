export function shouldShowGitHubIntegrationPrompt({
  isLoadingRepos,
  integrationInstalled,
}: {
  isLoadingRepos: boolean;
  integrationInstalled: boolean | undefined;
}): boolean {
  return !isLoadingRepos && integrationInstalled === false;
}

export function getGitHubIntegrationUrl(webBaseUrl: string, organizationId?: string): string {
  const baseUrl = webBaseUrl.endsWith('/') ? webBaseUrl.slice(0, -1) : webBaseUrl;
  if (!organizationId) {
    return `${baseUrl}/github-app`;
  }
  return `${baseUrl}/github-app?organizationId=${encodeURIComponent(organizationId)}`;
}
