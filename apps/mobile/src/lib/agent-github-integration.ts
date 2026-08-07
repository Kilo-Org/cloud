export function shouldShowGitHubIntegrationPrompt({
  isLoadingRepos,
  integrationInstalled,
}: {
  isLoadingRepos: boolean;
  integrationInstalled: boolean | undefined;
}): boolean {
  return !isLoadingRepos && integrationInstalled === false;
}

export function getGitHubIntegrationUrl(
  webBaseUrl: string,
  organizationId?: string,
  installStateToken?: string
): string {
  const baseUrl = webBaseUrl.endsWith('/') ? webBaseUrl.slice(0, -1) : webBaseUrl;
  const params = new URLSearchParams();
  if (organizationId) {
    params.set('organizationId', organizationId);
  }
  if (installStateToken) {
    params.set('installState', installStateToken);
    params.set('fromApp', '1');
  }
  const query = params.toString();
  return query ? `${baseUrl}/github-app?${query}` : `${baseUrl}/github-app`;
}
