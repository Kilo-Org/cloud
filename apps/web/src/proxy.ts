import type { NextRequestWithAuth } from 'next-auth/middleware';
import { NextResponse } from 'next/server';
import { withAuthenticatedAdminApiRoutes } from './middleware/withAuthenticatedAdminApiRoutes';
import { withBlockedClients } from './middleware/withBlockedClients';
import { withKiloEditorCookie } from './middleware/withKiloEditorCookie';
import {
  buildContentSecurityPolicy,
  createCspNonce,
  CSP_NONCE_HEADER,
  getConfiguredConnectSrcOrigins,
} from '@/lib/security-headers';

function baseProxy(request: NextRequestWithAuth) {
  const nonce = createCspNonce();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-pathname', request.nextUrl.pathname);
  requestHeaders.set(CSP_NONCE_HEADER, nonce);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  response.headers.set(
    'Content-Security-Policy',
    buildContentSecurityPolicy({
      nonce,
      isDevelopment: process.env.NODE_ENV === 'development',
      connectSrcUrls: getConfiguredConnectSrcOrigins(),
    })
  );

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
