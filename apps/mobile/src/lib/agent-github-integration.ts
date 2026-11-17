export function shouldShowGitHubIntegrationPrompt({
  isLoadingRepos,
  integrationInstalled,
}: {
  isLoadingRepos: boolean;
  integrationInstalled: boolean | undefined;
}): boolean {
  return !isLoadingRepos && integrationInstalled === false;
}
