import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getSlackOAuthUrl } from '@/lib/integrations/slack-service';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import { getUserFromAuth } from '@/lib/user.server';

export async function GET(request: NextRequest) {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse || !user) {
    const signInUrl = new URL('/users/sign_in', request.url);
    signInUrl.searchParams.set('callbackPath', request.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }

  const state = createOAuthState(`user_${user.id}`, user.id);
  return NextResponse.redirect(getSlackOAuthUrl(state));
}
