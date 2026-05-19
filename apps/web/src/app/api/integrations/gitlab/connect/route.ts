import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { captureException } from '@sentry/nextjs';
import { buildGitLabOAuthUrl } from '@/lib/integrations/platforms/gitlab/adapter';
import {
  createGitLabOAuthState,
  DEFAULT_GITLAB_OAUTH_INSTANCE_URL,
} from '@/lib/integrations/platforms/gitlab/oauth-state';
import type { Owner } from '@/lib/integrations/core/types';

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
export async function GET(request: NextRequest) {
  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return authFailedResponse;
    }

    const searchParams = request.nextUrl.searchParams;
    const organizationId = searchParams.get('organizationId');
    const instanceUrl = searchParams.get('instanceUrl') || undefined;
    const clientId = searchParams.get('clientId') || undefined;
    const clientSecret = searchParams.get('clientSecret') || undefined;

    let owner: Owner;

    if (organizationId) {
      await ensureOrganizationAccess({ user }, organizationId);
      owner = { type: 'org', id: organizationId };
    } else {
      owner = { type: 'user', id: user.id };
    }

    const customCredentials = clientId && clientSecret ? { clientId, clientSecret } : undefined;
    const usesCustomInstance = !!instanceUrl && instanceUrl !== DEFAULT_GITLAB_OAUTH_INSTANCE_URL;

    if (usesCustomInstance && !customCredentials) {
      throw new Error('Custom GitLab OAuth credentials are required for self-hosted instances');
    }

    const state = createGitLabOAuthState(
      {
        owner,
        ...(usesCustomInstance ? { instanceUrl } : {}),
        ...(customCredentials ? { customCredentials } : {}),
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

    const searchParams = request.nextUrl.searchParams;
    const organizationId = searchParams.get('organizationId');

    const errorPath = organizationId
      ? `/organizations/${organizationId}/integrations/gitlab?error=oauth_init_failed`
      : '/integrations/gitlab?error=oauth_init_failed';

    return NextResponse.redirect(new URL(errorPath, request.url));
  }
}
