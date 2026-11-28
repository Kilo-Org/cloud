import {
  canManageOrganization,
  canManageOrganizationBilling,
} from '@kilocode/app-shared/organizations';
import {
  AutoRouterSchema,
  CustomRouterBlockedModelsResponseSchema,
  CustomRouterSlugSchema,
  CustomRoutingTableResponseSchema,
  MAX_CUSTOM_ROUTER_ENTRIES,
  MAX_CUSTOM_ROUTER_MODEL_ID_LENGTH,
  PaidBenchmarkIdSchema,
  PaidBenchmarkProgressSchema,
  PaidBenchmarkQuoteSchema,
  PaidBenchmarkStartResultSchema,
  type PaidBenchmarkWorkerRequest,
} from '@kilocode/auto-routing-contracts';
import {
  getCustomRouterTable,
  getPaidBenchmarkProgress,
  lookupCustomRouterBlockedModels,
  pausePaidBenchmark,
  requestPaidBenchmarkQuote,
  startPaidBenchmark,
  type PaidBenchmarkWorkerError,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import type { CustomRouterOwner } from '@kilocode/web-shared/lib/ai-gateway/custom-routers';
import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { captureException } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import {
  CustomRouterApiError,
  loadCustomRouterBenchmarkSubject,
  withLockedCustomRouterBenchmarkSubject,
  type CustomRouterBenchmarkSubject,
} from '@/lib/auto-routing-custom-routers';

const BenchmarkRouterScopeInput = z.object({
  slug: CustomRouterSlugSchema,
  organizationId: z.uuid().optional(),
});

const StartBenchmarkInput = BenchmarkRouterScopeInput.extend({ quoteId: PaidBenchmarkIdSchema });

const BenchmarkProgressInput = BenchmarkRouterScopeInput.extend({
  requestId: PaidBenchmarkIdSchema.optional(),
  cursor: z.string().optional(),
});

const PauseBenchmarkInput = BenchmarkRouterScopeInput.extend({
  requestId: PaidBenchmarkIdSchema,
});

const BlockedModelsInput = z.object({
  models: z
    .array(z.string().trim().min(1).max(MAX_CUSTOM_ROUTER_MODEL_ID_LENGTH))
    .min(1)
    .max(MAX_CUSTOM_ROUTER_ENTRIES),
  baseRouter: AutoRouterSchema,
  organizationId: z.uuid().optional(),
});

/**
 * Resolves the owner from the authorized scope only: the row must belong to that owner, so a
 * personal caller can never name another user's router and an organization member is gated by the
 * existing organization access policy.
 *
 * `start` needs the same authority the billing ledger accepts to spend for the organization, which
 * is owner/admin; a billing manager can pause (which only stops spend) but cannot start.
 */
async function resolveOwner(
  ctx: Parameters<typeof ensureOrganizationAccess>[0],
  organizationId: string | undefined,
  action: 'read' | 'start' | 'pause'
): Promise<CustomRouterOwner> {
  if (!organizationId) return { type: 'user', id: ctx.user.id };
  const role = await ensureOrganizationAccess(ctx, organizationId);
  if (action === 'start' && !canManageOrganization(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only organization owners and admins can start a paid benchmark',
    });
  }
  if (action === 'pause' && !canManageOrganizationBilling(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only organization owners, admins, and billing managers can pause a benchmark',
    });
  }
  return { type: 'org', id: organizationId };
}

function routerNotFoundError(error: unknown): never {
  if (error instanceof CustomRouterApiError && error.code === 'router_not_found') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Custom router not found' });
  }
  throw error;
}

async function loadSubjectOrThrow(
  owner: CustomRouterOwner,
  slug: string
): Promise<CustomRouterBenchmarkSubject> {
  return loadCustomRouterBenchmarkSubject({ owner, slug }).catch(routerNotFoundError);
}

function workerRef(subject: CustomRouterBenchmarkSubject) {
  return {
    ownerType: subject.router.ownerType,
    ownerId: subject.router.ownerId,
    routerId: subject.router.id,
  };
}

function paidBenchmarkError(result: {
  status: number;
  error: PaidBenchmarkWorkerError;
}): TRPCError {
  const { status, error } = result;
  if (error.code === 'insufficient_balance' || status === 402) {
    return new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This benchmark needs more credit than the pool owner has available.',
    });
  }
  if (
    error.code === 'quote_expired' ||
    error.code === 'quote_mismatch' ||
    error.code === 'stale_pool'
  ) {
    return new TRPCError({ code: 'CONFLICT', message: error.message });
  }
  // Transport failures are the retryable state the UI offers again; nothing was decided.
  if (error.code === 'timeout' || error.code === 'transport' || status === 502 || status === 504) {
    return new TRPCError({
      code: 'TIMEOUT',
      message: 'The benchmark worker did not answer. Try again.',
    });
  }
  // No STS service token yet (`AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH=sts`): nothing was sent,
  // and a later attempt may hold one.
  if (error.code === 'token_unavailable') {
    return new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: error.message });
  }
  if (status === 404) return new TRPCError({ code: 'NOT_FOUND', message: error.message });
  if (status === 429) {
    return new TRPCError({ code: 'TOO_MANY_REQUESTS', message: error.message });
  }
  if (status === 400 || status === 422) {
    return new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
}

async function readSubject(
  ctx: Parameters<typeof ensureOrganizationAccess>[0],
  input: { slug: string; organizationId?: string }
) {
  const owner = await resolveOwner(ctx, input.organizationId, 'read');
  return loadSubjectOrThrow(owner, input.slug);
}

export const customRouterBenchmarksRouter = createTRPCRouter({
  /**
   * Read-only pre-add check for the pool editor: which asked models are permanently unavailable at
   * the target base router. It never admits or spends; a previously saved model stays in the pool.
   */
  blockedModels: baseProcedure
    .input(BlockedModelsInput)
    .output(CustomRouterBlockedModelsResponseSchema)
    .query(async ({ ctx, input }) => {
      await resolveOwner(ctx, input.organizationId, 'read');
      try {
        return await lookupCustomRouterBlockedModels({
          router: input.baseRouter,
          models: input.models,
        });
      } catch (error) {
        captureException(error, {
          tags: { source: 'auto_routing_custom_router_blocked_models' },
        });
        throw new TRPCError({
          code: 'TIMEOUT',
          message: 'Could not check model availability. Try again.',
        });
      }
    }),

  /** What the selected pool would cost now; `empty` when nothing is missing. */
  quote: baseProcedure
    .input(BenchmarkRouterScopeInput)
    .output(PaidBenchmarkQuoteSchema)
    .query(async ({ ctx, input }) => {
      const subject = await readSubject(ctx, input);
      const result = await requestPaidBenchmarkQuote({
        action: 'quote',
        ...workerRef(subject),
        poolSlug: subject.router.slug,
        poolVersion: subject.poolVersion,
        context: subject.context,
      });
      if (!result.ok) throw paidBenchmarkError(result);
      return result.body;
    }),

  /**
   * The explicit confirmation: spends against the confirmed quote or refuses with a reason.
   *
   * Only a signed-in human in the browser may spend. The request boundary classifies the
   * credential (`session` for a browser session, `human_bearer` for an API token, and the
   * workload classes for delegated callers), and `start` is the one action that must not be
   * reachable by automation: a bearer token — human or delegated — is refused here, before the
   * Worker sees anything. The check fails closed, so a context without a derived credential
   * (an unusual constructor) is also refused. Quotes, reads and pause keep their authority.
   *
   * A pool holds one live request, so a second confirmation answers with that request's
   * progress (`status: 'started'` with `alreadyInProgress: true`, plus the tolerated legacy
   * `already_in_progress` during a worker rollout) rather than an error: the UI shows the run in
   * flight and no second request, quote consumption or charge happens.
   */
  start: baseProcedure
    .input(StartBenchmarkInput)
    .output(PaidBenchmarkStartResultSchema)
    .mutation(async ({ ctx, input }) => {
      if (ctx.authViaToken || ctx.credential !== 'session') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Start a benchmark from the Kilo web app, not from an API token.',
        });
      }
      const owner = await resolveOwner(ctx, input.organizationId, 'start');
      // The lock serializes the authorized read and the Worker's durable admission against a pool
      // edit or delete, so no edit can authorize or invalidate a paid start after it is admitted.
      return withLockedCustomRouterBenchmarkSubject({ owner, slug: input.slug }, async subject => {
        const result = await startPaidBenchmark({
          action: 'start',
          ...workerRef(subject),
          poolSlug: subject.router.slug,
          poolVersion: subject.poolVersion,
          context: subject.context,
          quoteId: input.quoteId,
          actorUserId: ctx.user.id,
        });
        if (!result.ok) throw paidBenchmarkError(result);
        return result.body;
      }).catch(routerNotFoundError);
    }),

  /** Per-case progress and spend for this pool's current or named request. */
  progress: baseProcedure
    .input(BenchmarkProgressInput)
    .output(PaidBenchmarkProgressSchema)
    .query(async ({ ctx, input }) => {
      const subject = await readSubject(ctx, input);
      const request: Extract<PaidBenchmarkWorkerRequest, { action: 'progress' }> = {
        action: 'progress',
        ...workerRef(subject),
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      };
      const result = await getPaidBenchmarkProgress(request);
      if (!result.ok) throw paidBenchmarkError(result);
      return result.body;
    }),

  /** Removes this pool's unsettled participation; the last payer being paused cancels the run. */
  pause: baseProcedure
    .input(PauseBenchmarkInput)
    .output(PaidBenchmarkProgressSchema)
    .mutation(async ({ ctx, input }) => {
      const owner = await resolveOwner(ctx, input.organizationId, 'pause');
      const subject = await loadSubjectOrThrow(owner, input.slug);
      const result = await pausePaidBenchmark({
        action: 'pause',
        ...workerRef(subject),
        requestId: input.requestId,
      });
      if (!result.ok) throw paidBenchmarkError(result);
      return result.body;
    }),

  /** Which model serves which route for this pool, from the measurements that exist now. */
  table: baseProcedure
    .input(BenchmarkRouterScopeInput)
    .output(CustomRoutingTableResponseSchema)
    .query(async ({ ctx, input }) => {
      const subject = await readSubject(ctx, input);
      const result = await getCustomRouterTable(subject.context);
      if (result.status !== 200 || !('table' in result.body)) {
        throw paidBenchmarkError({
          status: result.status,
          error: {
            code: null,
            message:
              typeof result.body === 'object' &&
              result.body !== null &&
              'error' in result.body &&
              typeof result.body.error === 'string'
                ? result.body.error
                : 'The benchmark worker could not assemble this pool’s table.',
          },
        });
      }
      return result.body;
    }),
});
