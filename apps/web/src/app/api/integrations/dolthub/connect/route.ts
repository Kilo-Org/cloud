import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { captureException } from '@sentry/nextjs';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import { getDoltHubOAuthUrl } from '@/lib/integrations/dolthub-service';
import { APP_URL } from '@/lib/constants';

function buildConnectErrorPath(organizationId: string | null, errorCode: string): string {
  if (organizationId) {
    return `/organizations/${organizationId}/integrations/dolthub?error=${encodeURIComponent(errorCode)}`;
  }
  return `/integrations/dolthub?error=${encodeURIComponent(errorCode)}`;
}

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
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }

  let organizationId: string | null = null;

  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return authFailedResponse;
    }

    const searchParams = request.nextUrl.searchParams;
    const organizationIdParam = searchParams.get('organizationId');

    let ownerKey: string;

    if (organizationIdParam) {
      await ensureOrganizationAccess({ user }, organizationIdParam);
      organizationId = organizationIdParam;
      ownerKey = `org_${organizationIdParam}`;
    } else {
      ownerKey = `user_${user.id}`;
    }

    const state = createOAuthState(ownerKey, user.id);
    const oauthUrl = getDoltHubOAuthUrl(state);

    return NextResponse.redirect(oauthUrl);
  } catch (error) {
    captureException(error, {
      tags: {
        endpoint: 'dolthub/connect',
        source: 'dolthub_oauth',
      },
      extra: {
        organizationId,
      },
    });

    const searchParams = request.nextUrl.searchParams;
    const fallbackOrgId = searchParams.get('organizationId');

    return NextResponse.redirect(
      new URL(buildConnectErrorPath(fallbackOrgId, 'oauth_init_failed'), APP_URL)
    );
  }
}
