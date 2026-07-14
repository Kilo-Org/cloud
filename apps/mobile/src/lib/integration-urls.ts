export function getGitLabIntegrationUrl(webBaseUrl: string, organizationId?: string): string {
  const baseUrl = webBaseUrl.endsWith('/') ? webBaseUrl.slice(0, -1) : webBaseUrl;
  if (!organizationId) {
    return `${baseUrl}/integrations/gitlab`;
  }
  return `${baseUrl}/organizations/${encodeURIComponent(organizationId)}/integrations/gitlab`;
}

// Bitbucket is org-only (see PLATFORM_CAPABILITIES), so unlike the GitHub/
// GitLab helpers above there is no personal variant — it links straight to
// the org's Code Reviewer settings page (apps/web's
// organizations/[id]/code-reviews), pre-selecting the Bitbucket tab.
export function getBitbucketIntegrationUrl(webBaseUrl: string, organizationId: string): string {
  const baseUrl = webBaseUrl.endsWith('/') ? webBaseUrl.slice(0, -1) : webBaseUrl;
  return `${baseUrl}/organizations/${encodeURIComponent(organizationId)}/code-reviews?platform=bitbucket`;
}
