import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { requireActiveSubscriptionOrTrial } from '@/lib/organizations/trial-middleware';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { getPlatformOAuthConnectPath } from '@/lib/integrations/oauth/paths';

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
    await ensureOrganizationAccess({ user }, id, ['owner', 'billing_manager']);
    await requireActiveSubscriptionOrTrial(id);
  } catch {
    return NextResponse.redirect(new URL('/integrations?error=unauthorized', request.url));
  }

  return NextResponse.redirect(
    new URL(getPlatformOAuthConnectPath(PLATFORM.LINEAR, id), request.url)
  );
}
