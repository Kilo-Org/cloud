/**
 * Session / message machine (design §7). A separate aggregate that holds immutable
 * message intent, delivery/execution outcome, demand, and an opaque binding to one
 * allocation incarnation. It never creates, destroys or observes a sandbox and
 * never decides health.
 *
 * The canonical schema is the stored shape written under the session-messages key as the
 * `{v: 2, binding, messages}` envelope. Attach/prompt/result-hash proofs live in a
 * sibling `proofs` field outside the lifecycle union; a pending cancellation and
 * the immutable intent survive terminalization so no durable metadata is dropped.
 */
import { z } from 'zod';
import {
  CloudAgentAssistantFailureReasonSchema,
  CloudAgentProviderOwnershipSchema,
  WorkspaceFailureSubtypeSchema,
} from '@kilocode/worker-utils/cloud-agent-failure';

export { CloudAgentAssistantFailureReasonSchema, CloudAgentProviderOwnershipSchema };
export type {
  CloudAgentAssistantFailureReason,
  CloudAgentProviderOwnership,
} from '@kilocode/worker-utils/cloud-agent-failure';

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const sessionMessageStateNameSchema = z.enum([
  'queued',
  'accepted',
  'completed',
  'failed',
  'cancelled',
]);
export type SessionMessageStateName = z.infer<typeof sessionMessageStateNameSchema>;

export const sessionMessageTerminalSourceSchema = z.enum([
  'coordinator',
  'wrapper_outcome',
  'operation_result',
]);
export type SessionMessageTerminalSource = z.infer<typeof sessionMessageTerminalSourceSchema>;

export const gateResultSchema = z.enum(['pass', 'fail']);
export type GateResult = z.infer<typeof gateResultSchema>;

export const agentSelectionSchema = z
  .object({
    mode: z.string().min(1),
    model: z.string().min(1).optional(),
    variant: z.string().min(1).optional(),
  })
  .strict();

export const turnFinalizationSchema = z
  .object({
    autoCommit: z.boolean().optional(),
    condenseOnComplete: z.boolean().optional(),
  })
  .strict();

export type TurnFinalization = z.infer<typeof turnFinalizationSchema>;

export const acceptedTurnSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('prompt'),
      messageId: z.string().min(1),
      prompt: z.string(),
      attachments: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('command'),
      messageId: z.string().min(1),
      command: z.string(),
      arguments: z.string(),
    })
    .strict(),
]);

export type AcceptedTurn = z.infer<typeof acceptedTurnSchema>;

export const sessionMessageIntentSchema = z
  .object({
    turn: acceptedTurnSchema,
    agent: agentSelectionSchema,
    finalization: turnFinalizationSchema.optional(),
  })
  .strict();

export type SessionMessageIntent = z.infer<typeof sessionMessageIntentSchema>;

/** Fields of a legacy (pre-intent) row preserved verbatim. */
export const legacyFreeformIntentSchema = z
  .object({
    turn: acceptedTurnSchema.optional(),
    prompt: z.string().optional(),
    finalization: turnFinalizationSchema.optional(),
  })
  .strict();

export const runtimeHandleSchema = z
  .object({
    incarnation: z.string().min(1).max(256),
    wrapper: z.string().min(1).max(256),
    epoch: z.number().int().nonnegative(),
  })
  .strict();

export type RuntimeHandle = z.infer<typeof runtimeHandleSchema>;

/**
 * A session that has accepted work but whose legacy rows carried no allocation
 * incarnation cannot fabricate a handle: the allocation loss proof carries the
 * allocation's incarnation, and a fabricated one would reject that real proof.
 * `unresolved` is that honest state; a `BIND` with the authoritative handle
 * (supplied by the migration context) resolves it.
 */
export const bindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unbound') }).strict(),
  z.object({ kind: z.literal('unresolved') }).strict(),
  z.object({ kind: z.literal('bound'), handle: runtimeHandleSchema }).strict(),
]);

export type Binding = z.infer<typeof bindingSchema>;

export const sessionOperationAuthorizationSchema = z
  .object({
    operation: z.enum(['session.attach', 'session.prompt']),
    operationId: z.string().min(1).max(128),
    messageId: z.string().min(1).max(128),
    session: z
      .object({
        sessionId: z.string().min(1),
        kiloSessionId: z.string().min(1),
        directory: z.string().min(1),
      })
      .strict(),
    wrapperInstanceId: z.string().min(1),
    dispatchDeadlineAt: timestamp,
  })
  .strict();

export type SessionOperationAuthorization = z.infer<typeof sessionOperationAuthorizationSchema>;

export const controlErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
    /** Frozen from `shared/sandbox-control-protocol.ts`; preserved end to end. */
    admission: z.literal('not-admitted').optional(),
    /** Git workspace failure subtype carried on a control rejection; optional/additive. */
    subtype: WorkspaceFailureSubtypeSchema.optional().catch(undefined),
  })
  .strict();

export type ControlError = z.infer<typeof controlErrorSchema>;

export const sessionOperationResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: controlErrorSchema }).strict(),
]);

export const sessionOperationDecisionSchema = z
  .object({
    state: sessionMessageStateNameSchema,
    at: timestamp,
  })
  .strict();

export const sessionOperationProofSchema = z
  .object({
    authorization: sessionOperationAuthorizationSchema,
    dispatched: z.boolean(),
    executionDeadlineAt: timestamp.optional(),
    executionDeadlineSource: z.enum(['dispatch', 'wrapper']).optional(),
    result: sessionOperationResultSchema.optional(),
    resultHash: z.string().min(1).optional(),
    completedAt: timestamp.optional(),
    attachmentEpoch: timestamp.optional(),
    decision: sessionOperationDecisionSchema.optional(),
    rejectionReceived: z.literal(true).optional(),
    /** Git workspace failure subtype recorded from a confirmed attach rejection. */
    rejectionSubtype: WorkspaceFailureSubtypeSchema.optional(),
  })
  .strict();

export type SessionOperationProof = z.infer<typeof sessionOperationProofSchema>;

export const messageProofsSchema = z
  .object({
    attach: sessionOperationProofSchema.optional(),
    retiredAttach: sessionOperationProofSchema.optional(),
    prompt: sessionOperationProofSchema.optional(),
  })
  .strict();

export type MessageProofs = z.infer<typeof messageProofsSchema>;

/** Durable cancellation marker; fences dispatch after a cancel request. */
export const cancellationSchema = z
  .object({
    operationId: z.string().min(1),
    deadlineAt: timestamp,
  })
  .strict();

export type Cancellation = z.infer<typeof cancellationSchema>;

export const preparationWaitSchema = z
  .object({
    step: z.string().min(1),
    message: z.string(),
  })
  .strict();

const intentCarryFields = {
  intent: sessionMessageIntentSchema.nullable(),
  legacyInvalidIntent: z.literal(true).optional(),
  legacy: legacyFreeformIntentSchema.optional(),
};

/**
 * Automatic no-output recoveries already spent on this turn. The immutable
 * intent survives a recovery re-queue; this counter is the one piece of the
 * retired dispatch lifecycle that survives with it, bounding both producers of
 * `wrapper_no_output` (the accepted-message inactivity path and the legacy
 * wrapper watchdog) to a single automatic recovery before a second identical
 * detection terminalizes — and naming the attempt count in that failure payload.
 */
const recoveryAttemptsField = z.number().int().nonnegative().optional();

/**
 * The exclusive intent tri-state carried on every lifecycle variant. Each
 * message is exactly one of: resolved (`intent`), unresolved (`intent: null`
 * with a legacy payload a later freeze may resolve), or permanently invalid
 * (`intent: null` with `legacyInvalidIntent`). A failed freeze may retain the
 * payload alongside the marker, so the marker wins and the payload is allowed.
 */
function intentTriState(
  value: {
    intent: SessionMessageIntent | null;
    legacy?: unknown;
    legacyInvalidIntent?: true;
  },
  ctx: z.RefinementCtx
): void {
  if (value.intent !== null) {
    if (value.legacy !== undefined || value.legacyInvalidIntent === true) {
      ctx.addIssue({
        code: 'custom',
        message: 'a resolved intent must not carry legacy intent data or an invalid marker',
      });
    }
    return;
  }
  if (value.legacy === undefined && value.legacyInvalidIntent !== true) {
    ctx.addIssue({
      code: 'custom',
      message:
        'message must carry an immutable intent, a legacy payload, or be marked legacy-invalid',
    });
  }
}

export const queuedMessageStateSchema = z
  .object({
    kind: z.literal('queued'),
    ...intentCarryFields,
    queuedAt: timestamp.optional(),
    recoveryAttempts: recoveryAttemptsField,
    deliveryStep: z.enum(['waiting', 'preparing']),
    deadlineAt: timestamp.nullable(),
    retryNotBefore: timestamp.optional(),
    attachFailures: z.number().int().nonnegative(),
    promptFailures: z.number().int().nonnegative(),
    preparationAttemptId: z.string().min(1).optional(),
    preparationWait: preparationWaitSchema.optional(),
    unresolvedDispatch: z.literal(true).optional(),
    wrapperInstanceId: z.string().min(1).optional(),
    /**
     * Retry scope of the last delivery failure. `deliveryStep` cannot own this:
     * it conflates the retry scope with "has a preparation attempt", so the
     * original scope cannot be recovered from it.
     */
    deliveryRetryScope: z.enum(['message', 'runtime']).optional(),
    /**
     * Consecutive delivery-deadline deferrals granted while the control plane
     * reported a runtime replacement in flight. Bounds a replacement that never
     * completes so the head still reaches its terminal preparation timeout. The
     * count resets when the head binds a replacement runtime: that closes the
     * chain, so a later replacement gets its own budget.
     */
    replacementWaits: z.number().int().nonnegative().optional(),
  })
  .strict();

export const acceptedMessageStateSchema = z
  .object({
    kind: z.literal('accepted'),
    ...intentCarryFields,
    queuedAt: timestamp.optional(),
    recoveryAttempts: recoveryAttemptsField,
    acceptedAt: timestamp,
    lastActivityAt: timestamp.optional(),
    /** The bounded execution deadline (design §7 "execution bound"); never optional. */
    executionDeadlineAt: timestamp,
    capAt: timestamp.optional(),
    wrapperInstanceId: z.string().min(1).optional(),
    preparationAttemptId: z.string().min(1).optional(),
  })
  .strict();

export const completedMessageStateSchema = z
  .object({
    kind: z.literal('completed'),
    ...intentCarryFields,
    queuedAt: timestamp.optional(),
    recoveryAttempts: recoveryAttemptsField,
    acceptedAt: timestamp.optional(),
    at: timestamp,
    source: sessionMessageTerminalSourceSchema,
    result: z.unknown().optional(),
    assistantMessageId: z.string().min(1).optional(),
    wrapperInstanceId: z.string().min(1).optional(),
    preparationAttemptId: z.string().min(1).optional(),
    gateResult: gateResultSchema.optional(),
  })
  .strict();

export const failedMessageStateSchema = z
  .object({
    kind: z.literal('failed'),
    ...intentCarryFields,
    queuedAt: timestamp.optional(),
    recoveryAttempts: recoveryAttemptsField,
    acceptedAt: timestamp.optional(),
    at: timestamp,
    source: sessionMessageTerminalSourceSchema,
    reason: z.string().optional(),
    detail: z.string().optional(),
    assistantReason: CloudAgentAssistantFailureReasonSchema.optional(),
    providerOwnership: CloudAgentProviderOwnershipSchema.optional(),
    wrapperInstanceId: z.string().min(1).optional(),
    preparationAttemptId: z.string().min(1).optional(),
  })
  .strict();

export const cancelledMessageStateSchema = z
  .object({
    kind: z.literal('cancelled'),
    ...intentCarryFields,
    queuedAt: timestamp.optional(),
    recoveryAttempts: recoveryAttemptsField,
    acceptedAt: timestamp.optional(),
    at: timestamp,
    source: sessionMessageTerminalSourceSchema,
    reason: z.string().optional(),
    wrapperInstanceId: z.string().min(1).optional(),
    preparationAttemptId: z.string().min(1).optional(),
  })
  .strict();

export const messageStateSchema = z
  .union([
    queuedMessageStateSchema,
    acceptedMessageStateSchema,
    completedMessageStateSchema,
    failedMessageStateSchema,
    cancelledMessageStateSchema,
  ])
  .superRefine(intentTriState);

export type QueuedMessageState = z.infer<typeof queuedMessageStateSchema>;
export type AcceptedMessageState = z.infer<typeof acceptedMessageStateSchema>;
export type FailedMessageState = z.infer<typeof failedMessageStateSchema>;
export type CancelledMessageState = z.infer<typeof cancelledMessageStateSchema>;

export type MessageState = z.infer<typeof messageStateSchema>;

export const sessionMessageSchema = z
  .object({
    messageId: z.string().min(1).max(128),
    state: messageStateSchema,
    proofs: messageProofsSchema.optional(),
    cancellation: cancellationSchema.optional(),
  })
  .strict();

export type SessionMessage = z.infer<typeof sessionMessageSchema>;

function acceptedRequiresBinding(
  value: { binding: Binding; messages: readonly SessionMessage[] },
  ctx: z.RefinementCtx
): void {
  if (
    value.binding.kind === 'unbound' &&
    value.messages.some(message => message.state.kind === 'accepted')
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'an accepted message requires a bound session handle',
    });
  }
}

export const sessionAggregateSchema = z
  .object({
    binding: bindingSchema,
    messages: z.array(sessionMessageSchema),
  })
  .strict()
  .superRefine(acceptedRequiresBinding);

export type SessionAggregate = z.infer<typeof sessionAggregateSchema>;

export const sessionEnvelopeSchema = z
  .object({
    v: z.literal(2),
    binding: bindingSchema,
    messages: z.array(sessionMessageSchema),
  })
  .strict()
  .superRefine(acceptedRequiresBinding);

export type SessionEnvelope = z.infer<typeof sessionEnvelopeSchema>;

export function emptySessionAggregate(): SessionAggregate {
  return { binding: { kind: 'unbound' }, messages: [] };
}

export function unbound(): Binding {
  return { kind: 'unbound' };
}
