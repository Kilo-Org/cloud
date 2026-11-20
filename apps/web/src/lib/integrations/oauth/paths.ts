import { PLATFORM } from '@/lib/integrations/core/constants';

/**
 * Platforms that share the generic OAuth connect and callback route pair.
 * Each one uses `/api/integrations/<platform>/connect` and
 * `/api/integrations/<platform>/callback`.
 */
export const STANDARD_OAUTH_PLATFORMS = [
  PLATFORM.DISCORD,
  PLATFORM.DOLTHUB,
  PLATFORM.GITLAB,
  PLATFORM.LINEAR,
  PLATFORM.SLACK,
] as const;

export type StandardOAuthPlatform = (typeof STANDARD_OAUTH_PLATFORMS)[number];

/**
 * Platforms whose OAuth connect the app starts and can build a connect-error
 * redirect for. This set adds Bitbucket to the standard platforms. Bitbucket
 * uses a dedicated connect handler, and its OAuth consumer registers the
 * callback URL itself, so this module builds no callback path for it.
 *
 * GitHub is in neither union. It uses the GitHub App installation flow, not
 * this OAuth connect and callback pair.
 */
export type OAuthConnectPlatform = StandardOAuthPlatform | typeof PLATFORM.BITBUCKET;

/**
 * Returns the connect path for a platform.
 *
 * `organizationId` and `returnTo` are optional. The function leaves an omitted,
 * `undefined` or empty value out of the query. It returns the bare path when
 * neither value is present.
 */
export function getPlatformOAuthConnectPath(
  platform: OAuthConnectPlatform,
  options: { organizationId?: string; returnTo?: string } = {}
): string {
  const path = `/api/integrations/${platform}/connect`;
  const { organizationId, returnTo } = options;

  if (!organizationId && !returnTo) {
    return path;
  }

  const params = new URLSearchParams();
  if (organizationId) {
    params.set('organizationId', organizationId);
  }
  if (returnTo) {
    params.set('returnTo', returnTo);
  }
  return `${path}?${params.toString()}`;
}

export function getPlatformOAuthCallbackPath(platform: StandardOAuthPlatform): string {
  return `/api/integrations/${platform}/callback`;
}
