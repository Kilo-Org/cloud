import type { NextRequest } from 'next/server';
import { getDoltHubOAuthUrl } from '@/lib/integrations/dolthub-service';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { handleStatefulPlatformOAuthConnect } from '@/lib/integrations/oauth/common';

/**
 * DoltHub OAuth Connect
 *
 * Initiates the DoltHub OAuth authorization flow.
 * Redirects the user to DoltHub's authorization page.
 *
 * Query parameters:
 * - organizationId: (optional) Organization ID for org-owned integrations
 */
export async function handleDoltHubOAuthConnect(request: NextRequest) {
  return handleStatefulPlatformOAuthConnect(request, {
    platform: PLATFORM.DOLTHUB,
    source: 'dolthub_oauth',
    buildOAuthUrl: getDoltHubOAuthUrl,
  });
}
