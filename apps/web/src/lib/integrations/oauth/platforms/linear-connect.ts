import type { NextRequest } from 'next/server';
import { getLinearOAuthUrl } from '@/lib/integrations/linear-service';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { handleStatefulPlatformOAuthConnect } from '@/lib/integrations/oauth/common';

export async function handleLinearOAuthConnect(request: NextRequest) {
  return handleStatefulPlatformOAuthConnect(request, {
    platform: PLATFORM.LINEAR,
    source: 'linear_oauth',
    buildOAuthUrl: getLinearOAuthUrl,
    organizationRoles: ['owner', 'billing_manager'],
    requireActiveOrganizationSubscription: true,
  });
}
