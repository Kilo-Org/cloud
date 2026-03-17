import { initTRPC, TRPCError } from '@trpc/server';
import { writeEvent } from '../util/analytics.util';

import type { JwtOrgMembership } from '../middleware/auth.middleware';

export type TRPCContext = {
  env: Env;
  userId: string;
  isAdmin: boolean;
  apiTokenPepper: string | null;
  gastownAccess: boolean;
  orgMemberships: JwtOrgMembership[];
};

const t = initTRPC.context<TRPCContext>().create();

export const router = t.router;

/**
 * Analytics middleware — wraps every tRPC procedure to emit an analytics
 * event with timing and error capture. Runs before auth so even rejected
 * requests are tracked.
 */
const analyticsProcedure = t.procedure.use(async ({ ctx, path, type, next }) => {
  const start = performance.now();
  let error: string | undefined;
  try {
    const result = await next({ ctx });
    return result;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    // Sentry capture happens in trpcServer({ onError }) — don't double-report
    throw err;
  } finally {
    const durationMs = performance.now() - start;
    writeEvent(ctx.env, {
      event: path,
      delivery: 'trpc',
      route: `${type} ${path}`,
      error,
      userId: ctx.userId || undefined,
      durationMs,
    });
  }
});

/**
 * Base procedure — requires a valid Kilo JWT (enforced by kiloAuthMiddleware
 * running before tRPC). The userId is extracted from the JWT and set on the
 * Hono context by kiloAuthMiddleware, then forwarded into the tRPC context
 * by the createContext callback in gastown.worker.ts.
 */
export const procedure = analyticsProcedure.use(async ({ ctx, next }) => {
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

/**
 * Admin-only procedure — requires `isAdmin` on the JWT. Used for admin
 * panel endpoints that bypass per-user ownership checks (e.g. town-wide
 * bead/agent listing for support diagnostics).
 */
export const adminProcedure = procedure.use(async ({ ctx, next }) => {
  if (!ctx.isAdmin) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });
  }
  return next({ ctx });
});
