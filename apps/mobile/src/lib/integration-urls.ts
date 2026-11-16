function trimTrailingSlash(webBaseUrl: string): string {
  return webBaseUrl.endsWith('/') ? webBaseUrl.slice(0, -1) : webBaseUrl;
}

/** The providers that have a full-web `/integrations/...` page. Only Bitbucket
 *  still opens one; the app shell hosts every other provider's page. */
type IntegrationPagePlatform = 'github' | 'slack' | 'gitlab' | 'discord' | 'linear' | 'bitbucket';

/**
 * The full-web path that owns a platform's connect flow: `apps/web`'s
 * `integrations/[platform]` and `organizations/[id]/integrations/[platform]`
 * routes. Only Bitbucket reaches these; every other provider has an app-shell
 * page and is opened through `app-shell-handoff`.
 */
export function getIntegrationPagePath(
  platform: IntegrationPagePlatform,
  organizationId?: string
): string {
  if (!organizationId) {
    return `/integrations/${platform}`;
  }
  return `/organizations/${encodeURIComponent(organizationId)}/integrations/${platform}`;
}

export function getIntegrationPageUrl(
  webBaseUrl: string,
  platform: IntegrationPagePlatform,
  organizationId?: string
): string {
  return `${trimTrailingSlash(webBaseUrl)}${getIntegrationPagePath(platform, organizationId)}`;
}

// The BYOK key editor has no mobile screen, so a reviewer blocked by a broken
// key sends the user to the web settings page that owns it.
export function getByokUrl(webBaseUrl: string, organizationId?: string): string {
  const baseUrl = trimTrailingSlash(webBaseUrl);
  if (!organizationId) {
    return `${baseUrl}/byok`;
  }
  return `${baseUrl}/organizations/${encodeURIComponent(organizationId)}/byok`;
}

// Bitbucket is org-only (see PLATFORM_CAPABILITIES), so unlike the GitHub/
// GitLab helpers above there is no personal variant — it links straight to
// the org's Code Reviewer settings page (apps/web's
// organizations/[id]/code-reviews), pre-selecting the Bitbucket tab.
export function getBitbucketIntegrationUrl(webBaseUrl: string, organizationId: string): string {
  const baseUrl = trimTrailingSlash(webBaseUrl);
  return `${baseUrl}/organizations/${encodeURIComponent(organizationId)}/code-reviews?platform=bitbucket`;
}
