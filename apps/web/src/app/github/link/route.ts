import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { APP_URL } from '@/lib/constants';
import { createGitHubBotLinkState } from '@/lib/bot/github-link-state';
import { verifyGitHubLinkToken } from '@/lib/bot/github-link-token';
import { getGitHubAppCredentials } from '@/lib/integrations/platforms/github/app-selector';
import { getPlatformIntegrationById } from '@/lib/bot/platform-helpers';
import { botPlatforms } from '@/lib/bot/platforms';
import { isOrganizationMember } from '@/lib/organizations/organizations';
import { PLATFORM } from '@/lib/integrations/core/constants';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_CALLBACK_PATH = '/api/integrations/github/callback';
// In production the redirect_uri must exactly match the URL registered with
// the GitHub OAuth app (app.kilocode.ai), regardless of which host the user
// hit. APP_URL points to app.kilo.ai in production, so we override it here.
// In development we keep using APP_URL so localhost works.
const GITHUB_CALLBACK_BASE_URL =
  process.env.NODE_ENV === 'production' ? 'https://app.kilocode.ai' : APP_URL;

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
  const verifiedToken = verifyGitHubLinkToken(token);

  if (!verifiedToken) {
    return errorPage(
      'Link Expired',
      'Invalid or expired GitHub link. Please return to GitHub and mention Kilo again to get a fresh link.',
      400
    );
  }

  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });

  if (authFailedResponse) {
    const signInUrl = new URL('/users/sign_in', APP_URL);
    signInUrl.searchParams.set('callbackPath', `/github/link?token=${token}`);
    return NextResponse.redirect(signInUrl);
  }

  const integration = await getPlatformIntegrationById(verifiedToken.platformIntegrationId).catch(
    () => null
  );

  if (!integration) {
    return errorPage('Link Failed', 'No matching GitHub integration was found.', 404);
  }

  if (!botPlatforms.require(PLATFORM.GITHUB).isEnabledForBot(integration)) {
    return errorPage(
      'Link Unavailable',
      'GitHub linking is not enabled for this integration.',
      404
    );
  }

  if (integration.owned_by_organization_id) {
    const isMember = await isOrganizationMember(integration.owned_by_organization_id, user.id);
    if (!isMember) {
      return errorPage(
        'Access Denied',
        'You are not a member of the organization that owns this GitHub integration.',
        403
      );
    }
  } else if (integration.owned_by_user_id && integration.owned_by_user_id !== user.id) {
    return errorPage('Access Denied', 'You are not the owner of this GitHub integration.', 403);
  }

  const appType = integration.github_app_type ?? 'standard';
  const credentials = getGitHubAppCredentials(appType);
  const authorizeUrl = new URL(GITHUB_AUTHORIZE_URL);
  authorizeUrl.searchParams.set('client_id', credentials.clientId);
  authorizeUrl.searchParams.set(
    'redirect_uri',
    new URL(GITHUB_CALLBACK_PATH, GITHUB_CALLBACK_BASE_URL).toString()
  );
  authorizeUrl.searchParams.set(
    'state',
    createGitHubBotLinkState(user.id, verifiedToken.installationId)
  );
  authorizeUrl.searchParams.set('scope', 'read:user');

  return NextResponse.redirect(authorizeUrl);
}
