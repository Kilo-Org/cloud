import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { APP_URL } from '@/lib/constants';
import { PLATFORM } from '@/lib/integrations/core/constants';
import type { Owner } from '@/lib/integrations/core/types';
import { buildBitbucketOAuthUrl } from '@/lib/integrations/platforms/bitbucket/adapter';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import {
  buildIntegrationOAuthConnectErrorPath,
  redirectToSignInForOAuthConnect,
} from '@/lib/integrations/oauth/common';
import { validateReturnPath } from '@/lib/integrations/validate-return-path';
import { getUserFromAuth } from '@/lib/user/server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';

function detailPath(organizationId: string | null): string {
  return organizationId
    ? `/organizations/${organizationId}/integrations/bitbucket`
    : '/integrations/bitbucket';
}

export async function handleBitbucketOAuthConnect(request: NextRequest): Promise<Response> {
  const organizationId = request.nextUrl.searchParams.get('organizationId');

  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return redirectToSignInForOAuthConnect(request, detailPath(organizationId));
    }

    const owner: Owner = organizationId
      ? { type: 'org', id: organizationId }
      : { type: 'user', id: user.id };
    if (owner.type === 'org') {
      await ensureOrganizationAccess({ user }, owner.id, ['owner', 'billing_manager']);
    }

    const returnToParam = request.nextUrl.searchParams.get('returnTo');
    const returnTo = returnToParam ? validateReturnPath(returnToParam) : null;
    const state = createOAuthState(`${owner.type}_${owner.id}`, user.id, returnTo ?? undefined);
    return NextResponse.redirect(buildBitbucketOAuthUrl(state));
  } catch (error) {
    captureException(error, {
      tags: { endpoint: 'bitbucket/connect', source: 'bitbucket_oauth' },
      extra: { hasOrganizationId: Boolean(organizationId) },
    });
    return NextResponse.redirect(
      new URL(
        buildIntegrationOAuthConnectErrorPath(
          PLATFORM.BITBUCKET,
          organizationId,
          'oauth_init_failed'
        ),
        APP_URL
      )
    );
  }
}
