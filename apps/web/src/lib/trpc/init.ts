import 'server-only';
import { randomUUID } from 'node:crypto';
import { getUserFromAuth } from '@/lib/user/server';
import { initTRPC, TRPCError } from '@trpc/server';
import type { User } from '@kilocode/db/schema';
import * as z from 'zod';
import { setTag, trpcMiddleware } from '@sentry/nextjs';
import { userCanManageCredits } from '@/lib/admin/credit-management';
const MAX_REQUEST_CORRELATION_ID_LENGTH = 200;
const REQUEST_CORRELATION_ID_PATTERN = /^(?:[a-z]{3}\d::){1,2}[a-z0-9]{5}-\d{13}-[a-f0-9]{12}$/;

// Define the context type
export type TRPCContext = {
  user: User;
  requestCorrelationId?: string;
};

type CorrelatedTRPCContext = TRPCContext & {
  requestCorrelationId: string;
};

type CreateTRPCContextInput = {
  requestCorrelationId?: string | null;
};

/**
 * @see: https://trpc.io/docs/server/context
 */
export const createTRPCContext = async (
  input: CreateTRPCContextInput = {}
): Promise<CorrelatedTRPCContext> => {
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
    requestCorrelationId: normalizeRequestCorrelationId(input.requestCorrelationId),
  };
};

function normalizeRequestCorrelationId(requestCorrelationId: string | null | undefined): string {
  const normalized = requestCorrelationId?.trim();
  if (
    !normalized ||
    normalized.length > MAX_REQUEST_CORRELATION_ID_LENGTH ||
    !REQUEST_CORRELATION_ID_PATTERN.test(normalized)
  ) {
    return randomUUID();
  }
  return normalized;
}

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

const requestCorrelationMiddleware = t.middleware(({ ctx, next }) =>
  next({
    ctx: {
      ...ctx,
      requestCorrelationId: ctx.requestCorrelationId ?? randomUUID(),
    },
  })
);

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
export const baseProcedure = t.procedure
  .use(requestCorrelationMiddleware)
  .use(timingMiddleware)
  .use(sentryMiddleware);

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

export const creditManagerProcedure = adminProcedure.use(async ({ ctx, next }) => {
  if (!userCanManageCredits(ctx.user)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Credit management access required',
    });
  }

  return next();
});
