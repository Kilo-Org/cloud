import type { NextRequestWithAuth } from 'next-auth/middleware';
import { NextResponse } from 'next/server';
import { withAuthenticatedAdminApiRoutes } from './middleware/withAuthenticatedAdminApiRoutes';
import { withBlockedClients } from './middleware/withBlockedClients';
import { withKiloEditorCookie } from './middleware/withKiloEditorCookie';
import {
  buildContentSecurityPolicy,
  getConfiguredConnectSrcOrigins,
  getContentSecurityPolicyHeaderName,
  getContentSecurityPolicyMode,
  getSecurityPolicyReportingHeaders,
} from '@/lib/security-headers';

function baseProxy(request: NextRequestWithAuth) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-pathname', request.nextUrl.pathname);

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

    for (const [name, value] of Object.entries(getSecurityPolicyReportingHeaders())) {
      response.headers.set(name, value);
    }
  }

  return response;
}

export const proxy = withBlockedClients(
  withAuthenticatedAdminApiRoutes(withKiloEditorCookie(baseProxy))
);

export const config = {
  /*
   * Match all request paths except for the ones starting with:
   * - api routes that don't need middleware
   * - _next/static (static files)
   * - _next/image (image optimization files)
   * - favicon.ico (favicon file)
   * - public folder
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
