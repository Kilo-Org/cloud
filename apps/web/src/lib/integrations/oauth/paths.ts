import { PLATFORM } from '@/lib/integrations/core/constants';

export const STANDARD_OAUTH_PLATFORMS = [
  PLATFORM.DISCORD,
  PLATFORM.DOLTHUB,
  PLATFORM.GITLAB,
  PLATFORM.LINEAR,
  PLATFORM.SLACK,
] as const;

export type StandardOAuthPlatform = (typeof STANDARD_OAUTH_PLATFORMS)[number];

export function getPlatformOAuthConnectPath(
  platform: StandardOAuthPlatform,
  organizationId?: string
): string {
  const path = `/api/integrations/${platform}/connect`;

  if (!organizationId) {
    return path;
  }

  const params = new URLSearchParams({ organizationId });
  return `${path}?${params.toString()}`;
}

export function getPlatformOAuthCallbackPath(platform: StandardOAuthPlatform): string {
  return `/api/integrations/${platform}/callback`;
}
