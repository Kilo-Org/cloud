export function getGitLabIntegrationUrl(webBaseUrl: string, organizationId?: string): string {
  const baseUrl = webBaseUrl.endsWith('/') ? webBaseUrl.slice(0, -1) : webBaseUrl;
  if (!organizationId) {
    return `${baseUrl}/integrations/gitlab`;
  }
  return `${baseUrl}/organizations/${encodeURIComponent(organizationId)}/integrations/gitlab`;
}
