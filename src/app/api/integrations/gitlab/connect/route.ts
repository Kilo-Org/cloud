import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { captureException } from '@sentry/nextjs';
import { buildGitLabOAuthUrl } from '@/lib/integrations/platforms/gitlab/adapter';

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

    let state: string;

    if (organizationId) {
      await ensureOrganizationAccess({ user }, organizationId);
      state = `org_${organizationId}`;
    } else {
      state = `user_${user.id}`;
    }

    if (instanceUrl && instanceUrl !== 'https://gitlab.com') {
      state = `${state}|${instanceUrl}`;
    }

    if (clientId && clientSecret) {
      const encodedCreds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      state = `${state}|creds:${encodedCreds}`;
    }

    const customCredentials = clientId && clientSecret ? { clientId, clientSecret } : undefined;
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
