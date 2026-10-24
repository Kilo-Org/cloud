import { initTRPC, TRPCError } from '@trpc/server';
import { timingSafeEqual } from '@kilocode/encryption';
import type { TRPCContext } from '../types.js';
import { projectTrpcErrorData } from '../trpc-error.js';
import { validateScopedWorkerPreparation } from '../cloud-agent-authority.js';

export const t = initTRPC.context<TRPCContext>().create({
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: projectTrpcErrorData(shape.data, shape.message, error.cause),
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure.use(opts => {
  if (opts.ctx.cloudAgentAuthority) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Cloud Agent authority only permits preparation',
    });
  }
  return opts.next();
});

// Auth middleware - validates customer token
export const protectedProcedure = t.procedure.use(opts => {
  if (opts.ctx.cloudAgentAuthority) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Cloud Agent authority only permits preparation',
    });
  }
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
export const internalApiProtectedProcedure = t.procedure.use(
  async ({ ctx, next, path, getRawInput }) => {
    const internalApiKey = ctx.request.headers.get('x-internal-api-key');
    if (!ctx.env.INTERNAL_API_SECRET) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal API secret not configured',
      });
    }
    if (!internalApiKey || !timingSafeEqual(internalApiKey, ctx.env.INTERNAL_API_SECRET)) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing internal API key',
      });
    }

    if (!ctx.userId || !ctx.authToken) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Invalid customer token',
      });
    }

    if (ctx.cloudAgentAuthority) {
      try {
        if (path !== 'prepareSession' || ctx.cloudAgentAuthority.ownerId !== ctx.userId)
          throw new Error();
        validateScopedWorkerPreparation(ctx.cloudAgentAuthority, await getRawInput());
      } catch {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Cloud Agent preparation exceeds its authority',
        });
      }
    }

    return next({ ctx });
  }
);
