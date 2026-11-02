import * as Sentry from '@sentry/cloudflare';
import { initTRPC, TRPCError } from '@trpc/server';
import type {
  WorkerAdminAuthority,
  WorkerAdminTarget,
} from '@kilocode/worker-utils/worker-admin-capability';
import { z } from 'zod';
import { writeEvent } from '../util/analytics.util';
import { emitWorkerAdminDecision } from '../middleware/worker-admin.middleware';
import { checkRateLimit } from '../util/rate-limit.util';

import type { JwtOrgMembership } from '../middleware/auth.middleware';

export type TRPCContext = {
  env: Env;
  userId: string;
  workerAdmin: WorkerAdminAuthority;
  procedurePath: string;
  apiTokenPepper: string | null;
  legacyClaimLifetimeSeconds: number | null;
  orgMemberships: JwtOrgMembership[];
};

const t = initTRPC.context<TRPCContext>().create();

export const router = t.router;

const BREADCRUMB_OPERATIONS = new Set([
  'wasteland.createWasteland',
  'wasteland.claimWantedItem',
  'wasteland.markWantedItemDone',
  'wasteland.postWantedItem',
  'wasteland.deleteWasteland',
  'wasteland.storeCredential',
  'wasteland.connectKiloTown',
  'wasteland.disconnectKiloTown',
]);

const RawInputWithWastelandId = z.object({ wastelandId: z.string() }).passthrough();

/**
 * Extract a wastelandId from the tRPC raw input if present.
 * Input is unvalidated at this point so we defensively check the shape.
 */
function extractWastelandId(rawInput: unknown): string | undefined {
  const parsed = RawInputWithWastelandId.safeParse(rawInput);
  return parsed.success ? parsed.data.wastelandId : undefined;
}

const analyticsProcedure = t.procedure.use(async ({ ctx, path, type, getRawInput, next }) => {
  const start = performance.now();
  const rawInput = await getRawInput();
  const wastelandId = extractWastelandId(rawInput);

  Sentry.setTag('operation', path);
  if (ctx.userId) Sentry.setTag('userId', ctx.userId);
  if (wastelandId) Sentry.setTag('wastelandId', wastelandId);

  if (BREADCRUMB_OPERATIONS.has(path)) {
    Sentry.addBreadcrumb({
      category: 'trpc',
      message: `${type} ${path}`,
      level: 'info',
      data: {
        ...(wastelandId ? { wastelandId } : {}),
        userId: ctx.userId || undefined,
      },
    });
  }

  let error: string | undefined;
  try {
    const result = await next({ ctx: { ...ctx, procedurePath: path } });
    return result;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    const durationMs = performance.now() - start;
    writeEvent(ctx.env, {
      event: path,
      delivery: 'trpc',
      route: `${type} ${path}`,
      error,
      userId: ctx.userId || undefined,
      wastelandId,
      durationMs,
    });
  }
});

/**
 * Base procedure — requires a valid Kilo JWT (enforced by kiloAuthMiddleware
 * running before tRPC). The userId is extracted from the JWT and set on the
 * Hono context by kiloAuthMiddleware, then forwarded into the tRPC context
 * by the createContext callback in wasteland.worker.ts.
 *
 * Also enforces per-user rate limits for operations that have them configured.
 */
export const procedure = analyticsProcedure.use(async ({ ctx, path, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
  }
  checkRateLimit(ctx.userId, path);
  return next({ ctx });
});

/**
 * Admin-only procedure — requires `isAdmin` on the JWT. Used for admin
 * endpoints that bypass per-user ownership checks.
 */
function adminTargetForInput(input: unknown): WorkerAdminTarget {
  if (typeof input === 'object' && input !== null) {
    if ('wastelandId' in input && typeof input.wastelandId === 'string') {
      return { kind: 'wasteland', id: input.wastelandId };
    }
  }
  return { kind: 'service', id: 'wasteland' };
}

export const adminProcedure = procedure.use(async ({ ctx, path, getRawInput, next }) => {
  const action = `trpc:${path}`;
  const target = adminTargetForInput(await getRawInput());
  const decision = await ctx.workerAdmin.decide(action, target);
  if (ctx.workerAdmin.takeDecisionReport(action, target)) {
    emitWorkerAdminDecision(ctx.env, decision, {
      action,
      userId: ctx.userId || null,
      wastelandId: target.kind === 'wasteland' ? target.id : null,
      jti: decision.allowed ? decision.jti : null,
      lifetimeSeconds: ctx.legacyClaimLifetimeSeconds,
      delivery: 'trpc',
    });
  }
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
