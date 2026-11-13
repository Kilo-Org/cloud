function trimTrailingSlash(webBaseUrl: string): string {
  return webBaseUrl.endsWith('/') ? webBaseUrl.slice(0, -1) : webBaseUrl;
}

/** The platforms whose connect flow starts on the web (OAuth callbacks land
 *  there, never in the app), so the app hands the browser the page that owns it. */
type IntegrationPagePlatform = 'github' | 'slack' | 'gitlab' | 'discord' | 'linear' | 'bitbucket';

/**
 * The web path that owns a platform's connect flow: `apps/web`'s
 * `integrations/[platform]` and `organizations/[id]/integrations/[platform]`
 * routes. Returned as a path so callers can hand it to a procedure's
 * `returnTo` as well as build a full URL from it.
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

export function getGitLabIntegrationUrl(webBaseUrl: string, organizationId?: string): string {
  return getIntegrationPageUrl(webBaseUrl, 'gitlab', organizationId);
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
