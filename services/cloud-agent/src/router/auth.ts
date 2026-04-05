import { initTRPC, TRPCError } from '@trpc/server';
import type { TRPCContext } from '../types.js';

// Initialize tRPC with context
export const t = initTRPC.context<TRPCContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

// Auth middleware - validates customer token
export const protectedProcedure = t.procedure.use(opts => {
  if (!opts.ctx.userId || !opts.ctx.authToken) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  }

  return opts.next({
    ctx: opts.ctx,
  });
});

// Internal API secret + customer token middleware (for prepareSession/updateSession)
export const internalApiProtectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  // 1. Validate internal API secret
  const internalApiKey = ctx.request.headers.get('x-internal-api-key');
  if (!ctx.env.INTERNAL_API_SECRET) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal API secret not configured',
    });
  }
  if (!internalApiKey || internalApiKey !== ctx.env.INTERNAL_API_SECRET) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Invalid or missing internal API key',
    });
  }

  // 2. Also validate customer token
  if (!ctx.userId || !ctx.authToken) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Invalid customer token',
    });
  }

  return next({ ctx });
});
