import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { captureException } from '@sentry/nextjs';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import { getDoltHubOAuthUrl } from '@/lib/integrations/dolthub-service';
import { APP_URL, IS_DEVELOPMENT } from '@/lib/constants';

/**
 * DoltHub OAuth Connect
 *
 * Initiates the DoltHub OAuth authorization flow.
 * Redirects the user to DoltHub's authorization page.
 *
 * Query parameters:
 * - organizationId: (optional) Organization ID for org-owned integrations
 */
export async function GET(request: NextRequest) {
  if (!IS_DEVELOPMENT) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return authFailedResponse;
    }

    const searchParams = request.nextUrl.searchParams;
    const organizationId = searchParams.get('organizationId');

    let stateOwner: string;

    if (organizationId) {
      await ensureOrganizationAccess({ user }, organizationId);
      stateOwner = `org_${organizationId}`;
    } else {
      stateOwner = `user_${user.id}`;
    }

    const state = createOAuthState(stateOwner, user.id);
    const oauthUrl = getDoltHubOAuthUrl(state);

    return NextResponse.redirect(oauthUrl);
  } catch (error) {
    console.error('Error initiating DoltHub OAuth:', error);

    captureException(error, {
      tags: {
        endpoint: 'dolthub/connect',
        source: 'dolthub_oauth',
      },
    });

    const searchParams = request.nextUrl.searchParams;
    const organizationId = searchParams.get('organizationId');

    const errorPath = organizationId
      ? `/organizations/${organizationId}/integrations/dolthub?error=oauth_init_failed`
      : '/integrations/dolthub?error=oauth_init_failed';

    return NextResponse.redirect(new URL(errorPath, APP_URL));
  }
}
