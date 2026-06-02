import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { getPlatformOAuthConnectPath } from '@/lib/integrations/oauth/paths';

export async function GET(request: NextRequest) {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse || !user) {
    const signInUrl = new URL('/users/sign_in', request.url);
    signInUrl.searchParams.set('callbackPath', request.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.redirect(new URL(getPlatformOAuthConnectPath(PLATFORM.LINEAR), request.url));
}
