import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { APP_URL } from '@/lib/constants';
import { PLATFORM } from '@/lib/integrations/core/constants';
import type { Owner } from '@/lib/integrations/core/types';
import { buildBitbucketOAuthUrl } from '@/lib/integrations/platforms/bitbucket/adapter';
import {
  BitbucketIntegrationRecoveryError,
  getBitbucketOAuthRecovery,
} from '@/lib/integrations/platforms/bitbucket/credentials';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import {
  buildIntegrationOAuthConnectErrorPath,
  organizationAccessDenialErrorCode,
  redirectToSignInForOAuthConnect,
} from '@/lib/integrations/oauth/common';
import { validateReturnPath } from '@/lib/integrations/validate-return-path';
import { getUserFromAuth } from '@/lib/user/server';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
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
      await ensureOrganizationAccess({ user }, owner.id, ORGANIZATION_BILLING_ROLES);
    }

    const reconnectIntegrationId = request.nextUrl.searchParams.get('reconnectIntegrationId');
    const recovery =
      reconnectIntegrationId !== null
        ? await getBitbucketOAuthRecovery(owner, reconnectIntegrationId)
        : undefined;
    const returnToParam = request.nextUrl.searchParams.get('returnTo');
    const returnTo = returnToParam ? validateReturnPath(returnToParam) : null;
    const state = createOAuthState(
      `${owner.type}_${owner.id}`,
      user.id,
      returnTo ?? undefined,
      recovery
    );
    return NextResponse.redirect(buildBitbucketOAuthUrl(state));
  } catch (error) {
    captureException(error, {
      tags: { endpoint: 'bitbucket/connect', source: 'bitbucket_oauth' },
      extra: { hasOrganizationId: Boolean(organizationId) },
    });
    const errorCode =
      error instanceof BitbucketIntegrationRecoveryError
        ? error.code
        : request.nextUrl.searchParams.has('reconnectIntegrationId') &&
            organizationAccessDenialErrorCode(error)
          ? 'unauthorized'
          : 'oauth_init_failed';
    return NextResponse.redirect(
      new URL(
        buildIntegrationOAuthConnectErrorPath(PLATFORM.BITBUCKET, organizationId, errorCode),
        APP_URL
      )
    );
  }
}
