import 'server-only';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { PLATFORM } from '@/lib/integrations/core/constants';

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
  switch (platform) {
    case PLATFORM.DISCORD:
      return (
        await import('@/lib/integrations/oauth/platforms/discord-connect')
      ).handleDiscordOAuthConnect(request);
    case PLATFORM.DOLTHUB:
      return (
        await import('@/lib/integrations/oauth/platforms/dolthub-connect')
      ).handleDoltHubOAuthConnect(request);
    case PLATFORM.GITLAB:
      return (
        await import('@/lib/integrations/oauth/platforms/gitlab-connect')
      ).handleGitLabOAuthConnect(request);
    case PLATFORM.LINEAR:
      return (
        await import('@/lib/integrations/oauth/platforms/linear-connect')
      ).handleLinearOAuthConnect(request);
    case PLATFORM.SLACK:
      return (
        await import('@/lib/integrations/oauth/platforms/slack-connect')
      ).handleSlackOAuthConnect(request);
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
