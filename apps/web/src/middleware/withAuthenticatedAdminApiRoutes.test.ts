// `next/server` exports `NextFetchEvent` as a type only in this Next version,
// so the test builds the event with the class Next itself constructs.
import { NextFetchEvent } from 'next/dist/server/web/spec-extension/fetch-event';
import { NextRequest } from 'next/server';
import type { JWT } from 'next-auth/jwt';
import type {
  NextAuthMiddlewareOptions,
  NextMiddlewareWithAuth,
  NextRequestWithAuth,
} from 'next-auth/middleware';
import { withAuthenticatedAdminApiRoutes } from './withAuthenticatedAdminApiRoutes';

jest.mock('next-auth/middleware', () => ({ withAuth: mockWithAuth }));

/**
 * Stands in for `next-auth/middleware`'s `withAuth`: it runs the configured
 * `authorized` callback against the token the request carries and answers a
 * denied request the way the real middleware does, with a redirect to the
 * sign-in page that keeps the callback URL.
 */
function mockWithAuth(
  nextMiddleware: NextMiddlewareWithAuth,
  options?: NextAuthMiddlewareOptions
): NextMiddlewareWithAuth {
  return async (request, event) => {
    const authorized = await options?.callbacks?.authorized?.({
      token: request.nextauth.token,
      req: request,
    });
    if (authorized) {
      return nextMiddleware(request, event);
    }

    const signInUrl = new URL('/api/auth/signin', request.nextUrl.origin);
    signInUrl.searchParams.append('callbackUrl', request.nextUrl.pathname);
    return Response.redirect(signInUrl, 307);
  };
}

type Session = 'anonymous' | 'non-admin' | 'admin';

const TOKENS: Record<Session, JWT | null> = {
  anonymous: null,
  'non-admin': { isAdmin: false },
  admin: { isAdmin: true },
};

const NEXT_MIDDLEWARE_BODY = 'next-middleware';

function requestWithSession(pathname: string, session: Session): NextRequestWithAuth {
  const request = new NextRequest(`http://localhost${pathname}`);
  // `withAuth` adds this property at runtime; the test supplies the same shape.
  return Object.assign(request, { nextauth: { token: TOKENS[session] } });
}

function nextFetchEvent(): NextFetchEvent {
  return new NextFetchEvent({
    request: new NextRequest('http://localhost/'),
    page: '/',
    context: undefined,
  });
}

async function callMiddleware(pathname: string, session: Session) {
  const nextMiddleware: NextMiddlewareWithAuth = jest.fn(
    async () => new Response(NEXT_MIDDLEWARE_BODY, { status: 200 })
  );
  const middleware = withAuthenticatedAdminApiRoutes(nextMiddleware);
  const result = await middleware(requestWithSession(pathname, session), nextFetchEvent());
  if (!(result instanceof Response)) {
    throw new Error(`Middleware answered without a response for ${pathname}`);
  }
  return { result, nextMiddleware };
}

const OWN_ADMIN_CHECK_PATHS = [
  '/admin/api/enrichment-data/upsert',
  '/admin/api/users',
  '/admin/api/users/',
  '/admin/api/users/add-credit',
  '/admin/api/users/credit-transactions',
  '/admin/api/users/gdpr-removal',
  '/admin/api/users/heuristic-analysis/grouped',
  '/admin/api/users/heuristic-analysis/raw',
  '/admin/api/users/payment-methods',
  '/admin/api/users/6f1c2d3e-0000-4000-8000-000000000001/dev/insert-usage-record',
  '/admin/api/users/6f1c2d3e-0000-4000-8000-000000000001/kill-balance-cache',
  '/admin/api/users/6f1c2d3e-0000-4000-8000-000000000001/referrals',
];

const MIDDLEWARE_CHECKED_PATHS = [
  '/admin/api/users/audit-log',
  '/admin/api/users/6f1c2d3e-0000-4000-8000-000000000001',
  '/admin/api/users/6f1c2d3e-0000-4000-8000-000000000001/dev',
  '/admin/api/users/6f1c2d3e-0000-4000-8000-000000000001/kill-balance-cache/now',
  '/admin/api/users-export',
  '/admin/api/enrichment-data/upsert-v2',
  '/admin/api/abuse/blacklisted-domains',
];

describe('withAuthenticatedAdminApiRoutes', () => {
  it.each(OWN_ADMIN_CHECK_PATHS)(
    'passes %s to the next middleware for anonymous, non-admin and admin sessions',
    async pathname => {
      for (const session of ['anonymous', 'non-admin', 'admin'] as const) {
        const { result, nextMiddleware } = await callMiddleware(pathname, session);

        expect(result.status).toBe(200);
        expect(await result.text()).toBe(NEXT_MIDDLEWARE_BODY);
        expect(nextMiddleware).toHaveBeenCalledTimes(1);
      }
    }
  );

  it.each(MIDDLEWARE_CHECKED_PATHS)('applies the admin check to %s', async pathname => {
    const anonymous = await callMiddleware(pathname, 'anonymous');
    expect(anonymous.result.status).toBe(307);
    expect(anonymous.result.headers.get('location')).toContain('/api/auth/signin');
    expect(anonymous.nextMiddleware).not.toHaveBeenCalled();

    const nonAdmin = await callMiddleware(pathname, 'non-admin');
    expect(nonAdmin.result.status).toBe(307);
    expect(nonAdmin.result.headers.get('location')).toContain('/api/auth/signin');
    expect(nonAdmin.nextMiddleware).not.toHaveBeenCalled();

    const admin = await callMiddleware(pathname, 'admin');
    expect(admin.result.status).toBe(200);
    expect(await admin.result.text()).toBe(NEXT_MIDDLEWARE_BODY);
    expect(admin.nextMiddleware).toHaveBeenCalledTimes(1);
  });

  it('leaves paths outside the admin API alone', async () => {
    const { result, nextMiddleware } = await callMiddleware('/admin/users', 'anonymous');

    expect(result.status).toBe(200);
    expect(nextMiddleware).toHaveBeenCalledTimes(1);
  });
});
