import type { NextRequest } from 'next/server';
import { getSlackOAuthUrl } from '@/lib/integrations/slack-service';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { handleStatefulPlatformOAuthConnect } from '@/lib/integrations/oauth/common';

export async function handleSlackOAuthConnect(request: NextRequest) {
  return handleStatefulPlatformOAuthConnect(request, {
    platform: PLATFORM.SLACK,
    source: 'slack_oauth',
    buildOAuthUrl: getSlackOAuthUrl,
  });
}
