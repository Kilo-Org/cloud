import 'server-only';
import { headers } from 'next/headers';
import { getUserFromAuth } from '@/lib/user/server';
import { initTRPC, TRPCError } from '@trpc/server';
import type { User } from '@kilocode/db/schema';
import {
  authViaTokenFromHeaders,
  clientIpFromHeaders,
  emitAdminAccessEvent,
} from '@/lib/admin/admin-access-log';
import { setTag, trpcMiddleware } from '@sentry/nextjs';
import { userCanViewSessions, userIsSuperadmin } from '@/lib/admin/admin-permissions';
import { userCanManageCredits } from '@/lib/admin/credit-management';
import { AuthContextError, trpcErrorFormatter } from '@/lib/trpc/transport';
import {
  appUpdateRequiredError,
  enforceMinimumVersion,
  getMinimumVersions,
  isMobileClient,
} from '@/lib/trpc/min-version';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

export { UpstreamApiError } from '@/lib/trpc/transport';
// Define the context type
export type TRPCContext = {
  user: User;
  deviceSessionId?: string;
  // Admin audit signals threaded from the auth layer so `adminProcedure` can
  // emit IP-independent, identity-attributed access telemetry. Optional so the
  // many existing `{ user }` context constructors (tests, scripts) keep working;
  // production `createTRPCContext` always populates them.
  authViaToken?: boolean;
  tokenSource?: string | null;
  ip?: string | null;
  // Procedure path and type, injected into the context by `baseProcedure` so
  // that `is_admin` elevation sites *inside* a resolver (which only receive
  // `ctx`, not the middleware's `path`/`type`) can attribute their audit event
  // to the exact procedure. Optional for the same reason as the fields above.
  trpcPath?: string;
  trpcType?: string;
  // Populated by `createTRPCContext` and read by the min-version middleware.
  headersList?: Headers;
};

/**
 * @see: https://trpc.io/docs/server/context
 */
export const createTRPCContext = async (): Promise<TRPCContext> => {
  const headersList = await headers();
  const { user, deviceSessionId, tokenSource } = await getUserFromAuth({ adminOnly: false });
  if (!user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'User not authenticated - no user to set on context',
      // Marks this as a genuine session failure (vs a procedure-level
      // UNAUTHORIZED like org-access denial) so the mobile client signs out
      // only here — see AuthContextError / data.authRequired.
      cause: new AuthContextError(),
    });
  }
  setTag('userId', user.id);
  return {
    user,
    deviceSessionId,
    authViaToken: authViaTokenFromHeaders(headersList),
    tokenSource: tokenSource ?? null,
    ip: clientIpFromHeaders(headersList),
    headersList,
  };
};

// Avoid exporting the entire t-object
// since it's not very descriptive.
// For instance, the use of a t variable
// is common in i18n libraries.
/**
 * Marker class used to attach an upstream API error code to a TRPCError so the
 * error-formatter can surface it to the client in `err.data.upstreamCode`.
 *
 * Usage:
 *   throw new TRPCError({
 *     code: 'CONFLICT',
 *     message: 'Config was modified',
 *     cause: new UpstreamApiError('etag_mismatch'),
 *   });
 *
 * The client then sees `err.data.upstreamCode === 'etag_mismatch'`.
 */
const t = initTRPC.context<TRPCContext>().create({
  errorFormatter: trpcErrorFormatter,
});

const sentryMiddleware = t.middleware(
  trpcMiddleware({
    attachRpcInput: false,
  })
);

const timingMiddleware = t.middleware(async ({ path, type, ctx, next }) => {
  if (process.env.TRPC_TIMING_LOGGING !== '1') return next();

  const start = performance.now();
  const result = await next();
  const durationMs = performance.now() - start;
  console.log(
    JSON.stringify({
      type: 'trpc_timing',
      path,
      procedureType: type, // 'query' | 'mutation' | 'subscription'
      durationMs: Math.round(durationMs),
      ok: result.ok,
      userId: ctx.user.id,
    })
  );
  return result;
});

// Publishes the procedure path/type onto the context so audit emitters reachable
// only from a resolver (see `recordKiloAdminElevation`) can name the procedure.
// `next({ ctx })` merges into the existing context, so nothing is dropped.
const auditContextMiddleware = t.middleware(({ path, type, next }) =>
  next({ ctx: { trpcPath: path, trpcType: type } })
);

// Refuses a mobile client whose app version is below the configured minimum.
// Web/CLI callers (and any caller without a `headersList`) short-circuit on
// `isMobileClient` and pass without a DB read.
const minimumVersionMiddleware = t.middleware(async ({ ctx, next }) => {
  if (!isMobileClient(ctx.headersList)) return next();
  const minimums = await getMinimumVersions();
  if (!minimums || !enforceMinimumVersion(ctx.headersList, minimums).pass) {
    throw appUpdateRequiredError();
  }
  return next();
});

// Base router and procedure helpers
export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;
export const baseProcedure = t.procedure
  .use(timingMiddleware)
  .use(sentryMiddleware)
  .use(auditContextMiddleware)
  .use(minimumVersionMiddleware);

// Admin-only procedure. creditManager/superadmin/sessionViewer chain on this,
// so emitting here covers the whole admin.* tRPC surface with a single event.
export const adminProcedure = baseProcedure.use(async ({ ctx, path, type, next }) => {
  if (!ctx.user.is_admin) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Admin access required',
    });
  }
  // Emit before next() so the access attempt is recorded even if the handler
  // (or a chained sub-check) later throws.
  emitAdminAccessEvent({
    surface: 'trpc',
    kind: 'admin_guard',
    user: ctx.user,
    authViaToken: ctx.authViaToken ?? false,
    tokenSource: ctx.tokenSource ?? null,
    route: path,
    method: type,
    ip: ctx.ip ?? null,
  });
  return next();
});

export const creditManagerProcedure = adminProcedure.use(async ({ ctx, next }) => {
  const currentUser = await getCurrentUserFromPrimary(ctx.user.id);
  if (!currentUser || currentUser.blocked_reason !== null || !userCanManageCredits(currentUser)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Credit management access required',
    });
  }

  return next();
});

async function getCurrentUserFromPrimary(userId: string) {
  return db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, userId),
  });
}

export const superadminProcedure = adminProcedure.use(async ({ ctx, next }) => {
  const currentUser = await getCurrentUserFromPrimary(ctx.user.id);
  if (!currentUser || currentUser.blocked_reason !== null || !userIsSuperadmin(currentUser)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Superadmin access required',
    });
  }

  return next();
});

export const sessionViewerProcedure = adminProcedure.use(async ({ ctx, next }) => {
  const currentUser = await getCurrentUserFromPrimary(ctx.user.id);

  if (!currentUser || currentUser.blocked_reason !== null || !userCanViewSessions(currentUser)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Session viewing access required',
    });
  }

  return next();
});
