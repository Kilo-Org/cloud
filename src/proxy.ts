import type { NextRequestWithAuth } from 'next-auth/middleware';
import { NextResponse } from 'next/server';
import { withAuthenticatedAdminApiRoutes } from './middleware/withAuthenticatedAdminApiRoutes';
import { withKiloEditorCookie } from './middleware/withKiloEditorCookie';

function baseProxy(request: NextRequestWithAuth) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-pathname', request.nextUrl.pathname);
  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}

export const proxy = withAuthenticatedAdminApiRoutes(withKiloEditorCookie(baseProxy));

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
