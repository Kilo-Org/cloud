import { initTRPC, TRPCError } from '@trpc/server';

export type TRPCContext = {
  env: Env;
  userId: string;
  isAdmin: boolean;
  apiTokenPepper: string | null;
  gastownAccess: boolean;
};

const t = initTRPC.context<TRPCContext>().create();

export const router = t.router;

/**
 * Base procedure — requires a valid Kilo JWT (enforced by kiloAuthMiddleware
 * running before tRPC). The userId is extracted from the JWT and set on the
 * Hono context by kiloAuthMiddleware, then forwarded into the tRPC context
 * by the createContext callback in gastown.worker.ts.
 */
export const procedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
  }
  return next({ ctx });
});

/**
 * Gastown access procedure — requires a valid JWT with `gastownAccess`
 * (set by the token endpoint after PostHog flag evaluation). Falls back
 * to `isAdmin` for backward compatibility with pre-migration tokens.
 */
export const gastownProcedure = procedure.use(async ({ ctx, next }) => {
  if (!ctx.gastownAccess && !ctx.isAdmin) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Gastown access required' });
  }
  return next({ ctx });
});
