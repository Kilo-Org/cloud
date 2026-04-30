import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getSlackOAuthUrl } from '@/lib/integrations/slack-service';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import { getUserFromAuth } from '@/lib/user.server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse || !user) {
    const signInUrl = new URL('/users/sign_in', request.url);
    signInUrl.searchParams.set('callbackPath', request.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }

  try {
    await ensureOrganizationAccess({ user }, id);
  } catch {
    return NextResponse.redirect(new URL('/integrations?error=unauthorized', request.url));
  }

  const state = createOAuthState(`org_${id}`, user.id);
  return NextResponse.redirect(getSlackOAuthUrl(state));
}
