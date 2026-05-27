import 'server-only';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { PLATFORM } from '@/lib/integrations/core/constants';
import {
  handleStatefulPlatformOAuthConnect,
  type HandleStatefulOAuthConnectOptions,
} from '@/lib/integrations/oauth/common';
import type { StandardOAuthPlatform } from '@/lib/integrations/oauth/paths';

type StatefulOAuthConnectRouteConfig = Omit<
  HandleStatefulOAuthConnectOptions,
  'platform' | 'buildOAuthUrl'
> & {
  loadBuildOAuthUrl: () => Promise<HandleStatefulOAuthConnectOptions['buildOAuthUrl']>;
};

const statefulOAuthConnectRouteConfigEntries = [
  [
    PLATFORM.DISCORD,
    {
      source: 'discord_oauth',
      loadBuildOAuthUrl: async () =>
        (await import('@/lib/integrations/discord-service')).getDiscordOAuthUrl,
    },
  ],
  [
    PLATFORM.DOLTHUB,
    {
      source: 'dolthub_oauth',
      loadBuildOAuthUrl: async () =>
        (await import('@/lib/integrations/dolthub-service')).getDoltHubOAuthUrl,
    },
  ],
  [
    PLATFORM.LINEAR,
    {
      source: 'linear_oauth',
      loadBuildOAuthUrl: async () =>
        (await import('@/lib/integrations/linear-service')).getLinearOAuthUrl,
      organizationRoles: ['owner', 'billing_manager'],
      requireActiveOrganizationSubscription: true,
    },
  ],
  [
    PLATFORM.SLACK,
    {
      source: 'slack_oauth',
      loadBuildOAuthUrl: async () =>
        (await import('@/lib/integrations/slack-service')).getSlackOAuthUrl,
    },
  ],
] as const satisfies readonly (readonly [StandardOAuthPlatform, StatefulOAuthConnectRouteConfig])[];

const statefulOAuthConnectRouteConfigs = new Map<string, StatefulOAuthConnectRouteConfig>(
  statefulOAuthConnectRouteConfigEntries
);

function isStatefulOAuthConnectPlatform(platform: string): platform is StandardOAuthPlatform {
  return statefulOAuthConnectRouteConfigs.has(platform);
}

function unsupportedOAuthRoute(platform: string, action: 'connect' | 'callback'): Response {
  return NextResponse.json(
    { error: `OAuth ${action} is not supported for platform '${platform}'` },
    { status: 404 }
  );
}

export async function handlePlatformOAuthConnect(
  request: NextRequest,
  platform: string
): Promise<Response> {
  if (platform === PLATFORM.GITLAB) {
    return (
      await import('@/lib/integrations/oauth/platforms/gitlab-connect')
    ).handleGitLabOAuthConnect(request);
  }

  if (!isStatefulOAuthConnectPlatform(platform)) {
    return unsupportedOAuthRoute(platform, 'connect');
  }

  const config = statefulOAuthConnectRouteConfigs.get(platform);
  if (!config) {
    return unsupportedOAuthRoute(platform, 'connect');
  }

  const { loadBuildOAuthUrl, ...connectOptions } = config;
  const buildOAuthUrl = await loadBuildOAuthUrl();
  return handleStatefulPlatformOAuthConnect(request, {
    ...connectOptions,
    platform,
    buildOAuthUrl,
  });
}

export async function handlePlatformOAuthConnectPost(
  request: NextRequest,
  platform: string
): Promise<Response> {
  switch (platform) {
    case PLATFORM.GITLAB:
      return (
        await import('@/lib/integrations/oauth/platforms/gitlab-connect')
      ).handleGitLabOAuthConnectPost(request);
    default:
      return unsupportedOAuthRoute(platform, 'connect');
  }
}

export async function handlePlatformOAuthCallback(
  request: NextRequest,
  platform: string
): Promise<Response> {
  switch (platform) {
    case PLATFORM.DISCORD:
      return (
        await import('@/lib/integrations/oauth/platforms/discord-callback')
      ).handleDiscordOAuthCallback(request);
    case PLATFORM.DOLTHUB:
      return (
        await import('@/lib/integrations/oauth/platforms/dolthub-callback')
      ).handleDoltHubOAuthCallback(request);
    case PLATFORM.GITLAB:
      return (
        await import('@/lib/integrations/oauth/platforms/gitlab-callback')
      ).handleGitLabOAuthCallback(request);
    case PLATFORM.LINEAR:
      return (
        await import('@/lib/integrations/oauth/platforms/linear-callback')
      ).handleLinearOAuthCallback(request);
    case PLATFORM.SLACK:
      return (
        await import('@/lib/integrations/oauth/platforms/slack-callback')
      ).handleSlackOAuthCallback(request);
    default:
      return unsupportedOAuthRoute(platform, 'callback');
  }
}
