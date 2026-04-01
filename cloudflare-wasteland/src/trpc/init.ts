import * as Sentry from '@sentry/cloudflare';
import { initTRPC, TRPCError } from '@trpc/server';
import { writeEvent } from '../util/analytics.util';
import { checkRateLimit } from '../util/rate-limit.util';

import type { JwtOrgMembership } from '../middleware/auth.middleware';

export type TRPCContext = {
  env: Env;
  userId: string;
  isAdmin: boolean;
  apiTokenPepper: string | null;
  orgMemberships: JwtOrgMembership[];
};

const t = initTRPC.context<TRPCContext>().create();

export const router = t.router;

// tRPC procedure paths that correspond to key operations for Sentry breadcrumbs
const BREADCRUMB_OPERATIONS = new Set([
  'wasteland.createWasteland',
  'wasteland.claimWantedItem',
  'wasteland.markWantedItemDone',
  'wasteland.postWantedItem',
  'wasteland.deleteWasteland',
  'wasteland.storeCredential',
]);

/**
 * Extract a wastelandId from the tRPC raw input if present.
 * Input is unvalidated at this point so we defensively check the shape.
 */
function extractWastelandId(rawInput: unknown): string | undefined {
  if (rawInput && typeof rawInput === 'object' && 'wastelandId' in rawInput) {
    const val = (rawInput as Record<string, unknown>).wastelandId;
    return typeof val === 'string' ? val : undefined;
  }
  return undefined;
}

/**
 * Analytics + observability middleware — wraps every tRPC procedure to:
 * 1. Emit analytics events with timing data
 * 2. Add Sentry breadcrumbs for key operations
 * 3. Set Sentry tags for error correlation
 */
const analyticsProcedure = t.procedure.use(async ({ ctx, path, type, rawInput, next }) => {
  const start = performance.now();
  const wastelandId = extractWastelandId(rawInput);

  // Set Sentry tags for error correlation
  Sentry.setTag('operation', path);
  if (ctx.userId) Sentry.setTag('userId', ctx.userId);
  if (wastelandId) Sentry.setTag('wastelandId', wastelandId);

  // Add Sentry breadcrumb for key operations
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
    const result = await next({ ctx });
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
export const adminProcedure = procedure.use(async ({ ctx, next }) => {
  if (!ctx.isAdmin) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });
  }
  return next({ ctx });
});
