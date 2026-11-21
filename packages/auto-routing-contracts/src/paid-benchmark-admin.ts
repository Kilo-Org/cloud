import * as z from 'zod';
import { CustomRoutingTableResponseSchema } from './benchmark';
import { OwnerIdSchema, OwnerTypeSchema } from './owner';
import {
  BenchmarkMicrodollarsSchema,
  PaidBenchmarkCaseStatusSchema,
  PaidBenchmarkIdSchema,
} from './paid-benchmark';
import { AutoRouterSchema } from './router';

/**
 * Admin console contract for both benchmark queues. The user-paid requests live in the
 * benchmark worker's D1 (`paid_benchmark_requests` and the case-run payer rows), so the
 * console reads them through the worker's admin routes; the web admin route only adds
 * the labels the worker cannot resolve (pool name, owner label) from PostgreSQL.
 */

/** Worker admin paths behind the internal admin secret. */
export const PAID_BENCHMARK_ADMIN_PATH = '/admin/paid-requests';
export const PAID_BENCHMARK_ADMIN_PROGRESS_PATH = '/admin/paid-requests/progress';
export const PAID_BENCHMARK_ADMIN_PAUSE_PATH = '/admin/paid-requests/pause';
export const PAID_BENCHMARK_ADMIN_ROUTING_TABLE_PATH = '/admin/paid-requests/routing-table';

const count = z.int().nonnegative();

export const PaidBenchmarkAdminRequestStatusSchema = z.enum([
  'preparing',
  'active',
  'completed',
  'paused',
  'failed',
]);
export type PaidBenchmarkAdminRequestStatus = z.infer<typeof PaidBenchmarkAdminRequestStatusSchema>;

/**
 * Payer detail from durable per-model-request assignments and their usage receipts. The
 * platform row carries no identity: an admin sees how many model requests Kilo covered and
 * for how much, never a user id. A detached payer keeps its reason and its already-billed
 * spend, because usage that reached the provider is never refunded by the detach.
 */
export const PaidBenchmarkAdminPayerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('platform'),
    kiloCoveredModelRequests: count,
    kiloCoveredMicrodollars: BenchmarkMicrodollarsSchema,
  }),
  z.object({
    kind: OwnerTypeSchema,
    ownerId: OwnerIdSchema,
    /** Native model requests this payer was billed for. */
    billedModelRequests: count,
    chargedMicrodollars: BenchmarkMicrodollarsSchema,
    /** Why the last assignment was detached (e.g. no funds), or null. */
    detachReason: z.string().nullable(),
    /** Web-resolved email or organization name; null on the worker response. */
    ownerLabel: z.string().nullable(),
  }),
]);
export type PaidBenchmarkAdminPayer = z.infer<typeof PaidBenchmarkAdminPayerSchema>;

export const PaidBenchmarkAdminRequestSchema = z.object({
  id: PaidBenchmarkIdSchema,
  router: AutoRouterSchema,
  /** Saved custom router id; the console names it through the web-resolved `poolName`. */
  routerId: z.uuid(),
  organizationId: z.uuid().nullable(),
  requester: z.object({
    kind: OwnerTypeSchema,
    ownerId: OwnerIdSchema,
    actorUserId: z.string().min(1),
    /** Web-resolved email or organization name; null on the worker response. */
    ownerLabel: z.string().nullable(),
  }),
  status: PaidBenchmarkAdminRequestStatusSchema,
  createdAt: z.iso.datetime(),
  activatedAt: z.iso.datetime().nullable(),
  pausedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  estimateMicrodollars: BenchmarkMicrodollarsSchema,
  /**
   * The full-cost figure shown before the click. Advisory only: native billing charges each
   * model request as it happens, so a request can spend past it.
   */
  maximumMicrodollars: BenchmarkMicrodollarsSchema,
  /** Actual spend observed for this request's billed native model requests. */
  chargedMicrodollars: BenchmarkMicrodollarsSchema,
  /** Native model requests this request was billed for. */
  billedModelRequests: count,
  /** Native model requests Kilo covered from its join onward. */
  kiloCoveredModelRequests: count,
  kiloCoveredMicrodollars: BenchmarkMicrodollarsSchema,
  /**
   * Why the request is paused: `no_funds` when billing detached its payer, `owner` for a
   * manual pause. Spend is advisory only — nothing pauses a request for reaching an
   * amount.
   */
  pauseReason: z.enum(['no_funds', 'owner']).nullable(),
  counts: z.record(PaidBenchmarkCaseStatusSchema, count),
  payers: z.array(PaidBenchmarkAdminPayerSchema),
  /** Web-resolved saved pool name; null on the worker response. */
  poolName: z.string().nullable(),
  failureReason: z.string().nullable(),
  failureRetryable: z.boolean(),
});
export type PaidBenchmarkAdminRequest = z.infer<typeof PaidBenchmarkAdminRequestSchema>;

export const PaidBenchmarkAdminListResponseSchema = z.object({
  requests: z.array(PaidBenchmarkAdminRequestSchema),
  nextCursor: z.string().nullable(),
});
export type PaidBenchmarkAdminListResponse = z.infer<typeof PaidBenchmarkAdminListResponseSchema>;

/** Per-case detail page for one request, refreshed behind its list row. */
export const PaidBenchmarkAdminCaseSchema = z.object({
  id: z.string(),
  model: z.string(),
  variant: z.string().nullable(),
  caseId: z.string(),
  repetition: count,
  status: PaidBenchmarkCaseStatusSchema,
  /** True when Kilo covered this case's model requests from its join onward. */
  coveredByKilo: z.boolean(),
  /** Billed model requests of this case and their actual spend. */
  billedModelRequests: count,
  chargedMicrodollars: BenchmarkMicrodollarsSchema,
  /** Detach or failure reason recorded on the case (e.g. no funds), or null. */
  reason: z.string().nullable(),
});
export type PaidBenchmarkAdminCase = z.infer<typeof PaidBenchmarkAdminCaseSchema>;

export const PaidBenchmarkAdminProgressResponseSchema = z.object({
  status: z.union([z.literal('empty'), PaidBenchmarkAdminRequestStatusSchema]),
  /** Null only when `status` is 'empty'. */
  request: PaidBenchmarkAdminRequestSchema.nullable(),
  cases: z.array(PaidBenchmarkAdminCaseSchema),
  nextCursor: z.string().nullable(),
});
export type PaidBenchmarkAdminProgressResponse = z.infer<
  typeof PaidBenchmarkAdminProgressResponseSchema
>;

export const PaidBenchmarkAdminPauseRequestSchema = z.object({
  requestId: PaidBenchmarkIdSchema,
});
export type PaidBenchmarkAdminPauseRequest = z.infer<typeof PaidBenchmarkAdminPauseRequestSchema>;

export const PaidBenchmarkAdminPauseResponseSchema = z.object({
  status: z.enum(['paused', 'already_paused', 'not_active', 'not_found']),
});
export type PaidBenchmarkAdminPauseResponse = z.infer<typeof PaidBenchmarkAdminPauseResponseSchema>;

/** The request's pool routing result, built from the context its quote was bound to. */
export const PaidBenchmarkAdminRoutingTableRequestSchema = z.object({
  requestId: PaidBenchmarkIdSchema,
});
export type PaidBenchmarkAdminRoutingTableRequest = z.infer<
  typeof PaidBenchmarkAdminRoutingTableRequestSchema
>;

export const PaidBenchmarkAdminRoutingTableResponseSchema = CustomRoutingTableResponseSchema;
export type PaidBenchmarkAdminRoutingTableResponse = z.infer<
  typeof PaidBenchmarkAdminRoutingTableResponseSchema
>;

/**
 * Operator cancel of one platform benchmark run. Platform work is automatic, so this is
 * the only admin stop control; it never touches a paid user request.
 */
export const BenchmarkRunCancelResponseSchema = z.object({
  status: z.enum(['cancelled', 'already_finished', 'not_found']),
});
export type BenchmarkRunCancelResponse = z.infer<typeof BenchmarkRunCancelResponseSchema>;
