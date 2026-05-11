import { initTRPC, TRPCError } from '@trpc/server';
import type { TRPCContext } from '../types.js';

/**
 * Type for error cause data that should be surfaced in the response.
 * Used for 409 Conflict (activeExecutionId) and 503 Retryable errors.
 */
type ErrorCauseData = {
  error?: string;
  message?: string;
  activeExecutionId?: string;
  retryable?: boolean;
};

// Initialize tRPC with context and error formatter
export const t = initTRPC.context<TRPCContext>().create({
  errorFormatter({ shape, error }) {
    // Surface cause data in the response for specific error types
    const causeData = error.cause as ErrorCauseData | undefined;
    if (causeData && typeof causeData === 'object') {
      return {
        ...shape,
        data: {
          ...shape.data,
          // Include structured error info from cause
          ...(causeData.error && { error: causeData.error }),
          ...(causeData.activeExecutionId && { activeExecutionId: causeData.activeExecutionId }),
          ...(causeData.retryable !== undefined && { retryable: causeData.retryable }),
        },
      };
    }
    return shape;
  },
});

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
