import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { captureException } from '@sentry/nextjs';
import { buildGitLabOAuthUrl } from '@/lib/integrations/platforms/gitlab/adapter';
import {
  createGitLabOAuthState,
  DEFAULT_GITLAB_OAUTH_INSTANCE_URL,
} from '@/lib/integrations/platforms/gitlab/oauth-state';
import { storeGitLabOAuthCredentials } from '@/lib/integrations/platforms/gitlab/oauth-credentials';
import { PLATFORM } from '@/lib/integrations/core/constants';
import {
  buildIntegrationOAuthConnectErrorPath,
  redirectToSignInForOAuthConnect,
  resolveOAuthConnectOwner,
} from '@/lib/integrations/oauth/common';

/**
 * GitLab OAuth Connect
 *
 * Initiates the GitLab OAuth authorization flow.
 * Redirects the user to GitLab's authorization page.
 *
 * Query parameters:
 * - organizationId: (optional) Organization ID for org-owned integrations
 * - instanceUrl: (optional) Self-hosted GitLab instance URL
 * - clientId: (optional) Custom OAuth client ID for self-hosted instances
 * - clientSecret: (optional) Custom OAuth client secret for self-hosted instances
 */
export async function handleGitLabOAuthConnect(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get('organizationId');

  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return redirectToSignInForOAuthConnect(request);
    }

    const searchParams = request.nextUrl.searchParams;
    const instanceUrl = searchParams.get('instanceUrl') || undefined;
    const clientId = searchParams.get('clientId') || undefined;
    const clientSecret = searchParams.get('clientSecret') || undefined;

    const { owner } = await resolveOAuthConnectOwner(request, user);

    const customCredentials = clientId && clientSecret ? { clientId, clientSecret } : undefined;
    const usesCustomInstance = !!instanceUrl && instanceUrl !== DEFAULT_GITLAB_OAUTH_INSTANCE_URL;

    if (usesCustomInstance && !customCredentials) {
      throw new Error('Custom GitLab OAuth credentials are required for self-hosted instances');
    }

    const customCredentialsRef = customCredentials
      ? await storeGitLabOAuthCredentials(customCredentials)
      : undefined;

    if (customCredentials && !customCredentialsRef) {
      throw new Error('GitLab OAuth credentials cache is unavailable');
    }

    const state = createGitLabOAuthState(
      {
        owner,
        ...(usesCustomInstance ? { instanceUrl } : {}),
        ...(customCredentialsRef ? { customCredentialsRef } : {}),
      },
      user.id
    );
    const oauthUrl = buildGitLabOAuthUrl(state, instanceUrl, customCredentials);

    return NextResponse.redirect(oauthUrl);
  } catch (error) {
    console.error('Error initiating GitLab OAuth:', error);

    captureException(error, {
      tags: {
        endpoint: 'gitlab/connect',
        source: 'gitlab_oauth',
      },
    });

    return NextResponse.redirect(
      new URL(
        buildIntegrationOAuthConnectErrorPath(PLATFORM.GITLAB, organizationId, 'oauth_init_failed'),
        request.url
      )
    );
  }
}
