import type { NextFetchEvent } from 'next/server';
import type { MiddlewareFactory } from '@/middleware/types';
import type { NextRequestWithAuth } from 'next-auth/middleware';
import { withAuth } from 'next-auth/middleware';

export const withAuthenticatedAdminApiRoutes: MiddlewareFactory = nextMiddleware => {
  return async (request: NextRequestWithAuth, nextFetchEvent: NextFetchEvent) => {
    if (
      request.nextUrl.pathname.startsWith('/admin/api/') &&
      !request.nextUrl.pathname.startsWith('/admin/api/users/add-credit') &&
      !request.nextUrl.pathname.startsWith('/admin/api/enrichment-data') &&
      !request.nextUrl.pathname.startsWith('/admin/api/users')
    ) {
      return withAuth(nextMiddleware, {
        callbacks: {
          authorized: ({ token }) => !!token?.isAdmin,
        },
      })(request, nextFetchEvent);
    } else {
      return await nextMiddleware(request, nextFetchEvent);
    }
  };
};
