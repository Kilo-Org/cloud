import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { privilegedGuardTiers } from '@kilocode/web-shared/lib/admin/privileged-inventory';
import { rootRouter } from '@/routers/root-router';
import type { NextFetchEvent } from 'next/server';
import type { JWT } from 'next-auth/jwt';
import type {
  NextAuthMiddlewareOptions,
  NextMiddlewareWithAuth,
  NextRequestWithAuth,
} from 'next-auth/middleware';
import {
  ADMIN_API_ROUTES_WITH_OWN_ADMIN_CHECK,
  toRoutePattern,
  withAuthenticatedAdminApiRoutes,
} from './withAuthenticatedAdminApiRoutes';

jest.mock('next-auth/middleware', () => ({ withAuth: mockWithAuth }));

// The mounted router carries every module its routers import, and those modules
// construct clients at load time that this suite never exercises.
jest.mock('@kilocode/web-shared/lib/redis', () => ({ redisClient: {} }));
jest.mock('@kilocode/web-shared/lib/posthog', () => ({
  __esModule: true,
  default: () => ({
    capture: () => {},
    isFeatureEnabled: async () => false,
    getFeatureFlag: async () => undefined,
    debug: () => {},
    alias: () => {},
  }),
  flushPostHog: async () => undefined,
}));

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

// `next/server` exports `NextFetchEvent` as a type only, and the middleware
// under test just forwards the event to the next middleware, so a stub keeps
// the test off Next internals that an upgrade may move. A real event cannot be
// built from its public type, because its state lives behind private symbols.
function nextFetchEvent(): NextFetchEvent {
  return {} as NextFetchEvent;
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

const USER_ID = '6f1c2d3e-0000-4000-8000-000000000001';

// Driven from the list itself, so a path added there is also driven here. The
// trailing-slash entry is the request path Next.js serves the same handler on.
const OWN_ADMIN_CHECK_PATHS = [
  ...ADMIN_API_ROUTES_WITH_OWN_ADMIN_CHECK.map(route => route.replace('[id]', USER_ID)),
  '/admin/api/users/',
];

const MIDDLEWARE_CHECKED_PATHS = [
  '/admin/api/users/audit-log',
  `/admin/api/users/${USER_ID}`,
  `/admin/api/users/${USER_ID}/dev`,
  `/admin/api/users/${USER_ID}/kill-balance-cache/now`,
  '/admin/api/users-export',
  '/admin/api/enrichment-data/upsert-v2',
  '/admin/api/abuse/blacklisted-domains',
];

const APP_ROOT = path.resolve(__dirname, '../app');
const USER_ROUTE_ROOT = path.join(APP_ROOT, 'admin/api/users');

// The listed user routes each verify admin access with `getUserFromAuth`, so the
// middleware must keep them in the list as route files come and go. The
// enrichment route is left out of this scan, because it verifies through the
// admin tRPC procedure its handler calls; `unguardedListedRoutePaths` below
// covers that shape.
function adminGuardedUserRoutePaths(): string[] {
  return fs
    .readdirSync(USER_ROUTE_ROOT, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name === 'route.ts')
    .map(entry => path.join(entry.parentPath, entry.name))
    .filter(file =>
      /getUserFromAuth\(\s*\{\s*adminOnly:\s*true/.test(fs.readFileSync(file, 'utf8'))
    )
    .map(file => `/${path.relative(APP_ROOT, path.dirname(file)).split(path.sep).join('/')}`)
    .sort();
}

function listedUserRoutePaths(): string[] {
  return ADMIN_API_ROUTES_WITH_OWN_ADMIN_CHECK.filter(
    route => route === '/admin/api/users' || route.startsWith('/admin/api/users/')
  ).sort();
}

type MountedProcedure = { _def?: { middlewares?: readonly unknown[] } };

const MOUNTED_PROCEDURES = rootRouter._def.procedures as Record<string, MountedProcedure>;

/** The mounted procedures a handler calls through the tRPC caller it receives. */
function delegatedProcedurePaths(route: string): string[] {
  const source = fs.readFileSync(path.join(APP_ROOT, route, 'route.ts'), 'utf8');
  const calls = source.matchAll(/\bcaller\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\(/g);
  return [...calls].map(call => call[1]);
}

/**
 * A listed handler proves admin access either by calling
 * `getUserFromAuth({ adminOnly: true })` itself or by reaching a mounted tRPC
 * procedure that carries a privileged guard. Every privileged guard tier chains
 * on `adminProcedure`, so any tier proves the admin check.
 */
function unguardedListedRoutePaths(): string[] {
  return ADMIN_API_ROUTES_WITH_OWN_ADMIN_CHECK.filter(route => {
    const source = fs.readFileSync(path.join(APP_ROOT, route, 'route.ts'), 'utf8');
    if (/getUserFromAuth\(\s*\{\s*adminOnly:\s*true/.test(source)) return false;
    return !delegatedProcedurePaths(route).some(
      procedure =>
        privilegedGuardTiers(MOUNTED_PROCEDURES[procedure]?._def?.middlewares ?? []).length > 0
    );
  });
}

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

  it('lists every user route that verifies admin access itself', () => {
    expect(adminGuardedUserRoutePaths()).toEqual(listedUserRoutePaths());
  });

  // A listed handler is exempt from the middleware admin check only because it
  // verifies admin access itself. Directly guarded handlers are covered by the
  // scan above; this test covers a handler that delegates its check to the
  // tRPC procedure it calls, so downgrading that procedure fails here.
  it('reaches a guarded admin procedure in every listed handler without its own guard', () => {
    expect(unguardedListedRoutePaths()).toEqual([]);
  });

  it('treats only a one-segment dynamic name as a wildcard', () => {
    const dynamic = new RegExp(`^${toRoutePattern('/admin/api/users/[id]/referrals')}$`);
    expect(dynamic.test(`/admin/api/users/${USER_ID}/referrals`)).toBe(true);
    expect(dynamic.test(`/admin/api/users/${USER_ID}/nested/referrals`)).toBe(false);

    const catchAll = new RegExp(`^${toRoutePattern('/admin/api/users/[...slug]')}$`);
    expect(catchAll.test('/admin/api/users/audit-log')).toBe(false);
    expect(catchAll.test('/admin/api/users/audit-log/nested')).toBe(false);
  });
});
