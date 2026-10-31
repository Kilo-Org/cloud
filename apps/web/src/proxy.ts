import type { NextRequestWithAuth } from 'next-auth/middleware';
import { NextResponse, type ProxyConfig } from 'next/server';
import { withAuthenticatedAdminApiRoutes } from './middleware/withAuthenticatedAdminApiRoutes';
import { withKiloEditorCookie } from './middleware/withKiloEditorCookie';
import {
  buildContentSecurityPolicy,
  getConfiguredConnectSrcOrigins,
  getContentSecurityPolicyHeaderName,
  getContentSecurityPolicyMode,
} from '@/lib/security-headers';

function baseProxy(request: NextRequestWithAuth) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-pathname', request.nextUrl.pathname);
  // The query, kept separate from the pathname: `appendCallbackPath` re-attaches
  // it to the sign-in callback so a resume link does not lose its `?at=` anchor
  // (and the browser does not lose any other query) across the sign-in detour.
  requestHeaders.set('x-search', request.nextUrl.search);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  if (request.nextUrl.pathname === '/auth/verify-magic-link') {
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Robots-Tag', 'noindex, noarchive, nofollow');
  }

  const cspHeaderName = getContentSecurityPolicyHeaderName(getContentSecurityPolicyMode());
  if (cspHeaderName) {
    response.headers.set(
      cspHeaderName,
      buildContentSecurityPolicy({
        isDevelopment: process.env.NODE_ENV === 'development',
        connectSrcUrls: getConfiguredConnectSrcOrigins(),
      })
    );
  }

  return response;
}

export const proxy = withAuthenticatedAdminApiRoutes(withKiloEditorCookie(baseProxy));

export const config: ProxyConfig = {
  matcher: [
    {
      // Preserve the original proxy behavior on production, preview and local hosts.
      source: '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
      missing: [{ type: 'host', value: 'staging-app\\.kilo\\.ai' }],
    },
    {
      // Only the canonical staging host skips the self-authenticating writer route.
      source:
        '/((?!api/internal/usage/record/?$|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
      has: [{ type: 'host', value: 'staging-app\\.kilo\\.ai' }],
    },
  ],
};
