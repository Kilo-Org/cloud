import {
  renderExecutionTurnContent,
  type AcceptedCommandTurn,
  type AcceptedExecutionTurn,
  type AcceptedPromptTurn,
  type AgentSelection,
  type AgentSelectionOverride,
  type SessionMessageIntent,
  type TurnFinalization,
} from '../execution/types.js';
import { dispatchedKilocodeModelId } from '../persistence/model-utils.js';
import type { CloudMessageFailedPayload } from '../session/message-settlement-outbox.js';
import {
  SANDBOX_CONTROL_EXECUTION_TIMEOUT_MS,
  sessionOperationAuthorizationSchema,
  sameSessionOperation,
  type SessionMessageOutcome,
  type SessionOperationAck,
  type SessionOperationAuthorization,
  type SessionOperationDelivery,
} from '../shared/sandbox-control-protocol.js';

export type SessionMessageState = 'queued' | 'accepted' | 'completed' | 'failed' | 'cancelled';
export type SessionMessageTerminalSource = 'coordinator' | 'wrapper_outcome' | 'operation_result';

export type ControlCommandAgentSelection = Omit<AgentSelection, 'model'> & { model?: string };

export type ControlSessionMessageIntent =
  | (SessionMessageIntent & { turn: AcceptedPromptTurn })
  | (Omit<SessionMessageIntent, 'turn' | 'agent'> & {
      turn: AcceptedCommandTurn;
      agent: ControlCommandAgentSelection;
    });

export type ControlSessionMessageInput = Pick<SessionMessageIntent, 'turn' | 'finalization'> & {
  agent?: AgentSelectionOverride;
};

export type SessionOperationProof = {
  authorization: SessionOperationAuthorization;
  dispatched: boolean;
  executionDeadlineAt?: number;
  executionDeadlineSource?: 'dispatch' | 'wrapper';
  result?: SessionOperationDelivery['result'];
  resultHash?: string;
  completedAt?: number;
  attachmentEpoch?: number;
  decision?: SessionOperationAck['decision'];
  rejectionReceived?: true;
};

type SessionMessageLifecycle = {
  messageId: string;
  state: SessionMessageState;
  queuedAt?: number;
  acceptedAt?: number;
  lastActivityAt?: number;
  deliveryDeadlineAt?: number;
  deliveryRetryScope?: 'message' | 'runtime';
  unresolvedDispatch?: true;
  wrapperInstanceId?: string;
  terminalAt?: number;
  terminalSource?: SessionMessageTerminalSource;
  failedReason?: string;
  failedDetail?: string;
  attachFailures?: number;
  promptFailures?: number;
  preparationAttemptId?: string;
  /**
   * Durable wait reason for a head whose preparation attempt is finalized but
   * still bound to an unreleased operation proof. `onProgress` cannot write to
   * a finalized attempt, so reconnect reads this instead. Cleared whenever the
   * attempt identity rotates or the binding is released.
   */
  preparationWait?: { step: string; message: string };
  retryNotBefore?: number;
  executionDeadlineAt?: number;
  cancellation?: { operationId: string; deadlineAt: number };
  /**
   * PR gate verdict reported by a code-review turn. Present only on a completed
   * terminal record whose wrapper observed a gate result; absent otherwise.
   */
  gateResult?: 'pass' | 'fail';
  operations?: {
    attach?: SessionOperationProof;
    retiredAttach?: SessionOperationProof;
    prompt?: SessionOperationProof;
  };
};

export type SessionMessageRecordV2 = SessionMessageLifecycle & {
  readonly version: 2;
  readonly intent: ControlSessionMessageIntent;
  turn?: never;
  prompt?: never;
  finalization?: never;
  legacyIntentInvalid?: never;
};

type LegacySessionMessageRecord = SessionMessageLifecycle & {
  version?: undefined;
  intent?: ControlSessionMessageIntent;
  turn?: AcceptedExecutionTurn;
  prompt?: string;
  finalization?: TurnFinalization;
  legacyIntentInvalid?: true;
};

export type SessionMessageRecord = SessionMessageRecordV2 | LegacySessionMessageRecord;

export const ATTACH_FAILURE_LIMIT = 2;
export const PROMPT_FAILURE_LIMIT = 5;

export function resolveSessionMessageIntent(
  input: ControlSessionMessageInput,
  defaults?: AgentSelectionOverride
): ControlSessionMessageIntent | undefined {
  const model = input.agent?.model !== undefined ? input.agent.model : defaults?.model;
  const modelId = dispatchedKilocodeModelId(model);
  if (model !== undefined && !modelId) return undefined;

  const mode = input.agent?.mode ?? defaults?.mode ?? 'code';
  const variant =
    input.agent?.variant ??
    (modelId === dispatchedKilocodeModelId(defaults?.model) ? defaults?.variant : undefined);
  const agent = {
    mode,
    ...(model !== undefined ? { model } : {}),
    ...(variant !== undefined ? { variant } : {}),
  };
  const finalization = input.finalization
    ? {
        autoCommit: input.finalization.autoCommit,
        condenseOnComplete: input.finalization.condenseOnComplete,
      }
    : undefined;
  if (input.turn.type === 'prompt') {
    if (model === undefined) return undefined;
    return {
      turn: structuredClone(input.turn),
      agent: { ...agent, model },
      ...(finalization ? { finalization } : {}),
    };
  }
  return {
    turn: structuredClone(input.turn),
    agent,
    ...(finalization ? { finalization } : {}),
  };
}

export function createSessionMessageRecord(
  intent: ControlSessionMessageIntent
): SessionMessageRecordV2 {
  return {
    version: 2,
    messageId: intent.turn.messageId,
    state: 'queued',
    intent: structuredClone(intent),
  };
}

export function getSessionMessageTurn(
  message: SessionMessageRecord
): AcceptedExecutionTurn | undefined {
  return (
    message.intent?.turn ??
    message.turn ??
    (message.prompt !== undefined
      ? { type: 'prompt', messageId: message.messageId, prompt: message.prompt }
      : undefined)
  );
}

function sameExecutionTurn(left: AcceptedExecutionTurn, right: AcceptedExecutionTurn): boolean {
  if (left.messageId !== right.messageId) return false;
  if (left.type === 'command') {
    return (
      right.type === 'command' &&
      left.command === right.command &&
      left.arguments === right.arguments
    );
  }
  return (
    right.type === 'prompt' &&
    left.prompt === right.prompt &&
    left.attachments?.path === right.attachments?.path &&
    JSON.stringify(left.attachments?.files) === JSON.stringify(right.attachments?.files)
  );
}

export function matchesSessionMessageReplay(
  message: SessionMessageRecord,
  input: ControlSessionMessageInput
): boolean {
  if (message.state !== 'queued' && message.state !== 'accepted') return false;
  if (message.messageId !== input.turn.messageId || message.legacyIntentInvalid) return false;
  const turn = getSessionMessageTurn(message);
  if (turn && !sameExecutionTurn(turn, input.turn)) return false;
  const requestedModelId = dispatchedKilocodeModelId(input.agent?.model);
  if (input.agent?.model !== undefined && !requestedModelId) return false;
  const intent = message.intent;
  if (!intent) return true;
  return (
    (input.agent?.model === undefined ||
      requestedModelId === dispatchedKilocodeModelId(intent.agent.model)) &&
    (input.agent?.mode === undefined || input.agent.mode === intent.agent.mode) &&
    (input.agent?.variant === undefined || input.agent.variant === intent.agent.variant) &&
    (input.finalization?.autoCommit === undefined ||
      input.finalization.autoCommit === intent.finalization?.autoCommit) &&
    (input.finalization?.condenseOnComplete === undefined ||
      input.finalization.condenseOnComplete === intent.finalization?.condenseOnComplete)
  );
}

export function freezeLegacyQueuedMessages(
  messages: readonly SessionMessageRecord[],
  defaults?: AgentSelectionOverride,
  defaultFinalization?: TurnFinalization
): SessionMessageRecord[] {
  return messages.map((message): SessionMessageRecord => {
    if (message.version === 2 || message.state !== 'queued' || message.intent) return message;
    const { turn, prompt, finalization, legacyIntentInvalid, ...record } = message;
    if (legacyIntentInvalid) return message;
    const legacyTurn =
      turn ??
      (prompt !== undefined
        ? { type: 'prompt' as const, messageId: message.messageId, prompt }
        : undefined);
    const intent = legacyTurn
      ? resolveSessionMessageIntent(
          {
            turn: legacyTurn,
            ...(finalization || defaultFinalization
              ? { finalization: { ...defaultFinalization, ...finalization } }
              : {}),
          },
          defaults
        )
      : undefined;
    return intent
      ? { ...record, ...createSessionMessageRecord(intent) }
      : { ...message, legacyIntentInvalid: true };
  });
}

export function assignPreparationAttemptId(
  messages: readonly SessionMessageRecord[],
  messageId: string,
  mint: () => string
): { messages: SessionMessageRecord[]; attemptId: string } | undefined {
  const message = messages.find(item => item.messageId === messageId);
  if (!message) return undefined;
  if (message.preparationAttemptId) {
    return {
      messages: messages as SessionMessageRecord[],
      attemptId: message.preparationAttemptId,
    };
  }
  const attemptId = mint();
  return {
    messages: messages.map(item =>
      item.messageId === messageId
        ? { ...item, preparationAttemptId: attemptId, preparationWait: undefined }
        : item
    ),
    attemptId,
  };
}

export function failWaitingMessages(
  messages: readonly SessionMessageRecord[],
  reason: string,
  wrapperInstanceId?: string,
  includeUnassigned = true
): { messages: SessionMessageRecord[]; failedIds: string[] } {
  const head =
    messages.find(message => message.state === 'accepted') ??
    messages.find(message => message.state === 'queued');
  const failUnassigned =
    wrapperInstanceId === undefined ||
    (includeUnassigned && head?.wrapperInstanceId === wrapperInstanceId);
  const failedIds: string[] = [];
  return {
    messages: messages.map(message => {
      if (message.state !== 'queued' && message.state !== 'accepted') return message;
      if (
        wrapperInstanceId !== undefined &&
        message.wrapperInstanceId !== wrapperInstanceId &&
        !(message.wrapperInstanceId === undefined && failUnassigned)
      ) {
        return message;
      }
      failedIds.push(message.messageId);
      return {
        ...message,
        state: 'failed',
        failedReason: reason,
      };
    }),
    failedIds,
  };
}

/**
 * True when a queued message still holds an operation proof that binds the
 * current runtime identity and has not been authoritatively retired: a
 * dispatched/completed attach, or any prompt other than one authoritatively
 * rejected before admission (`dispatched === false`). While such a proof exists
 * the delivery must reconcile that operation. It must not mint a new
 * preparation attempt/acquisition or dispatch a new authorization, or the
 * operation identity is split and the reconcile is rejected as changed.
 */
export function hasUnreleasedOperationProof(message: SessionMessageRecord): boolean {
  const attach = message.operations?.attach;
  const prompt = message.operations?.prompt;
  return (
    (attach !== undefined && attach.dispatched === true) ||
    (prompt !== undefined && prompt.dispatched !== false)
  );
}

/**
 * Release queued messages bound to a dying wrapper that never reached a
 * committed prompt. These are safe to retry on a replacement runtime.
 *
 * A never-dispatched message keeps its original `deliveryDeadlineAt`; only its
 * wrapper binding and in-flight preparation state are cleared. A completed (or
 * authoritatively retired) attach proof is moved to `retiredAttach` so a late
 * result for the old authorization cannot restore it and the message can bind a
 * new wrapper. Messages with an ambiguous attach (dispatched without a
 * completed result) stay bound unless `releaseDispatchedAttach` marks the
 * invalidation as an authoritative matching retirement.
 */
export function releaseUnadmittedWaitingMessages(
  messages: readonly SessionMessageRecord[],
  wrapperInstanceId: string,
  options?: { releaseDispatchedAttach?: boolean }
): { messages: SessionMessageRecord[]; releasedIds: string[] } {
  const releasedIds: string[] = [];
  const releaseDispatchedAttach = options?.releaseDispatchedAttach === true;
  return {
    messages: messages.map(message => {
      if (message.state !== 'queued' || message.wrapperInstanceId !== wrapperInstanceId) {
        return message;
      }
      // A dispatched (or ambiguous) prompt may already have executed; never
      // release it here. A prompt authoritatively rejected before admission
      // (`dispatched === false`) never executed, so it is releasable.
      const prompt = message.operations?.prompt;
      if (prompt !== undefined && prompt.dispatched !== false) return message;

      const attach = message.operations?.attach;
      const completedAttach = attach?.dispatched === true && attach.completedAt !== undefined;
      const ambiguousAttach = attach?.dispatched === true && !completedAttach;
      const releaseAttach = completedAttach || (ambiguousAttach && releaseDispatchedAttach);
      if (ambiguousAttach && !releaseAttach) return message;
      if (message.unresolvedDispatch === true && !releaseDispatchedAttach) return message;
      if (!releaseAttach && (message.attachFailures ?? 0) >= ATTACH_FAILURE_LIMIT) return message;

      releasedIds.push(message.messageId);
      return {
        ...message,
        wrapperInstanceId: undefined,
        preparationAttemptId: undefined,
        preparationWait: undefined,
        retryNotBefore: undefined,
        unresolvedDispatch: undefined,
        // Preserve intent and deliveryDeadlineAt: the head keeps its original
        // preparation bound. A released attach proof is retained for late results.
        ...(releaseAttach && attach
          ? { operations: { retiredAttach: attach } }
          : { operations: undefined }),
      };
    }),
    releasedIds,
  };
}

/**
 * Replace a finalized preparation attempt with a fresh one so later wait
 * progress is visible. Preparation may resume on an environment rebuild, so a
 * new attempt id is legal while the prompt has not been dispatched.
 */
export function replacePreparationAttemptId(
  messages: readonly SessionMessageRecord[],
  messageId: string,
  attemptId: string
): SessionMessageRecord[] {
  return messages.map(message =>
    message.messageId === messageId
      ? { ...message, preparationAttemptId: attemptId, preparationWait: undefined }
      : message
  );
}

export function releaseCompletedRetryableAttach(
  messages: readonly SessionMessageRecord[],
  messageId: string,
  retryNotBefore: number
): SessionMessageRecord[] {
  return messages.map(message => {
    const attach = message.messageId === messageId ? message.operations?.attach : undefined;
    if (!attach?.dispatched || attach.result?.ok !== false) return message;
    const operations = { ...message.operations };
    operations.retiredAttach = attach;
    delete operations.attach;
    return {
      ...message,
      unresolvedDispatch: undefined,
      preparationAttemptId: undefined,
      preparationWait: undefined,
      retryNotBefore,
      ...(Object.keys(operations).length > 0 ? { operations } : { operations: undefined }),
    };
  });
}

/**
 * Retire a dispatched attach with no result so this delivery can record a
 * fresh attach against the same runtime, attempt, and deadline. Late results
 * for the reused authorization apply to the live proof; retiredAttach is
 * consulted only when the live slot no longer matches.
 */
export function releaseUnconfirmedAttach(
  messages: readonly SessionMessageRecord[],
  authorization: SessionOperationAuthorization
): SessionMessageRecord[] | undefined {
  const message = messages.find(item => item.messageId === authorization.messageId);
  const attach = message?.operations?.attach;
  if (
    !message ||
    !attach?.dispatched ||
    attach.result !== undefined ||
    !sameSessionOperation(attach.authorization, authorization)
  )
    return undefined;
  const operations = { ...message.operations, retiredAttach: attach };
  delete operations.attach;
  return messages.map(item =>
    item.messageId !== message.messageId
      ? item
      : { ...item, unresolvedDispatch: undefined, operations }
  );
}

export function rotateLostPreparationAttempt(
  messages: readonly SessionMessageRecord[],
  messageId: string,
  retryNotBefore: number
): SessionMessageRecord[] | undefined {
  const message = messages.find(item => item.messageId === messageId);
  if (
    !message ||
    message.state !== 'queued' ||
    message.preparationAttemptId === undefined ||
    message.unresolvedDispatch ||
    message.operations?.attach?.dispatched === true ||
    message.operations?.prompt?.dispatched === true
  )
    return undefined;
  return messages.map(item => {
    if (item.messageId !== messageId) return item;
    const operations = { ...item.operations };
    // Drop only definitively unadmitted proofs (dispatched === false after an
    // authoritative not-admitted rejection). Retain retiredAttach: it is consulted
    // only for late results of the old authorization and cannot block re-dispatch.
    if (operations.attach?.dispatched !== true) delete operations.attach;
    if (operations.prompt?.dispatched !== true) delete operations.prompt;
    return {
      ...item,
      preparationAttemptId: undefined,
      preparationWait: undefined,
      deliveryRetryScope: undefined,
      retryNotBefore,
      ...(Object.keys(operations).length > 0 ? { operations } : { operations: undefined }),
    };
  });
}

export function incrementDeliveryFailure(
  messages: readonly SessionMessageRecord[],
  messageId: string,
  kind: 'attach' | 'prompt'
): { messages: SessionMessageRecord[]; exhausted: boolean } {
  const field = kind === 'attach' ? 'attachFailures' : 'promptFailures';
  const limit = kind === 'attach' ? ATTACH_FAILURE_LIMIT : PROMPT_FAILURE_LIMIT;
  let failures = 0;
  return {
    messages: messages.map(message => {
      if (message.messageId !== messageId || message.state !== 'queued') return message;
      failures = (message[field] ?? 0) + 1;
      return { ...message, [field]: failures };
    }),
    exhausted: failures >= limit,
  };
}

export function nextQueuedMessageId(messages: readonly SessionMessageRecord[]): string | undefined {
  if (messages.some(message => message.state === 'accepted')) return undefined;
  return messages.find(message => message.state === 'queued')?.messageId;
}

export function applyMessageOutcome(
  messages: readonly SessionMessageRecord[],
  outcome: SessionMessageOutcome,
  wrapperInstanceId: string,
  now: number,
  terminalSource: SessionMessageTerminalSource = 'wrapper_outcome'
): SessionMessageRecord[] | undefined {
  const message = messages.find(item => item.messageId === outcome.messageId);
  if (
    !message ||
    (message.state !== 'queued' && message.state !== 'accepted') ||
    message.wrapperInstanceId !== wrapperInstanceId ||
    (message.state === 'queued' && nextQueuedMessageId(messages) !== message.messageId)
  ) {
    return undefined;
  }
  return messages.map(item =>
    item.messageId === outcome.messageId
      ? {
          ...item,
          state: outcome.status,
          unresolvedDispatch: undefined,
          acceptedAt: item.acceptedAt ?? now,
          terminalAt: now,
          terminalSource,
          ...(outcome.reason ? { failedReason: outcome.reason } : {}),
          ...(outcome.gateResult !== undefined ? { gateResult: outcome.gateResult } : {}),
        }
      : item
  );
}

export function hasAcceptedMessage(messages: readonly SessionMessageRecord[]): boolean {
  return messages.some(message => message.state === 'accepted');
}

export function failQueuedMessage(
  messages: readonly SessionMessageRecord[],
  messageId: string,
  reason?: string,
  detail?: string
): SessionMessageRecord[] | undefined {
  if (!messages.some(message => message.messageId === messageId && message.state === 'queued')) {
    return undefined;
  }
  return messages.map(message =>
    message.messageId === messageId && message.state === 'queued'
      ? {
          ...message,
          state: 'failed',
          ...(reason ? { failedReason: reason } : {}),
          ...(detail ? { failedDetail: detail } : {}),
        }
      : message
  );
}

export function failAcceptedMessage(
  messages: readonly SessionMessageRecord[],
  messageId: string,
  reason?: string,
  detail?: string
): SessionMessageRecord[] | undefined {
  if (!messages.some(message => message.messageId === messageId && message.state === 'accepted')) {
    return undefined;
  }
  return messages.map(message =>
    message.messageId === messageId && message.state === 'accepted'
      ? {
          ...message,
          state: 'failed',
          ...(reason ? { failedReason: reason } : {}),
          ...(detail ? { failedDetail: detail } : {}),
        }
      : message
  );
}

export function cancelPendingMessage(
  messages: readonly SessionMessageRecord[],
  messageId: string
): { dropped: boolean; messages?: SessionMessageRecord[] } {
  const target = messages.find(message => message.messageId === messageId);
  if (!target) return { dropped: false };
  if (target.state === 'cancelled' && target.failedReason === 'queued_message_cancelled') {
    return { dropped: true };
  }
  // A queued message whose prompt was never dispatched is always cancellable,
  // even with a preparation attempt, wrapper binding, head deadline, or an
  // incomplete attach proof. An unresolved dispatch or a dispatched prompt is
  // ambiguous with the agent and must be reconciled instead of silently dropped.
  if (
    target.state !== 'queued' ||
    target.acceptedAt !== undefined ||
    target.unresolvedDispatch ||
    target.operations?.prompt?.dispatched === true
  ) {
    return { dropped: false };
  }
  return {
    dropped: true,
    messages: messages.map(message =>
      message.messageId === messageId
        ? { ...message, state: 'cancelled', failedReason: 'queued_message_cancelled' }
        : message
    ),
  };
}

export function acceptQueuedMessage(
  messages: readonly SessionMessageRecord[],
  messageId: string,
  acceptedAt: number
): SessionMessageRecord[] | undefined {
  if (nextQueuedMessageId(messages) !== messageId) return undefined;
  return messages.map(message =>
    message.messageId === messageId
      ? {
          ...message,
          state: 'accepted',
          acceptedAt,
          lastActivityAt: acceptedAt,
          unresolvedDispatch: undefined,
        }
      : message
  );
}

export function recordAcceptedMessageActivity(
  messages: readonly SessionMessageRecord[],
  lastActivityAt: number
): SessionMessageRecord[] | undefined {
  if (!hasAcceptedMessage(messages)) return undefined;
  return messages.map(message =>
    message.state === 'accepted' ? { ...message, lastActivityAt } : message
  );
}

export type StreamQueuedSnapshot = {
  messageId: string;
  content: string;
  timestamp: number;
  delivery?: 'sent';
  terminalFailure?: CloudMessageFailedPayload & { timestamp: number };
};

export function failedMessageSnapshot(
  message: SessionMessageRecord,
  now: number
): CloudMessageFailedPayload & { timestamp: number } {
  const accepted = message.acceptedAt !== undefined;
  const cancelled = message.state === 'cancelled';
  return {
    messageId: message.messageId,
    status: cancelled ? 'interrupted' : 'failed',
    delivery: accepted ? 'sent' : 'queued',
    accepted,
    reason: cancelled ? 'interrupted' : message.failedReason,
    ...(cancelled
      ? { error: 'The message was interrupted' }
      : message.failedDetail || message.failedReason
        ? { error: message.failedDetail ?? message.failedReason }
        : {}),
    timestamp: message.acceptedAt ?? now,
  };
}

export function streamQueuedSnapshots(
  messages: readonly SessionMessageRecord[],
  now: number
): StreamQueuedSnapshot[] {
  return messages
    .filter(
      message =>
        message.state === 'queued' || message.state === 'accepted' || message.state === 'failed'
    )
    .map(message => {
      const turn = getSessionMessageTurn(message);
      return {
        messageId: message.messageId,
        content: turn ? renderExecutionTurnContent(turn) : '',
        timestamp: message.acceptedAt ?? now,
        ...(message.state === 'accepted' ? { delivery: 'sent' as const } : {}),
        ...(message.state === 'failed'
          ? { terminalFailure: failedMessageSnapshot(message, now) }
          : {}),
      };
    });
}

export function streamCloudStatus(
  messages: readonly SessionMessageRecord[]
): { type: 'preparing' } | { type: 'ready' } | null {
  if (hasAcceptedMessage(messages)) return { type: 'ready' };
  if (messages.some(message => message.state === 'queued')) return { type: 'preparing' };
  return messages.length > 0 ? { type: 'ready' } : null;
}

export function applySessionOperationResult(
  messages: readonly SessionMessageRecord[],
  delivery: SessionOperationDelivery,
  resultHash: string,
  now: number
):
  | {
      messages: SessionMessageRecord[];
      disposition: SessionOperationAck['disposition'];
      decision: SessionOperationAck['decision'];
    }
  | undefined {
  const authorization = delivery.authorization;
  const message = messages.find(item => item.messageId === authorization.messageId);
  const kind = authorization.operation === 'session.attach' ? 'attach' : 'prompt';
  let proof = message?.operations?.[kind];
  let proofSlot: 'attach' | 'retiredAttach' | 'prompt' = kind;
  let storedAuthorization = sessionOperationAuthorizationSchema.safeParse(proof?.authorization);
  if (
    kind === 'attach' &&
    (!proof?.dispatched ||
      !storedAuthorization.success ||
      !sameSessionOperation(storedAuthorization.data, authorization))
  ) {
    proof = message?.operations?.retiredAttach;
    proofSlot = 'retiredAttach';
    storedAuthorization = sessionOperationAuthorizationSchema.safeParse(proof?.authorization);
  }
  if (
    !message ||
    !proof?.dispatched ||
    !storedAuthorization.success ||
    message.wrapperInstanceId !== authorization.wrapperInstanceId ||
    !sameSessionOperation(storedAuthorization.data, authorization)
  )
    return undefined;
  if (message.state !== 'queued' && message.state !== 'accepted') {
    if (message.terminalAt === undefined) return undefined;
    return {
      messages: [...messages],
      disposition:
        proof.resultHash === resultHash
          ? 'identical'
          : message.terminalSource === 'coordinator'
            ? 'superseded'
            : 'already_final',
      decision: { state: message.state, at: message.terminalAt },
    };
  }
  if (proof.resultHash !== undefined) {
    return proof.resultHash === resultHash && proof.decision
      ? { messages: [...messages], disposition: 'identical', decision: proof.decision }
      : undefined;
  }
  const applied = delivery.outcome
    ? applyMessageOutcome(
        messages,
        delivery.outcome,
        authorization.wrapperInstanceId,
        now,
        'operation_result'
      )
    : [...messages];
  if (!applied) return undefined;
  const resultMessage = applied.find(item => item.messageId === message.messageId);
  if (!resultMessage) return undefined;
  const decision = {
    state: resultMessage.state,
    at: resultMessage.terminalAt ?? delivery.completedAt,
  };
  const attachmentEpoch =
    kind === 'attach'
      ? (proof.attachmentEpoch ??
        Math.max(0, ...messages.map(item => item.operations?.attach?.attachmentEpoch ?? 0)) + 1)
      : undefined;
  return {
    messages: applied.map(item =>
      item.messageId === message.messageId
        ? {
            ...item,
            operations: {
              ...item.operations,
              [proofSlot]: {
                ...proof,
                result: delivery.result,
                resultHash,
                completedAt: delivery.completedAt,
                decision,
                ...(attachmentEpoch !== undefined ? { attachmentEpoch } : {}),
              },
            },
          }
        : item
    ),
    disposition: 'applied',
    decision,
  };
}

export function recordSessionOperationDispatch(
  messages: readonly SessionMessageRecord[],
  authorization: SessionOperationAuthorization,
  dispatched = true
): SessionMessageRecord[] | undefined {
  const message = messages.find(item => item.messageId === authorization.messageId);
  const kind = authorization.operation === 'session.attach' ? 'attach' : 'prompt';
  const proof = message?.operations?.[kind];
  const storedAuthorization = sessionOperationAuthorizationSchema.safeParse(proof?.authorization);
  if (
    !message ||
    message.cancellation ||
    nextQueuedMessageId(messages) !== message.messageId ||
    message.wrapperInstanceId !== authorization.wrapperInstanceId ||
    (proof &&
      (!storedAuthorization.success ||
        !sameSessionOperation(storedAuthorization.data, authorization)))
  )
    return undefined;
  return messages.map(item =>
    item.messageId === message.messageId
      ? {
          ...item,
          unresolvedDispatch: dispatched ? true : undefined,
          deliveryRetryScope: undefined,
          operations: {
            ...item.operations,
            [kind]: {
              authorization: structuredClone(authorization),
              dispatched,
              ...(kind === 'prompt' && dispatched
                ? {
                    executionDeadlineAt:
                      item.executionDeadlineAt ??
                      authorization.dispatchDeadlineAt + SANDBOX_CONTROL_EXECUTION_TIMEOUT_MS,
                    executionDeadlineSource: proof?.executionDeadlineSource ?? 'dispatch',
                  }
                : {}),
            },
          },
          ...(kind === 'prompt' && dispatched
            ? {
                executionDeadlineAt:
                  item.executionDeadlineAt ??
                  authorization.dispatchDeadlineAt + SANDBOX_CONTROL_EXECUTION_TIMEOUT_MS,
              }
            : {}),
        }
      : item
  );
}

export function markSessionOperationRejection(
  messages: readonly SessionMessageRecord[],
  authorization: SessionOperationAuthorization
): SessionMessageRecord[] | undefined {
  if (authorization.operation !== 'session.attach') return [...messages];
  const message = messages.find(item => item.messageId === authorization.messageId);
  const proof = message?.operations?.attach;
  const storedAuthorization = sessionOperationAuthorizationSchema.safeParse(proof?.authorization);
  if (
    !message ||
    !proof?.dispatched ||
    !storedAuthorization.success ||
    !sameSessionOperation(storedAuthorization.data, authorization)
  )
    return undefined;
  if (proof.rejectionReceived) return [...messages];
  return messages.map(item =>
    item.messageId === message.messageId
      ? {
          ...item,
          operations: {
            ...item.operations,
            attach: { ...proof, rejectionReceived: true },
          },
        }
      : item
  );
}

export function recordSessionOperationExecutionDeadline(
  messages: readonly SessionMessageRecord[],
  authorization: SessionOperationAuthorization,
  executionDeadlineAt: number
): SessionMessageRecord[] | undefined {
  const message = messages.find(item => item.messageId === authorization.messageId);
  const prompt = message?.operations?.prompt;
  const storedAuthorization = sessionOperationAuthorizationSchema.safeParse(prompt?.authorization);
  if (
    authorization.operation !== 'session.prompt' ||
    !Number.isSafeInteger(executionDeadlineAt) ||
    executionDeadlineAt <= 0 ||
    !message ||
    !prompt?.dispatched ||
    !storedAuthorization.success ||
    !sameSessionOperation(storedAuthorization.data, authorization)
  )
    return undefined;
  if (prompt.executionDeadlineSource === 'wrapper') return [...messages];
  return messages.map(item =>
    item.messageId === message.messageId
      ? {
          ...item,
          executionDeadlineAt,
          operations: {
            ...item.operations,
            prompt: {
              ...prompt,
              executionDeadlineAt,
              executionDeadlineSource: 'wrapper',
            },
          },
        }
      : item
  );
}

export function completeSessionOperationAttachment(
  messages: readonly SessionMessageRecord[],
  authorization: SessionOperationAuthorization
): SessionMessageRecord[] | undefined {
  const message = messages.find(item => item.messageId === authorization.messageId);
  const proof = message?.operations?.attach;
  const storedAuthorization = sessionOperationAuthorizationSchema.safeParse(proof?.authorization);
  if (
    authorization.operation !== 'session.attach' ||
    !message ||
    !proof?.dispatched ||
    !storedAuthorization.success ||
    !sameSessionOperation(storedAuthorization.data, authorization) ||
    nextQueuedMessageId(messages) !== message.messageId
  )
    return undefined;
  const attachmentEpoch =
    proof.attachmentEpoch ??
    Math.max(0, ...messages.map(item => item.operations?.attach?.attachmentEpoch ?? 0)) + 1;
  return messages.map(item =>
    item.messageId === message.messageId
      ? {
          ...item,
          unresolvedDispatch: undefined,
          operations: {
            ...item.operations,
            attach: { ...proof, completedAt: proof.completedAt ?? Date.now(), attachmentEpoch },
          },
        }
      : item
  );
}
