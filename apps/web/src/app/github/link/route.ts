import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { APP_URL } from '@/lib/constants';
import { createGitHubBotLinkState } from '@/lib/bot/github-link-state';
import { getGitHubAppCredentials } from '@/lib/integrations/platforms/github/app-selector';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_CALLBACK_PATH = '/api/integrations/github/callback';

export async function GET(_request: NextRequest) {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });

  if (authFailedResponse) {
    const signInUrl = new URL('/users/sign_in', APP_URL);
    signInUrl.searchParams.set('callbackPath', '/github/link');
    return NextResponse.redirect(signInUrl);
  }

  const credentials = getGitHubAppCredentials('standard');
  const authorizeUrl = new URL(GITHUB_AUTHORIZE_URL);
  authorizeUrl.searchParams.set('client_id', credentials.clientId);
  authorizeUrl.searchParams.set('redirect_uri', new URL(GITHUB_CALLBACK_PATH, APP_URL).toString());
  authorizeUrl.searchParams.set('state', createGitHubBotLinkState(user.id));
  authorizeUrl.searchParams.set('scope', 'read:user');

  return NextResponse.redirect(authorizeUrl);
}
