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
const ADMIN_API_ROOT = path.join(APP_ROOT, 'admin/api');

function adminApiRouteFiles(): string[] {
  return fs
    .readdirSync(ADMIN_API_ROOT, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name === 'route.ts')
    .map(entry => path.join(entry.parentPath, entry.name))
    .sort();
}

function routePathOf(routeFile: string): string {
  return `/${path.relative(APP_ROOT, path.dirname(routeFile)).split(path.sep).join('/')}`;
}

function routeFileOf(route: string): string {
  return path.join(APP_ROOT, `${route.replace(/^\//, '')}/route.ts`);
}

const HANDLER_DECLARATION =
  /^export\s+(?:async\s+)?(?:function\s+|const\s+)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/;

type Handler = { method: string; body: string };

/**
 * Splits a route file into its exported HTTP handlers. A handler body ends at
 * the next top-level `export`, so one guarded handler cannot stand in for an
 * unguarded sibling in the same file.
 */
function exportedHandlers(source: string): Handler[] {
  const lines = source.split('\n');
  const declarations: { line: number; method: string }[] = [];
  lines.forEach((line, index) => {
    const declaration = HANDLER_DECLARATION.exec(line);
    if (declaration) declarations.push({ line: index, method: declaration[1] });
  });
  return declarations.map((declaration, position) => ({
    method: declaration.method,
    body: lines
      .slice(declaration.line, declarations[position + 1]?.line ?? lines.length)
      .join('\n'),
  }));
}

type MountedProcedure = { _def?: { middlewares?: readonly unknown[] } };

const MOUNTED_PROCEDURES = rootRouter._def.procedures as Record<string, MountedProcedure>;

/**
 * A handler proves admin access either by calling
 * `getUserFromAuth({ adminOnly: true })` itself or by reaching a mounted tRPC
 * procedure that carries a privileged guard. Every privileged guard tier chains
 * on `adminProcedure`, so any tier proves the admin check.
 */
function hasAdminCheck(handler: Handler): boolean {
  if (/getUserFromAuth\(\s*\{\s*adminOnly:\s*true/.test(handler.body)) return true;
  const calls = handler.body.matchAll(/\bcaller\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\(/g);
  return [...calls].some(
    call => privilegedGuardTiers(MOUNTED_PROCEDURES[call[1]]?._def?.middlewares ?? []).length > 0
  );
}

function unguardedHandlerNames(routeFile: string): string[] {
  const route = routePathOf(routeFile);
  return exportedHandlers(fs.readFileSync(routeFile, 'utf8'))
    .filter(handler => !hasAdminCheck(handler))
    .map(handler => `${handler.method} ${route}`);
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

  // Every admin API handler confirms admin access itself, so the middleware's
  // token claim is only a first layer. A handler that drops its check fails
  // here, whether it sits on the exempt list or behind the middleware check.
  // A listed path with no route file is a stale exemption and fails here too.
  it('checks admin access in every handler of every admin API route', () => {
    expect(adminApiRouteFiles().flatMap(unguardedHandlerNames)).toEqual([]);
    expect(
      ADMIN_API_ROUTES_WITH_OWN_ADMIN_CHECK.filter(route => !fs.existsSync(routeFileOf(route)))
    ).toEqual([]);
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
