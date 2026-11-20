import * as z from 'zod';
import {
  BENCHMARK_PLATFORM_PROJECT_ID,
  BenchmarkProjectIdSchema,
  parseBenchmarkProjectId,
} from './benchmark-project';

export const BENCHMARK_CASE_INFERENCE_PATH = '/case-inference';
export const BENCHMARK_CASE_CAPABILITY_SCOPE = 'auto-routing-benchmark:case-inference';
/** Purpose separation for the Worker→gateway assignment credential (never a user token). */
export const BENCHMARK_GATEWAY_ASSIGNMENT_SCOPE = 'auto-routing-benchmark:gateway-assignment';

export const BENCHMARK_ASSIGNMENT_HEADER = 'x-kilo-benchmark-assignment';
export const BENCHMARK_ADMISSION_HEADER = 'x-kilo-benchmark-admission';
export const BENCHMARK_USAGE_ID_HEADER = 'x-kilo-benchmark-usage-id';
export const BENCHMARK_MODEL_REQUEST_ID_HEADER = 'x-kilo-benchmark-model-request-id';

export const BenchmarkInferenceApiSchema = z.enum(['chat/completions', 'messages', 'responses']);
export type BenchmarkInferenceApi = z.infer<typeof BenchmarkInferenceApiSchema>;

export const BenchmarkCaseInvocationSchema = z.object({
  engineIdentity: z.string().min(1).max(128),
  runId: z.string().min(1).max(256),
  model: z.string().min(1).max(200),
  variant: z.string().max(100),
  caseId: z.string().min(1).max(256),
  repetition: z.int().nonnegative(),
  generation: z.int().positive(),
  startedAt: z.int().positive(),
});
export type BenchmarkCaseInvocation = z.infer<typeof BenchmarkCaseInvocationSchema>;

export function benchmarkCaseCapabilityParts(invocation: BenchmarkCaseInvocation): string[] {
  return [
    invocation.engineIdentity,
    invocation.runId,
    invocation.model,
    invocation.variant,
    invocation.caseId,
    String(invocation.repetition),
    String(invocation.generation),
    String(invocation.startedAt),
  ];
}

/**
 * Who pays one model request. `null` is the platform covering it: the gateway then bills the
 * platform-supported benchmark identity and reports zero payer, never a user.
 */
export const BenchmarkPayerSchema = z.object({
  type: z.enum(['user', 'organization']),
  id: z.string().min(1).max(128),
});
export type BenchmarkPayer = z.infer<typeof BenchmarkPayerSchema>;

/**
 * One authenticated model request the Worker hands the gateway.
 *
 * - `modelRequestId` is the native call identity: one model call, so a duplicated delivery is
 *   the same call and cannot be admitted twice.
 * - `assignmentId` names the candidate attempt under that call; the Worker can refuse it and
 *   select another candidate for the same `modelRequestId`.
 * - `requestId` is the paid pool request (display/aggregation). It is null when the platform
 *   covers the call, which is why this is nullable rather than required.
 * - `usageId` is minted here and becomes `microdollar_usage.id` verbatim, so a replayed HTTP
 *   call cannot double-charge and a receipt is looked up by that one value.
 *
 * The assignment is signed as an HMAC over {@link benchmarkGatewayAssignmentParts} with
 * {@link BENCHMARK_GATEWAY_ASSIGNMENT_SCOPE}; it is the only payer/identity source the
 * gateway accepts for a case request.
 */
export const BenchmarkGatewayAssignmentSchema = BenchmarkCaseInvocationSchema.extend({
  api: BenchmarkInferenceApiSchema,
  modelRequestId: z.uuid(),
  assignmentId: z.uuid(),
  /** The paid pool request; null only for a platform-covered call. */
  requestId: z.uuid().nullable(),
  usageId: z.uuid(),
  /** The payer account; null only for a platform-covered call. */
  payer: BenchmarkPayerSchema.nullable(),
  /**
   * The human member whose membership and allowance front this call: it equals the payer for
   * a personal payer, and for an organization payer it is the signed actor whose
   * `organization_memberships` row funds it (never a `billing_manager`, never the bot). For a
   * platform-covered call it is the platform benchmark identity from the run snapshot.
   */
  actorUserId: z.string().min(1).max(128),
  executorUserId: z.string().min(1).max(128),
  /**
   * The organization a platform-covered call bills, taken from the run snapshot. Required
   * exactly when `payer` is null: a platform call must debit the configured benchmark
   * organization, never the executor's personal balance.
   */
  platformOrganizationId: z.uuid().nullable(),
  /**
   * `Auto-routing benchmarks / platform` for a platform-covered call, else the canonical pool
   * id for exactly the signed payer's scope.
   */
  projectId: BenchmarkProjectIdSchema,
}).superRefine((assignment, ctx) => {
  const { payer, requestId } = assignment;
  if ((payer === null) !== (requestId === null)) {
    ctx.addIssue({
      code: 'custom',
      path: ['payer'],
      message: 'A payer and a paid request are both present, or both absent',
    });
    return;
  }
  if (payer === null) {
    if (assignment.projectId !== BENCHMARK_PLATFORM_PROJECT_ID) {
      ctx.addIssue({
        code: 'custom',
        path: ['projectId'],
        message: 'A platform-covered call must use the platform project',
      });
    }
    if (assignment.platformOrganizationId === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['platformOrganizationId'],
        message: 'A platform-covered call must name the organization it bills',
      });
    }
    return;
  }
  if (assignment.platformOrganizationId !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['platformOrganizationId'],
      message: 'Only a platform-covered call names a platform organization',
    });
  }
  if (payer.type === 'user' && payer.id !== assignment.actorUserId) {
    ctx.addIssue({
      code: 'custom',
      path: ['actorUserId'],
      message: 'A personal payer must be the signed actor',
    });
  }
  const project = parseBenchmarkProjectId(assignment.projectId);
  if (!project) {
    ctx.addIssue({
      code: 'custom',
      path: ['projectId'],
      message: 'A paid call must use its pool project id',
    });
    return;
  }
  const expectedScope = payer.type === 'user' ? 'user' : 'org';
  if (project.scope !== expectedScope) {
    ctx.addIssue({
      code: 'custom',
      path: ['projectId'],
      message: 'The pool project scope must match the payer type',
    });
  }
});
export type BenchmarkGatewayAssignment = z.infer<typeof BenchmarkGatewayAssignmentSchema>;

export function benchmarkGatewayAssignmentParts(assignment: BenchmarkGatewayAssignment): string[] {
  return [
    ...benchmarkCaseCapabilityParts(assignment),
    assignment.api,
    assignment.modelRequestId,
    assignment.assignmentId,
    assignment.requestId ?? '',
    assignment.usageId,
    assignment.payer ? `${assignment.payer.type}:${assignment.payer.id}` : 'platform',
    assignment.actorUserId,
    assignment.executorUserId,
    assignment.platformOrganizationId ?? '',
    assignment.projectId,
  ];
}

/**
 * Why the gateway refused before any provider call, or why it could not admit. `payment_refused`
 * and `payer_unavailable` are decided by the gateway itself (authoritative balance/membership);
 * the rest come from the Worker's admit callback.
 */
export const BenchmarkAdmissionRefusalReasonSchema = z.enum([
  /** The payer cannot spend and the model is not free; no provider call, no usage row. */
  'payment_refused',
  /** The signed payer identity does not resolve to a billable member; no provider call. */
  'payer_unavailable',
  /** The signed payer is no longer the selected candidate; trusted, no upstream call. */
  'payer_changed',
  /** The platform latched coverage for this generation; trusted, no upstream call. */
  'platform_joined',
  'case_paused',
  'generation_closed',
  'already_settled',
  'attempt_superseded',
  'no_funded_payer',
  /** No committed usage may exist for this model request and it may not be replayed. */
  'duplicate_attempt',
  /** A policy/guardrail/rate gate answered before the provider; no usage row, safe to pause. */
  'pre_upstream_refused',
  /**
   * The concrete pair is terminally failed in the benchmark registry (catalog-absent or its
   * proven failure budget): no future admission of this case can succeed. Nothing was
   * dispatched; the case pauses and no payer is detached or charged.
   */
  'permanently_failed',
  /** The admission callback could not be reached: outcome uncertain, never reassign. */
  'admission_unavailable',
  /**
   * The assignment envelope itself is not authentic: missing, unsigned, malformed or expired.
   * Nothing was dispatched and this is not a statement about the payer's ability to pay, so the
   * Worker must never detach or charge the account — it stops the call and reports a bad
   * credential instead.
   */
  'assignment_invalid',
]);
export type BenchmarkAdmissionRefusalReason = z.infer<typeof BenchmarkAdmissionRefusalReasonSchema>;

/** The one decision the gateway needs before it may start a provider call. */
export const BenchmarkCaseAdmitRequestSchema = z.object({
  phase: z.literal('admit'),
  assignment: BenchmarkGatewayAssignmentSchema,
  usageId: z.uuid(),
});
export type BenchmarkCaseAdmitRequest = z.infer<typeof BenchmarkCaseAdmitRequestSchema>;

export const BenchmarkCaseAdmitResponseSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('admit') }),
  z.object({
    decision: z.literal('refuse'),
    reason: BenchmarkAdmissionRefusalReasonSchema,
    retryable: z.boolean(),
  }),
]);
export type BenchmarkCaseAdmitResponse = z.infer<typeof BenchmarkCaseAdmitResponseSchema>;

export const BENCHMARK_CASE_ADMIT_PATH = '/internal/case-admit';
/** The pin the gateway adds to a *rebuilt* request, never read from an inbound caller. */
export const BENCHMARK_CASE_INFERENCE_GATEWAY_PATH = '/internal/benchmark/case-inference';

// ---------------------------------------------------------------------------------------------
// Native usage receipts: the authenticated read that turns a deferred usage id into an actual
// charge, so "receipt missing" is disclosed rather than mistaken for free.
// ---------------------------------------------------------------------------------------------

export const BENCHMARK_USAGE_RECEIPTS_PATH = '/api/internal/usage/receipts';

export const BenchmarkUsageReceiptRequestSchema = z.object({
  usageIds: z.array(z.uuid()).min(1).max(100),
});
export type BenchmarkUsageReceiptRequest = z.infer<typeof BenchmarkUsageReceiptRequestSchema>;

export const BenchmarkUsageReceiptSchema = z.object({
  usageId: z.uuid(),
  /** `recorded` means a committed `microdollar_usage` row exists; `pending` means it does not. */
  status: z.enum(['recorded', 'pending']),
  microdollars: z.int().nonnegative().nullable(),
  payerType: z.enum(['user', 'organization']).nullable(),
  payerId: z.string().nullable(),
  projectId: z.string().nullable(),
  /** The concrete model the case signed, so the Worker can associate the receipt to its row. */
  requestedModel: z.string().nullable(),
  /** The model the provider reported for the generation, when it reported one. */
  model: z.string().nullable(),
  createdAt: z.iso.datetime().nullable(),
});
export type BenchmarkUsageReceipt = z.infer<typeof BenchmarkUsageReceiptSchema>;

export const BenchmarkUsageReceiptResponseSchema = z.object({
  receipts: z.array(BenchmarkUsageReceiptSchema),
});
export type BenchmarkUsageReceiptResponse = z.infer<typeof BenchmarkUsageReceiptResponseSchema>;
