import { getProfileRedirectPath, getUserFromAuth } from '@/lib/user.server';
import { isValidCallbackPath } from '@/lib/getSignInCallbackUrl';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { APP_URL } from '@/lib/constants';

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const { user } = await getUserFromAuth({ adminOnly: false, DANGEROUS_allowBlockedUsers: true });

  let responsePath: string;

  if (!user) {
    responsePath = '/users/sign_in';
  } else if (user.blocked_reason) {
    responsePath = '/account-blocked';
  } else {
    const callbackPath = url.searchParams.get('callbackPath');
    if (callbackPath && isValidCallbackPath(callbackPath)) {
      responsePath = callbackPath;
    } else if (url.searchParams.get('source')) {
      // this is passed through by the sign-in page via cookie, too
      responsePath = '/sign-in-to-editor';
    } else {
      responsePath = await getProfileRedirectPath(user);
    }

    if (user.has_validation_stytch === null) {
      // For new users needing verification, only pass callbackPath if explicitly provided.
      // Otherwise, account-verification will redirect to /get-started by default.
      if (callbackPath && isValidCallbackPath(callbackPath)) {
        responsePath = `/account-verification?callbackPath=${encodeURIComponent(callbackPath)}`;
      } else {
        responsePath = '/account-verification';
      }
    }
  }

  return NextResponse.redirect(new URL(responsePath, APP_URL));
}
