import { initTRPC, TRPCError } from '@trpc/server';
import type {
  WorkerAdminAuthority,
  WorkerAdminTarget,
} from '@kilocode/worker-utils/worker-admin-capability';
import { writeEvent } from '../util/analytics.util';
import { emitWorkerAdminDecision } from '../middleware/worker-admin.middleware';

import type { JwtOrgMembership } from '../middleware/auth.middleware';

export type TRPCContext = {
  env: Env;
  executionCtx: ExecutionContext;
  userId: string;
  workerAdmin: WorkerAdminAuthority;
  procedurePath: string;
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
    const result = await next({ ctx: { ...ctx, procedurePath: path } });
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
  if (!ctx.gastownAccess && !ctx.workerAdmin.legacyClaim) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Gastown access required' });
  }
  return next({ ctx });
});

/**
 * Feature-flag procedure — requires the `gastownAccess` claim even for
 * admins. Use for actions that must stay limited to users enabled by the
 * `gastown-access` PostHog flag.
 */
export const gastownFlaggedProcedure = procedure.use(async ({ ctx, next }) => {
  if (!ctx.gastownAccess) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Gastown access required' });
  }
  return next({ ctx });
});

/**
 * Admin-only procedure — requires `isAdmin` on the JWT. Used for admin
 * panel endpoints that bypass per-user ownership checks (e.g. town-wide
 * bead/agent listing for support diagnostics).
 */
function adminTargetForInput(input: unknown): WorkerAdminTarget {
  if (typeof input === 'object' && input !== null) {
    if ('townId' in input && typeof input.townId === 'string') {
      return { kind: 'town', id: input.townId };
    }
    if ('wastelandId' in input && typeof input.wastelandId === 'string') {
      return { kind: 'wasteland', id: input.wastelandId };
    }
  }
  return { kind: 'service', id: 'gastown' };
}

export const adminProcedure = procedure.use(async ({ ctx, path, getRawInput, next }) => {
  const action = `trpc:${path}`;
  const target = adminTargetForInput(await getRawInput());
  const decision = await ctx.workerAdmin.decide(action, target);
  emitWorkerAdminDecision(ctx.env, decision, {
    action,
    userId: ctx.userId || null,
    townId: target.kind === 'town' ? target.id : null,
    jti: decision.allowed ? decision.jti : null,
    delivery: 'trpc',
  });
  if (!decision.allowed) {
    throw new TRPCError({
      code:
        decision.status === 401
          ? 'UNAUTHORIZED'
          : decision.status === 503
            ? 'SERVICE_UNAVAILABLE'
            : 'FORBIDDEN',
      message:
        decision.status === 503
          ? 'Admin capability validation unavailable'
          : 'Admin access required',
    });
  }
  return next({ ctx });
});
