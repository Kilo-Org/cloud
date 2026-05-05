import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { APP_URL } from '@/lib/constants';
import { createGitHubBotLinkState } from '@/lib/bot/github-link-state';
import { getGitHubAppCredentials } from '@/lib/integrations/platforms/github/app-selector';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_CALLBACK_PATH = '/api/integrations/github/callback';

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
  const installationId = request.nextUrl.searchParams.get('installation_id');

  if (!installationId) {
    return errorPage(
      'Bad Request',
      'Missing GitHub installation context. Please use the link from the GitHub bot reply.',
      400
    );
  }

  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });

  if (authFailedResponse) {
    const signInUrl = new URL('/users/sign_in', APP_URL);
    signInUrl.searchParams.set('callbackPath', `/github/link?installation_id=${installationId}`);
    return NextResponse.redirect(signInUrl);
  }

  const credentials = getGitHubAppCredentials('standard');
  const authorizeUrl = new URL(GITHUB_AUTHORIZE_URL);
  authorizeUrl.searchParams.set('client_id', credentials.clientId);
  authorizeUrl.searchParams.set('redirect_uri', new URL(GITHUB_CALLBACK_PATH, APP_URL).toString());
  authorizeUrl.searchParams.set('state', createGitHubBotLinkState(user.id, installationId));
  authorizeUrl.searchParams.set('scope', 'read:user');

  return NextResponse.redirect(authorizeUrl);
}
