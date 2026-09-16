import { getUserFromSession, nextAuthHttpHandler } from '@/lib/user/server';
import { NextRequest, NextResponse } from 'next/server';

/**
 * The OpenAI OAuth client is registered with the callback path
 * `/testing/oai-redirect` (see `OPENAI_REDIRECT_PATH`). NextAuth only knows how
 * to complete a callback at `/api/auth/callback/<provider>`, so this route
 * rewrites the request to that path before delegating.
 *
 * Every NextAuth 4 cookie uses `path: '/'`, so the state, PKCE and nonce
 * cookies set when the sign-in started are present here.
 *
 * Nothing on this path is trusted before the token exchange: no claim is read
 * and no account is matched until NextAuth has verified the ID token.
 */
const NEXT_AUTH_CALLBACK_PATH = '/api/auth/callback/openai';

async function handler(request: NextRequest, context: unknown) {
  const errorCode = request.nextUrl.searchParams.get('error');

  // A declined or failed connect should return a signed-in person to the BYOK
  // page rather than to the sign-in page. Only a real session can select that
  // destination; without one the request falls through to NextAuth, which
  // surfaces the error on its own terms.
  if (errorCode) {
    const session = await getUserFromSession();
    if (session) {
      const redirectUrl = new URL('/byok', request.nextUrl.origin);
      redirectUrl.searchParams.set('openai_error', errorCode);
      return NextResponse.redirect(redirectUrl);
    }
  }

  const rewrittenUrl = request.nextUrl.clone();
  rewrittenUrl.pathname = NEXT_AUTH_CALLBACK_PATH;
  return nextAuthHttpHandler(new NextRequest(rewrittenUrl, request), context);
}

export { handler as GET };
