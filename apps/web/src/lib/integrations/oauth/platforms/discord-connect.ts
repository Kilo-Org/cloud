import type { NextRequest } from 'next/server';
import { getDiscordOAuthUrl } from '@/lib/integrations/discord-service';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { handleStatefulPlatformOAuthConnect } from '@/lib/integrations/oauth/common';

export async function handleDiscordOAuthConnect(request: NextRequest) {
  return handleStatefulPlatformOAuthConnect(request, {
    platform: PLATFORM.DISCORD,
    source: 'discord_oauth',
    buildOAuthUrl: getDiscordOAuthUrl,
  });
}
