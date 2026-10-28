import { nextAuthHttpHandler } from '@/lib/user/next-auth-options';
import { NextRequest } from 'next/server';

// GitHub recently started appending `&iss=https://github.com/login/oauth` to
// their OAuth callback URL (per RFC 9207). NextAuth v4's openid-client sees
// the `iss` param and tries to validate it, but GithubProvider has no issuer
// configured (it's plain OAuth, not OIDC), causing the error: "issuer must be
// configured on the issuer". Stripping the param before NextAuth processes it
// fixes the issue without reducing security — we already validate `state`.
function stripGitHubIssParam(request: NextRequest): NextRequest {
  const url = request.nextUrl.clone();
  if (url.pathname.includes('/callback/github') && url.searchParams.has('iss')) {
    url.searchParams.delete('iss');
    return new NextRequest(url, request);
  }
  return request;
}

async function handler(request: NextRequest, context: { params: Promise<{ nextauth: string[] }> }) {
  if (request.method === 'GET') {
    const { nextauth } = await context.params;
    const [action, provider] = nextauth;

    // NextAuth v4 returns 500 for unsupported GET callbacks to credentials providers.
    if (action === 'callback' && (provider === 'email' || provider === 'passkey')) {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
    }
  }

  return nextAuthHttpHandler(stripGitHubIssParam(request), context);
}

export { handler as GET, handler as POST };
