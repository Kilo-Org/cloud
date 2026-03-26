import 'server-only';
import { getUserFromAuth } from '@/lib/user.server';
import { initTRPC, TRPCError } from '@trpc/server';
import type { User } from '@kilocode/db/schema';
import * as z from 'zod';
import { setTag, trpcMiddleware } from '@sentry/nextjs';
// Define the context type
export type TRPCContext = {
  user: User | null;
};

/**
 * Narrowed context type for use in handlers attached to `baseProcedure` or
 * `adminProcedure` — the auth middleware guarantees `user` is non-null.
 */
export type AuthenticatedTRPCContext = TRPCContext & { user: User };

/**
 * @see: https://trpc.io/docs/server/context
 */
export const createTRPCContext = async (): Promise<TRPCContext> => {
  const { user } = await getUserFromAuth({ adminOnly: false });
  if (user) {
    setTag('userId', user.id);
  }
  return { user: user ?? null };
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
export class UpstreamApiError extends Error {
  constructor(public readonly upstreamCode: string) {
    super(upstreamCode);
    this.name = 'UpstreamApiError';
  }
}

const t = initTRPC.context<TRPCContext>().create({
  errorFormatter(opts) {
    const { shape, error } = opts;
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.code === 'BAD_REQUEST' && error.cause instanceof z.ZodError
            ? z.flattenError(error.cause)
            : null,
        upstreamCode:
          error.cause instanceof UpstreamApiError ? error.cause.upstreamCode : undefined,
      },
    };
  },
});

const sentryMiddleware = t.middleware(
  trpcMiddleware({
    attachRpcInput: true,
  })
);

const authMiddleware = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'User not authenticated',
    });
  }
  return next({ ctx: { user: ctx.user } });
});

// Base router and procedure helpers
export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure.use(sentryMiddleware);
export const baseProcedure = t.procedure.use(sentryMiddleware).use(authMiddleware);

// Admin-only procedure
export const adminProcedure = baseProcedure.use(async ({ ctx, next }) => {
  if (!ctx.user.is_admin) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Admin access required',
    });
  }
  return next();
});
