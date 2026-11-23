import * as z from 'zod';
import { OwnerIdentityShape } from './owner';
import { CustomRouterBenchmarkContextSchema, CustomRouterSlugSchema } from './custom-router';

export const PaidBenchmarkIdSchema = z.uuid();
export const BenchmarkMicrodollarsSchema = z.int().nonnegative();
const count = z.int().nonnegative();

const QuoteCountsSchema = z.object({
  reused: count,
  covered: count,
  shared: count,
  exclusive: count,
});

export const PaidBenchmarkQuoteSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('empty') }),
  z.object({
    status: z.literal('ready'),
    id: PaidBenchmarkIdSchema,
    expiresAt: z.iso.datetime(),
    estimateMicrodollars: BenchmarkMicrodollarsSchema,
    maximumMicrodollars: BenchmarkMicrodollarsSchema,
    cases: QuoteCountsSchema,
    aliases: z.array(z.object({ model: z.string(), target: z.string() })),
  }),
]);
export type PaidBenchmarkQuote = z.infer<typeof PaidBenchmarkQuoteSchema>;

export const PaidBenchmarkCaseStatusSchema = z.enum([
  'queued',
  'running',
  'reused',
  'done',
  'failed',
  'paused',
]);
export type PaidBenchmarkCaseStatus = z.infer<typeof PaidBenchmarkCaseStatusSchema>;

const ModelRequestUsageFields = {
  billedModelRequests: count,
  kiloCoveredModelRequests: count,
  kiloCoveredMicrodollars: BenchmarkMicrodollarsSchema,
};

const PaidBenchmarkCaseSchema = z.object({
  id: z.string(),
  model: z.string(),
  variant: z.string().nullable(),
  caseId: z.string(),
  repetition: count,
  status: PaidBenchmarkCaseStatusSchema,
  ...ModelRequestUsageFields,
  coveredByKilo: z.boolean(),
  chargedMicrodollars: BenchmarkMicrodollarsSchema,
  reason: z.string().nullable(),
});
export type PaidBenchmarkCase = z.infer<typeof PaidBenchmarkCaseSchema>;

const ProgressFields = {
  id: PaidBenchmarkIdSchema,
  estimateMicrodollars: BenchmarkMicrodollarsSchema,
  maximumMicrodollars: BenchmarkMicrodollarsSchema,
  chargedMicrodollars: BenchmarkMicrodollarsSchema,
  ...ModelRequestUsageFields,
  pendingModelRequests: count.optional(),
  counts: z.record(PaidBenchmarkCaseStatusSchema, count),
  cases: z.array(PaidBenchmarkCaseSchema),
  nextCursor: z.string().nullable(),
};

export const PaidBenchmarkProgressSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('empty') }),
  z.object({ status: z.literal('preparing'), ...ProgressFields }),
  z.object({ status: z.literal('active'), ...ProgressFields }),
  z.object({ status: z.literal('completed'), ...ProgressFields }),
  z.object({
    status: z.literal('paused'),
    ...ProgressFields,
    reason: z.string().nullable(),
    pausedModels: z.array(z.string()).optional(),
  }),
  z.object({
    status: z.literal('failed'),
    ...ProgressFields,
    reason: z.string(),
    retryable: z.boolean(),
  }),
]);
export type PaidBenchmarkProgress = z.infer<typeof PaidBenchmarkProgressSchema>;

export const PaidBenchmarkStartResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('started'),
    request: PaidBenchmarkProgressSchema,
    /**
     * This pool already had a live request, so the click joined it instead of creating one:
     * nothing new was priced, consumed or charged. It is a field on `started`, not a new
     * status, so a web release that predates it still validates the body (the object schema
     * strips unknown keys) and shows the same live progress.
     *
     * Deploy order is not relied on in either direction: `deploy-workers` and the Vercel
     * stage-and-promote chain run side by side (`promote-app` does not need `deploy-workers`),
     * so either side can be older. See the tolerated legacy alias below for the reverse window.
     */
    alreadyInProgress: z.boolean().optional(),
  }),
  /**
   * Tolerated for one release: a worker that predates `alreadyInProgress` answers a second
   * start with this status. A newer web must still show the live request instead of reporting
   * the worker's answer as invalid while the worker rollout is in progress, so it parses to the
   * same meaning. Remove once no deployed worker can answer it.
   */
  z.object({ status: z.literal('already_in_progress'), request: PaidBenchmarkProgressSchema }),
  z.object({
    status: z.literal('insufficient_balance'),
    requiredMicrodollars: BenchmarkMicrodollarsSchema.optional(),
    availableMicrodollars: BenchmarkMicrodollarsSchema.optional(),
  }),
  z.object({ status: z.literal('quote_expired') }),
  z.object({ status: z.literal('quote_mismatch'), reason: z.string() }),
  z.object({ status: z.literal('blocked'), reason: z.string(), retryable: z.boolean() }),
]);
export type PaidBenchmarkStartResult = z.infer<typeof PaidBenchmarkStartResultSchema>;

export const PaidBenchmarkRouterRefSchema = z.object({
  slug: CustomRouterSlugSchema,
  organizationId: z.uuid().optional(),
});

const WorkerRef = { ...OwnerIdentityShape, routerId: z.uuid() };
const WorkerPlan = {
  ...WorkerRef,
  poolSlug: CustomRouterSlugSchema,
  poolVersion: z.string().min(1).max(128),
  context: CustomRouterBenchmarkContextSchema,
};

export const PAID_BENCHMARK_PATH = '/admin/custom-router-benchmark';
export const PaidBenchmarkWorkerRequestSchema = z
  .discriminatedUnion('action', [
    z.object({ action: z.literal('quote'), ...WorkerPlan }),
    z.object({
      action: z.literal('start'),
      ...WorkerPlan,
      quoteId: PaidBenchmarkIdSchema,
      actorUserId: z.string().min(1),
    }),
    z.object({
      action: z.literal('progress'),
      ...WorkerRef,
      requestId: PaidBenchmarkIdSchema.optional(),
      cursor: z.string().max(512).optional(),
    }),
    // A pause may name the request, or leave it out to pause the owner's latest live request
    // for this router (the pool-edit/delete fence: "pause either paused it or nothing was live").
    z.object({
      action: z.literal('pause'),
      ...WorkerRef,
      requestId: PaidBenchmarkIdSchema.optional(),
    }),
  ])
  .refine(
    request =>
      !('context' in request) ||
      (request.ownerType === request.context.ownerType &&
        request.ownerId === request.context.ownerId),
    { path: ['context'], message: 'Benchmark context must match the request owner.' }
  );
export type PaidBenchmarkWorkerRequest = z.infer<typeof PaidBenchmarkWorkerRequestSchema>;
