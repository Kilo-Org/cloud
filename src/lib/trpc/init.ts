import 'server-only';
import { getUserFromAuth } from '@/lib/user.server';
import { initTRPC, TRPCError } from '@trpc/server';
import type { User } from '@kilocode/db/schema';
import * as z from 'zod';
import { setTag, trpcMiddleware } from '@sentry/nextjs';
// Define the context type
export type TRPCContext = {
  user: User;
};

/**
 * @see: https://trpc.io/docs/server/context
 */
export const createTRPCContext = async (): Promise<TRPCContext> => {
  const { user } = await getUserFromAuth({ adminOnly: false });
  if (!user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'User not authenticated - no user to set on context',
    });
  }
  setTag('userId', user.id);
  return {
    user,
  };
};

// Avoid exporting the entire t-object
// since it's not very descriptive.
// For instance, the use of a t variable
// is common in i18n libraries.
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
      },
    };
  },
});

const sentryMiddleware = t.middleware(
  trpcMiddleware({
    attachRpcInput: true,
  })
);

// Base router and procedure helpers
export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;
export const baseProcedure = t.procedure.use(sentryMiddleware);

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
