export function getGitLabIntegrationUrl(webBaseUrl: string, organizationId?: string): string {
  const baseUrl = webBaseUrl.endsWith('/') ? webBaseUrl.slice(0, -1) : webBaseUrl;
  if (!organizationId) {
    return `${baseUrl}/integrations/gitlab`;
  }
  return `${baseUrl}/organizations/${encodeURIComponent(organizationId)}/integrations/gitlab`;
}

// Bitbucket setup is organization-only; interactive launch does not use Code Reviewer.
export function getBitbucketIntegrationUrl(webBaseUrl: string, organizationId: string): string {
  const baseUrl = webBaseUrl.endsWith('/') ? webBaseUrl.slice(0, -1) : webBaseUrl;
  return `${baseUrl}/organizations/${encodeURIComponent(organizationId)}/integrations/bitbucket`;
}
