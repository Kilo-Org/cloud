import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createGitLabBotLinkState } from '@/lib/bot/gitlab-link-state';
import { verifyGitLabLinkToken } from '@/lib/bot/gitlab-link-token';
import {
  canKiloUserAccessPlatformIntegration,
  getPlatformIntegrationById,
} from '@/lib/bot/platform-helpers';
import { botPlatforms } from '@/lib/bot/platforms';
import { APP_URL } from '@/lib/constants';
import { getUserFromAuth } from '@/lib/user.server';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { buildGitLabOAuthUrl } from '@/lib/integrations/platforms/gitlab/adapter';
import type { GitLabIntegrationMetadata } from '@/lib/integrations/gitlab-service';

function errorPage(title: string, message: string, status: number): Response {
  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
  <h1>${title}</h1>
  <p>${message}</p>
</div>
</body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  const verifiedToken = verifyGitLabLinkToken(token);

  if (!verifiedToken) {
    return errorPage(
      'Link Expired',
      'Invalid or expired GitLab link. Please return to GitLab and mention Kilo again to get a fresh link.',
      400
    );
  }

  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });

  if (authFailedResponse) {
    const signInUrl = new URL('/users/sign_in', APP_URL);
    signInUrl.searchParams.set('callbackPath', `/gitlab/link?token=${token}`);
    return NextResponse.redirect(signInUrl);
  }

  const integration = await getPlatformIntegrationById(verifiedToken.platformIntegrationId).catch(
    () => null
  );

  if (!integration) {
    return errorPage('Link Failed', 'No matching GitLab integration was found.', 404);
  }

  if (integration.platform !== PLATFORM.GITLAB || integration.id !== verifiedToken.integrationId) {
    return errorPage('Link Failed', 'No matching GitLab integration was found.', 404);
  }

  if (!botPlatforms.require(PLATFORM.GITLAB).isEnabledForBot(integration)) {
    return errorPage(
      'Link Unavailable',
      'GitLab linking is not enabled for this integration.',
      404
    );
  }

  if (!(await canKiloUserAccessPlatformIntegration(integration, user.id))) {
    return errorPage('Access Denied', 'You do not have access to this GitLab integration.', 403);
  }

  const metadata = integration.metadata as GitLabIntegrationMetadata | null;
  const instanceUrl = metadata?.gitlab_instance_url || 'https://gitlab.com';
  const customCredentials =
    metadata?.client_id && metadata.client_secret
      ? { clientId: metadata.client_id, clientSecret: metadata.client_secret }
      : undefined;
  const state = createGitLabBotLinkState({
    userId: user.id,
    platformIntegrationId: integration.id,
  });

  return NextResponse.redirect(
    buildGitLabOAuthUrl(state, instanceUrl, customCredentials, ['read_user'])
  );
}
