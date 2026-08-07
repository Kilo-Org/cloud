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
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

export { UpstreamApiError } from '@/lib/trpc/transport';
// Define the context type
export type TRPCContext = {
  user: User;
  // Admin audit signals threaded from the auth layer so `adminProcedure` can
  // emit IP-independent, identity-attributed access telemetry. Optional so the
  // many existing `{ user }` context constructors (tests, scripts) keep working;
  // production `createTRPCContext` always populates them.
  authViaToken?: boolean;
  tokenSource?: string | null;
  ip?: string | null;
};

/**
 * @see: https://trpc.io/docs/server/context
 */
export const createTRPCContext = async (): Promise<TRPCContext> => {
  const headersList = await headers();
  const { user, tokenSource } = await getUserFromAuth({ adminOnly: false });
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
    authViaToken: authViaTokenFromHeaders(headersList),
    tokenSource: tokenSource ?? null,
    ip: clientIpFromHeaders(headersList),
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

// Base router and procedure helpers
export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;
export const baseProcedure = t.procedure.use(timingMiddleware).use(sentryMiddleware);

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
