import type { NextFetchEvent } from 'next/server';
import type { MiddlewareFactory } from '@/middleware/types';
import type { NextRequestWithAuth } from 'next-auth/middleware';
import { withAuth } from 'next-auth/middleware';

/**
 * Each path below belongs to a handler that verifies admin access itself with
 * `getUserFromAuth({ adminOnly: true })`, so the middleware lets the request
 * through. `[id]` matches one dynamic segment. A new handler must add its exact
 * path here together with that verification, or leave the path out and let the
 * middleware apply its own admin check.
 */
const ADMIN_API_ROUTES_WITH_OWN_ADMIN_CHECK = [
  '/admin/api/enrichment-data/upsert',
  '/admin/api/users',
  '/admin/api/users/add-credit',
  '/admin/api/users/credit-transactions',
  '/admin/api/users/gdpr-removal',
  '/admin/api/users/heuristic-analysis/grouped',
  '/admin/api/users/heuristic-analysis/raw',
  '/admin/api/users/payment-methods',
  '/admin/api/users/[id]/dev/insert-usage-record',
  '/admin/api/users/[id]/kill-balance-cache',
  '/admin/api/users/[id]/referrals',
];

function toRoutePattern(route: string): string {
  return route
    .split('/')
    .map(segment => (segment === '[id]' ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
}

// One optional trailing slash keeps a listed handler reachable through the
// request path Next.js serves it on.
const ADMIN_API_ROUTE_WITH_OWN_ADMIN_CHECK = new RegExp(
  `^(?:${ADMIN_API_ROUTES_WITH_OWN_ADMIN_CHECK.map(toRoutePattern).join('|')})/?$`
);

export const withAuthenticatedAdminApiRoutes: MiddlewareFactory = nextMiddleware => {
  return async (request: NextRequestWithAuth, nextFetchEvent: NextFetchEvent) => {
    if (
      request.nextUrl.pathname.startsWith('/admin/api/') &&
      !ADMIN_API_ROUTE_WITH_OWN_ADMIN_CHECK.test(request.nextUrl.pathname)
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
