import { PLATFORM, type Platform } from '@/lib/integrations/core/constants';

export const STANDARD_OAUTH_PLATFORMS = [
  PLATFORM.DISCORD,
  PLATFORM.DOLTHUB,
  PLATFORM.GITLAB,
  PLATFORM.LINEAR,
  PLATFORM.SLACK,
] as const;

export type StandardOAuthPlatform = (typeof STANDARD_OAUTH_PLATFORMS)[number];

const STANDARD_OAUTH_PLATFORM_SET: ReadonlySet<string> = new Set(STANDARD_OAUTH_PLATFORMS);

export function isStandardOAuthPlatform(platform: string): platform is StandardOAuthPlatform {
  return STANDARD_OAUTH_PLATFORM_SET.has(platform);
}

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

export function isPlatformOAuthSupported(platform: Platform): platform is StandardOAuthPlatform {
  return isStandardOAuthPlatform(platform);
}
