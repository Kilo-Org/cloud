export function shouldShowGitHubIntegrationPrompt({
  isLoadingRepos,
  integrationInstalled,
  repositoryCount,
}: {
  isLoadingRepos: boolean;
  integrationInstalled: boolean | undefined;
  repositoryCount?: number;
}): boolean {
  return !isLoadingRepos && (integrationInstalled === false || repositoryCount === 0);
}

export function getGitHubIntegrationUrl(webBaseUrl: string, organizationId?: string): string {
  const baseUrl = webBaseUrl.endsWith('/') ? webBaseUrl.slice(0, -1) : webBaseUrl;
  if (!organizationId) {
    return `${baseUrl}/github-app`;
  }
  return `${baseUrl}/github-app?organizationId=${encodeURIComponent(organizationId)}`;
}
