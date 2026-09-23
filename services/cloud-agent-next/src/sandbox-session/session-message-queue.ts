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
import type {
  CloudAgentAssistantFailureReason,
  CloudAgentProviderOwnership,
} from '@kilocode/worker-utils/cloud-agent-failure';
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
import {
  decideSession,
  headQueuedMessageId,
  terminalMessageState,
} from '../sandbox-state/session/reduce.js';
import type {
  AcceptedTurn,
  MessageProofs,
  QueuedMessageState,
  SessionAggregate,
  SessionMessage,
  SessionMessageStateName,
  SessionMessageTerminalSource,
  SessionOperationProof,
} from '../sandbox-state/model/session.js';

export type { SessionMessage, SessionAggregate, SessionOperationProof };
export type SessionMessageState = SessionMessageStateName;
export type { SessionMessageTerminalSource };

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

export const ATTACH_FAILURE_LIMIT = 2;
export const PROMPT_FAILURE_LIMIT = 5;

/**
 * Deferral budget for a head whose preparation deadline lands while the control
 * plane reports a runtime replacement in flight. Each deferral grants a fresh
 * delivery window, so the budget caps the wait inside one replacement cycle and
 * leaves the existing terminal path to run when a replacement never completes.
 * Binding the replacement runtime ends the cycle and starts the next budget.
 */
export const RUNTIME_REPLACEMENT_WAIT_LIMIT = 6;

// ---------------------------------------------------------------------------
// Canonical field access. The wire model nests per-state fields under `state`;
// these helpers keep the one mapping in one place.
// ---------------------------------------------------------------------------

function findMessage(aggregate: SessionAggregate, messageId: string): SessionMessage | undefined {
  return aggregate.messages.find(message => message.messageId === messageId);
}

function isActive(message: SessionMessage): boolean {
  return message.state.kind === 'queued' || message.state.kind === 'accepted';
}

export function activeWrapperInstanceId(message: SessionMessage): string | undefined {
  return message.state.kind === 'queued' || message.state.kind === 'accepted'
    ? message.state.wrapperInstanceId
    : undefined;
}

/**
 * The message's retained delivery/settlement identity, union-wide. Ordinary
 * terminalization preserves it; allocation-loss terminalization clears it. Fences
 * that must reject a stale event after any terminalization read this; the
 * `activeWrapperInstanceId` prerequisite is only for checks that explicitly
 * require a live `queued`/`accepted` state.
 */
export function deliveryWrapperInstanceId(message: SessionMessage): string | undefined {
  return message.state.wrapperInstanceId;
}

export function deliveryPreparationAttemptId(message: SessionMessage): string | undefined {
  return message.state.preparationAttemptId;
}

export function acceptedAtOf(message: SessionMessage): number | undefined {
  return message.state.kind === 'queued' ? undefined : message.state.acceptedAt;
}

export function queuedAtOf(message: SessionMessage): number | undefined {
  return message.state.queuedAt;
}

export function terminalAtOf(message: SessionMessage): number | undefined {
  return message.state.kind === 'completed' ||
    message.state.kind === 'failed' ||
    message.state.kind === 'cancelled'
    ? message.state.at
    : undefined;
}

export function terminalSourceOf(
  message: SessionMessage
): SessionMessageTerminalSource | undefined {
  return message.state.kind === 'completed' ||
    message.state.kind === 'failed' ||
    message.state.kind === 'cancelled'
    ? message.state.source
    : undefined;
}

export function failedReasonOf(message: SessionMessage): string | undefined {
  return message.state.kind === 'failed' || message.state.kind === 'cancelled'
    ? message.state.reason
    : undefined;
}

export function failedDetailOf(message: SessionMessage): string | undefined {
  return message.state.kind === 'failed' ? message.state.detail : undefined;
}

export function assistantReasonOf(
  message: SessionMessage
): CloudAgentAssistantFailureReason | undefined {
  return message.state.kind === 'failed' ? message.state.assistantReason : undefined;
}

export function providerOwnershipOf(
  message: SessionMessage
): CloudAgentProviderOwnership | undefined {
  return message.state.kind === 'failed' ? message.state.providerOwnership : undefined;
}

function withoutFields<T extends object>(value: T, fields: readonly string[]): T {
  const next = { ...value } as Record<string, unknown>;
  for (const field of fields) delete next[field];
  return next as T;
}

function withoutProofs(message: SessionMessage): SessionMessage {
  const { proofs: _proofs, ...rest } = message;
  return rest;
}

function withProofs(message: SessionMessage, proofs: MessageProofs | undefined): SessionMessage {
  return proofs === undefined ? withoutProofs(message) : { ...message, proofs };
}

/** The canonical intent turns and the execution turns are the same validated shape. */
function toExecutionTurn(turn: AcceptedTurn): AcceptedExecutionTurn {
  return turn as AcceptedExecutionTurn;
}

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

export function createSessionMessageRecord(intent: ControlSessionMessageIntent): SessionMessage {
  return {
    messageId: intent.turn.messageId,
    state: {
      kind: 'queued',
      intent: structuredClone(intent),
      deliveryStep: 'waiting',
      deadlineAt: null,
      attachFailures: 0,
      promptFailures: 0,
    },
  };
}

export function getSessionMessageTurn(message: SessionMessage): AcceptedExecutionTurn | undefined {
  const state = message.state;
  if (state.intent) return toExecutionTurn(state.intent.turn);
  const legacy = state.legacy;
  if (legacy?.turn) return toExecutionTurn(legacy.turn);
  return legacy?.prompt !== undefined
    ? { type: 'prompt', messageId: message.messageId, prompt: legacy.prompt }
    : undefined;
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
  message: SessionMessage,
  input: ControlSessionMessageInput
): boolean {
  if (!isActive(message)) return false;
  if (message.messageId !== input.turn.messageId || message.state.legacyInvalidIntent) return false;
  const turn = getSessionMessageTurn(message);
  if (turn && !sameExecutionTurn(turn, input.turn)) return false;
  const requestedModelId = dispatchedKilocodeModelId(input.agent?.model);
  if (input.agent?.model !== undefined && !requestedModelId) return false;
  const intent = message.state.intent;
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
  messages: readonly SessionMessage[],
  defaults?: AgentSelectionOverride,
  defaultFinalization?: TurnFinalization
): SessionMessage[] {
  return messages.map((message): SessionMessage => {
    const state = message.state;
    // Resolved and permanently invalid rows are never re-resolved; only an
    // unresolved row (no intent, no marker, with a legacy payload) is attempted.
    if (state.kind !== 'queued' || state.intent !== null || state.legacyInvalidIntent === true) {
      return message;
    }
    const legacy = state.legacy;
    const legacyTurn =
      legacy?.turn ??
      (legacy?.prompt !== undefined
        ? { type: 'prompt' as const, messageId: message.messageId, prompt: legacy.prompt }
        : undefined);
    const intent = legacyTurn
      ? resolveSessionMessageIntent(
          {
            turn: toExecutionTurn(legacyTurn),
            ...(legacy?.finalization || defaultFinalization
              ? { finalization: { ...defaultFinalization, ...legacy?.finalization } }
              : {}),
          },
          defaults
        )
      : undefined;
    if (!intent) {
      // A failed resolution is permanent: mark the row invalid and keep its
      // legacy payload, so a later freeze with a valid model cannot promote it.
      return { ...message, state: { ...state, legacyInvalidIntent: true as const } };
    }
    const { legacyInvalidIntent: _invalid, legacy: _legacy, ...rest } = state;
    return { ...message, state: { ...rest, intent } };
  });
}

export function assignPreparationAttemptId(
  messages: readonly SessionMessage[],
  messageId: string,
  mint: () => string
): { messages: SessionMessage[]; attemptId: string } | undefined {
  const message = messages.find(item => item.messageId === messageId);
  if (!message) return undefined;
  const state = message.state.kind === 'queued' ? message.state : undefined;
  if (state?.preparationAttemptId) {
    return { messages: messages as SessionMessage[], attemptId: state.preparationAttemptId };
  }
  const attemptId = mint();
  return {
    messages: messages.map(item =>
      item.messageId === messageId && item.state.kind === 'queued'
        ? {
            ...item,
            state: withoutFields({ ...item.state, preparationAttemptId: attemptId }, [
              'preparationWait',
            ]),
          }
        : item
    ),
    attemptId,
  };
}

/**
 * Terminal kind for a waiting message. A durable `cancellation` records an
 * admitted user stop intent, so the message settles as `cancelled` regardless
 * of the internal reason that reached the coordinator; otherwise it is a
 * failure.
 */
export function terminalizeWaitingMessage(
  message: SessionMessage,
  reason: string,
  at: number
): SessionMessage {
  if (message.cancellation !== undefined) {
    return {
      ...message,
      state: terminalMessageState(message.state, 'cancelled', at, 'coordinator', {}),
    };
  }
  return {
    ...message,
    state: terminalMessageState(message.state, 'failed', at, 'coordinator', { reason }),
  };
}

export function failWaitingMessages(
  messages: readonly SessionMessage[],
  reason: string,
  wrapperInstanceId?: string,
  includeUnassigned = true,
  at: number = Date.now()
): { messages: SessionMessage[]; failedIds: string[] } {
  const head =
    messages.find(message => message.state.kind === 'accepted') ??
    messages.find(message => message.state.kind === 'queued');
  const failUnassigned =
    wrapperInstanceId === undefined ||
    (includeUnassigned &&
      head !== undefined &&
      activeWrapperInstanceId(head) === wrapperInstanceId);
  const failedIds: string[] = [];
  return {
    messages: messages.map(message => {
      if (!isActive(message)) return message;
      if (
        wrapperInstanceId !== undefined &&
        activeWrapperInstanceId(message) !== wrapperInstanceId &&
        !(activeWrapperInstanceId(message) === undefined && failUnassigned)
      ) {
        return message;
      }
      failedIds.push(message.messageId);
      return terminalizeWaitingMessage(message, reason, at);
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
export function hasUnreleasedOperationProof(message: SessionMessage): boolean {
  const attach = message.proofs?.attach;
  const prompt = message.proofs?.prompt;
  return (
    (attach !== undefined && attach.dispatched === true) ||
    (prompt !== undefined && prompt.dispatched !== false)
  );
}

/**
 * Release queued messages bound to a dying wrapper that never reached a
 * committed prompt. These are safe to retry on a replacement runtime.
 *
 * A never-dispatched message keeps its original deadline; only its wrapper
 * binding and in-flight preparation state are cleared. A completed (or
 * authoritatively retired) attach proof is moved to `retiredAttach` so a late
 * result for the old authorization cannot restore it and the message can bind a
 * new wrapper. Messages with an ambiguous attach (dispatched without a
 * completed result) stay bound unless `releaseDispatchedAttach` marks the
 * invalidation as an authoritative matching retirement.
 */
export function releaseUnadmittedWaitingMessages(
  messages: readonly SessionMessage[],
  wrapperInstanceId: string,
  options?: { releaseDispatchedAttach?: boolean }
): { messages: SessionMessage[]; releasedIds: string[] } {
  const releasedIds: string[] = [];
  const releaseDispatchedAttach = options?.releaseDispatchedAttach === true;
  return {
    messages: messages.map(message => {
      if (
        message.state.kind !== 'queued' ||
        message.state.wrapperInstanceId !== wrapperInstanceId
      ) {
        return message;
      }
      // A dispatched (or ambiguous) prompt may already have executed; never
      // release it here. A prompt authoritatively rejected before admission
      // (`dispatched === false`) never executed, so it is releasable.
      const prompt = message.proofs?.prompt;
      if (prompt !== undefined && prompt.dispatched !== false) return message;

      const attach = message.proofs?.attach;
      const completedAttach = attach?.dispatched === true && attach.completedAt !== undefined;
      const ambiguousAttach = attach?.dispatched === true && !completedAttach;
      const releaseAttach = completedAttach || (ambiguousAttach && releaseDispatchedAttach);
      if (ambiguousAttach && !releaseAttach) return message;
      if (message.state.unresolvedDispatch === true && !releaseDispatchedAttach) return message;
      if (!releaseAttach && message.state.attachFailures >= ATTACH_FAILURE_LIMIT) return message;

      releasedIds.push(message.messageId);
      const cleared = withoutFields(message.state, [
        'wrapperInstanceId',
        'preparationAttemptId',
        'preparationWait',
        'retryNotBefore',
        'unresolvedDispatch',
      ]);
      // Preserve intent and deadline: the head keeps its original preparation
      // bound. A released attach proof is retained for late results.
      const proofs =
        releaseAttach && attach
          ? { retiredAttach: retireAttachProof(attach, message.proofs?.retiredAttach) }
          : undefined;
      return withProofs({ ...message, state: cleared }, proofs);
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
  messages: readonly SessionMessage[],
  messageId: string,
  attemptId: string
): SessionMessage[] {
  return messages.map(message =>
    message.messageId === messageId && message.state.kind === 'queued'
      ? {
          ...message,
          state: withoutFields({ ...message.state, preparationAttemptId: attemptId }, [
            'preparationWait',
          ]) as QueuedMessageState,
        }
      : message
  );
}

export function releaseCompletedRetryableAttach(
  messages: readonly SessionMessage[],
  messageId: string,
  retryNotBefore: number
): SessionMessage[] {
  return messages.map(message => {
    const attach = message.messageId === messageId ? message.proofs?.attach : undefined;
    if (!attach?.dispatched || attach.result?.ok !== false) return message;
    const proofs: MessageProofs = {
      ...message.proofs,
      retiredAttach: retireAttachProof(attach, message.proofs?.retiredAttach),
    };
    delete proofs.attach;
    return withProofs(
      {
        ...message,
        state: withoutFields({ ...message.state, retryNotBefore }, [
          'unresolvedDispatch',
          'preparationAttemptId',
          'preparationWait',
        ]) as QueuedMessageState,
      },
      Object.keys(proofs).length > 0 ? proofs : undefined
    );
  });
}

/**
 * Retire a dispatched attach with no result so this delivery can record a
 * fresh attach against the same runtime, attempt, and deadline. Late results
 * for the reused authorization apply to the live proof; retiredAttach is
 * consulted only when the live slot no longer matches.
 */
export function releaseUnconfirmedAttach(
  messages: readonly SessionMessage[],
  authorization: SessionOperationAuthorization
): SessionMessage[] | undefined {
  const message = messages.find(item => item.messageId === authorization.messageId);
  const attach = message?.proofs?.attach;
  if (
    !message ||
    !attach?.dispatched ||
    attach.result !== undefined ||
    !sameSessionOperation(attach.authorization, authorization)
  )
    return undefined;
  const proofs: MessageProofs = {
    ...message.proofs,
    retiredAttach: retireAttachProof(attach, message.proofs?.retiredAttach),
  };
  delete proofs.attach;
  return messages.map(item =>
    item.messageId !== message.messageId
      ? item
      : {
          ...withProofs(item, proofs),
          state: withoutFields(item.state, ['unresolvedDispatch']) as QueuedMessageState,
        }
  );
}

export function rotateLostPreparationAttempt(
  messages: readonly SessionMessage[],
  messageId: string,
  retryNotBefore: number
): SessionMessage[] | undefined {
  const message = messages.find(item => item.messageId === messageId);
  if (
    !message ||
    message.state.kind !== 'queued' ||
    message.state.preparationAttemptId === undefined ||
    message.state.unresolvedDispatch ||
    message.proofs?.attach?.dispatched === true ||
    message.proofs?.prompt?.dispatched === true
  )
    return undefined;
  return messages.map(item => {
    if (item.messageId !== messageId || item.state.kind !== 'queued') return item;
    const proofs: MessageProofs = { ...item.proofs };
    // Drop only definitively unadmitted proofs (dispatched === false after an
    // authoritative not-admitted rejection). Retain retiredAttach: it is consulted
    // only for late results of the old authorization and cannot block re-dispatch.
    if (proofs.attach?.dispatched !== true) delete proofs.attach;
    if (proofs.prompt?.dispatched !== true) delete proofs.prompt;
    return withProofs(
      {
        ...item,
        state: withoutFields({ ...item.state, retryNotBefore }, [
          'preparationAttemptId',
          'preparationWait',
          'deliveryRetryScope',
        ]) as QueuedMessageState,
      },
      Object.keys(proofs).length > 0 ? proofs : undefined
    );
  });
}

export function incrementDeliveryFailure(
  messages: readonly SessionMessage[],
  messageId: string,
  kind: 'attach' | 'prompt'
): { messages: SessionMessage[]; exhausted: boolean } {
  const field = kind === 'attach' ? 'attachFailures' : 'promptFailures';
  const limit = kind === 'attach' ? ATTACH_FAILURE_LIMIT : PROMPT_FAILURE_LIMIT;
  let failures = 0;
  return {
    messages: messages.map(message => {
      if (message.messageId !== messageId || message.state.kind !== 'queued') return message;
      failures = message.state[field] + 1;
      return { ...message, state: { ...message.state, [field]: failures } };
    }),
    exhausted: failures >= limit,
  };
}

export function nextQueuedMessageId(messages: readonly SessionMessage[]): string | undefined {
  return headQueuedMessageId(messages);
}

export function applyMessageOutcome(
  aggregate: SessionAggregate,
  outcome: SessionMessageOutcome,
  wrapperInstanceId: string,
  now: number,
  terminalSource: SessionMessageTerminalSource = 'wrapper_outcome'
): SessionAggregate | undefined {
  const message = findMessage(aggregate, outcome.messageId);
  if (
    !message ||
    !isActive(message) ||
    activeWrapperInstanceId(message) !== wrapperInstanceId ||
    (message.state.kind === 'queued' &&
      headQueuedMessageId(aggregate.messages) !== message.messageId)
  ) {
    return undefined;
  }
  return decideSession(
    aggregate,
    {
      type: 'OUTCOME',
      messageId: outcome.messageId,
      status: outcome.status,
      at: now,
      source: terminalSource,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.gateResult !== undefined ? { gateResult: outcome.gateResult } : {}),
      ...(outcome.assistantReason !== undefined
        ? { assistantReason: outcome.assistantReason }
        : {}),
      ...(outcome.providerOwnership !== undefined
        ? { providerOwnership: outcome.providerOwnership }
        : {}),
    },
    now
  )?.state;
}

export function hasAcceptedMessage(messages: readonly SessionMessage[]): boolean {
  return messages.some(message => message.state.kind === 'accepted');
}

export function failQueuedMessage(
  aggregate: SessionAggregate,
  messageId: string,
  reason?: string,
  detail?: string,
  at: number = Date.now()
): SessionAggregate | undefined {
  const message = findMessage(aggregate, messageId);
  if (
    !message ||
    message.state.kind !== 'queued' ||
    headQueuedMessageId(aggregate.messages) !== messageId
  ) {
    return undefined;
  }
  return decideSession(
    aggregate,
    {
      type: 'OUTCOME',
      messageId,
      status: 'failed',
      at,
      source: 'coordinator',
      ...(reason ? { reason } : {}),
      ...(detail ? { detail } : {}),
    },
    at
  )?.state;
}

export function failAcceptedMessage(
  aggregate: SessionAggregate,
  messageId: string,
  reason?: string,
  detail?: string,
  at: number = Date.now()
): SessionAggregate | undefined {
  const message = findMessage(aggregate, messageId);
  if (!message || message.state.kind !== 'accepted') return undefined;
  return decideSession(
    aggregate,
    {
      type: 'OUTCOME',
      messageId,
      status: 'failed',
      at,
      source: 'coordinator',
      ...(reason ? { reason } : {}),
      ...(detail ? { detail } : {}),
    },
    at
  )?.state;
}

export function cancelPendingMessage(
  aggregate: SessionAggregate,
  messageId: string,
  at: number = Date.now()
): { dropped: boolean; messages?: SessionMessage[] } {
  const target = findMessage(aggregate, messageId);
  if (!target) return { dropped: false };
  if (target.state.kind === 'cancelled' && target.state.reason === 'queued_message_cancelled') {
    return { dropped: true };
  }
  // The legacy contract drops only a queued message; the canonical `CANCEL`
  // would otherwise cancel an accepted message.
  if (target.state.kind !== 'queued') return { dropped: false };
  // The ambiguity predicate stays in the reducer: an unresolved dispatch or a
  // dispatched prompt records a bounded cancellation marker instead of dropping.
  const decision = decideSession(
    aggregate,
    { type: 'CANCEL', scope: 'message', messageId, at },
    at
  );
  if (!decision) return { dropped: false };
  const decided = decision.state.messages.find(message => message.messageId === messageId);
  if (decided?.state.kind === 'cancelled') {
    return { dropped: true, messages: decision.state.messages };
  }
  // Ambiguous: the reducer recorded the marker but the legacy refusal must be
  // preserved, so the marker is not persisted by this path.
  return { dropped: false };
}

export function acceptQueuedMessage(
  aggregate: SessionAggregate,
  messageId: string,
  acceptedAt: number
): SessionAggregate | undefined {
  return decideSession(aggregate, { type: 'ACCEPT', messageId, acceptedAt }, acceptedAt)?.state;
}

export function recordAcceptedMessageActivity(
  messages: readonly SessionMessage[],
  lastActivityAt: number
): SessionMessage[] | undefined {
  if (!hasAcceptedMessage(messages)) return undefined;
  return messages.map(message =>
    message.state.kind === 'accepted'
      ? { ...message, state: { ...message.state, lastActivityAt } }
      : message
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
  message: SessionMessage,
  now: number
): CloudMessageFailedPayload & { timestamp: number } {
  const acceptedAt = acceptedAtOf(message);
  const accepted = acceptedAt !== undefined;
  const cancelled = message.state.kind === 'cancelled';
  const reason = message.state.kind === 'failed' ? message.state.reason : undefined;
  const detail = message.state.kind === 'failed' ? message.state.detail : undefined;
  return {
    messageId: message.messageId,
    status: cancelled ? 'interrupted' : 'failed',
    delivery: accepted ? 'sent' : 'queued',
    accepted,
    reason: cancelled ? 'interrupted' : reason,
    ...(cancelled
      ? { error: 'The message was interrupted' }
      : detail || reason
        ? { error: detail ?? reason }
        : {}),
    timestamp: acceptedAt ?? now,
  };
}

export function streamQueuedSnapshots(
  messages: readonly SessionMessage[],
  now: number
): StreamQueuedSnapshot[] {
  return messages
    .filter(
      message =>
        message.state.kind === 'queued' ||
        message.state.kind === 'accepted' ||
        message.state.kind === 'failed'
    )
    .map(message => {
      const turn = getSessionMessageTurn(message);
      return {
        messageId: message.messageId,
        content: turn ? renderExecutionTurnContent(turn) : '',
        timestamp: acceptedAtOf(message) ?? now,
        ...(message.state.kind === 'accepted' ? { delivery: 'sent' as const } : {}),
        ...(message.state.kind === 'failed'
          ? { terminalFailure: failedMessageSnapshot(message, now) }
          : {}),
      };
    });
}

export function streamCloudStatus(
  messages: readonly SessionMessage[]
): { type: 'preparing' } | { type: 'ready' } | null {
  if (hasAcceptedMessage(messages)) return { type: 'ready' };
  if (messages.some(message => message.state.kind === 'queued')) return { type: 'preparing' };
  return messages.length > 0 ? { type: 'ready' } : null;
}

/**
 * Mint the next attach epoch. A retired proof keeps its epoch in the pool: the
 * native-runtime fence rejects an in-place rebind recorded at an epoch it
 * already holds, and the retired proof's epoch is the one that fence carries, so
 * re-minting it would make the replacement attach look like a stale result.
 */
function nextAttachmentEpoch(messages: readonly SessionMessage[]): number {
  return (
    Math.max(
      0,
      ...messages.flatMap(message => [
        message.proofs?.attach?.attachmentEpoch ?? 0,
        message.proofs?.retiredAttach?.attachmentEpoch ?? 0,
      ])
    ) + 1
  );
}

/**
 * Retire an attach proof into the `retiredAttach` slot without losing the epoch
 * high-water mark. The slot holds one proof, so retiring a proof that has no
 * epoch — a dispatched attach whose result never arrived — would otherwise drop
 * the epoch the native-runtime fence holds: the next attach would re-mint it and
 * the fence would refuse it as a stale result. The retired proof carries the
 * higher epoch forward as the pool's floor.
 */
export function retireAttachProof(
  attach: SessionOperationProof,
  previous: SessionOperationProof | undefined
): SessionOperationProof {
  const carried = Math.max(attach.attachmentEpoch ?? 0, previous?.attachmentEpoch ?? 0);
  return carried === 0 ? attach : { ...attach, attachmentEpoch: carried };
}

export function applySessionOperationResult(
  aggregate: SessionAggregate,
  delivery: SessionOperationDelivery,
  resultHash: string,
  now: number
):
  | {
      messages: SessionMessage[];
      disposition: SessionOperationAck['disposition'];
      decision: SessionOperationAck['decision'];
    }
  | undefined {
  const authorization = delivery.authorization;
  const messages = aggregate.messages;
  const message = messages.find(item => item.messageId === authorization.messageId);
  const kind = authorization.operation === 'session.attach' ? 'attach' : 'prompt';
  let proof = message?.proofs?.[kind];
  let proofSlot: 'attach' | 'retiredAttach' | 'prompt' = kind;
  let storedAuthorization = sessionOperationAuthorizationSchema.safeParse(proof?.authorization);
  if (
    kind === 'attach' &&
    (!proof?.dispatched ||
      !storedAuthorization.success ||
      !sameSessionOperation(storedAuthorization.data, authorization))
  ) {
    proof = message?.proofs?.retiredAttach;
    proofSlot = 'retiredAttach';
    storedAuthorization = sessionOperationAuthorizationSchema.safeParse(proof?.authorization);
  }
  const state = message?.state;
  // The message owns its delivery identity, union-wide and before the terminal
  // branch, exactly as HEAD compared `message.wrapperInstanceId`. A terminal
  // message whose retained dispatched proof matches still fences on its
  // retained wrapper, so a post-STOPPED late result is refused (its identity was
  // cleared) rather than acknowledged through the proof.
  if (
    !message ||
    !state ||
    !proof?.dispatched ||
    !storedAuthorization.success ||
    !sameSessionOperation(storedAuthorization.data, authorization) ||
    deliveryWrapperInstanceId(message) !== authorization.wrapperInstanceId
  )
    return undefined;
  if (state.kind !== 'queued' && state.kind !== 'accepted') {
    return {
      messages: [...messages],
      disposition:
        proof.resultHash === resultHash
          ? 'identical'
          : state.source === 'coordinator'
            ? 'superseded'
            : 'already_final',
      decision: { state: state.kind, at: state.at },
    };
  }
  if (proof.resultHash !== undefined) {
    return proof.resultHash === resultHash && proof.decision
      ? { messages: [...messages], disposition: 'identical', decision: proof.decision }
      : undefined;
  }
  const applied = delivery.outcome
    ? applyMessageOutcome(
        aggregate,
        delivery.outcome,
        authorization.wrapperInstanceId,
        now,
        'operation_result'
      )?.messages
    : [...messages];
  if (!applied) return undefined;
  const resultMessage = applied.find(item => item.messageId === message.messageId);
  if (!resultMessage) return undefined;
  const resultState = resultMessage.state;
  const decision = {
    state: resultState.kind,
    at:
      resultState.kind === 'completed' ||
      resultState.kind === 'failed' ||
      resultState.kind === 'cancelled'
        ? resultState.at
        : delivery.completedAt,
  };
  const attachmentEpoch =
    kind === 'attach' ? (proof.attachmentEpoch ?? nextAttachmentEpoch(messages)) : undefined;
  return {
    messages: applied.map(item =>
      item.messageId === message.messageId
        ? {
            ...item,
            proofs: {
              ...item.proofs,
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
  messages: readonly SessionMessage[],
  authorization: SessionOperationAuthorization,
  dispatched = true
): SessionMessage[] | undefined {
  const message = messages.find(item => item.messageId === authorization.messageId);
  const kind = authorization.operation === 'session.attach' ? 'attach' : 'prompt';
  const proof = message?.proofs?.[kind];
  const storedAuthorization = sessionOperationAuthorizationSchema.safeParse(proof?.authorization);
  if (
    !message ||
    message.cancellation ||
    nextQueuedMessageId(messages) !== message.messageId ||
    activeWrapperInstanceId(message) !== authorization.wrapperInstanceId ||
    (proof &&
      (!storedAuthorization.success ||
        !sameSessionOperation(storedAuthorization.data, authorization)))
  )
    return undefined;
  return messages.map(item => {
    if (item.messageId !== message.messageId) return item;
    const cleared = withoutFields(item.state, ['unresolvedDispatch', 'deliveryRetryScope']);
    // A dispatched queued message is ambiguous until its outcome settles: keep
    // the legacy marker so `releaseUnadmittedWaitingMessages` cannot release work
    // that may already have executed.
    const state =
      cleared.kind === 'queued' && dispatched
        ? { ...cleared, unresolvedDispatch: true as const }
        : cleared;
    return {
      ...item,
      state,
      proofs: {
        ...item.proofs,
        [kind]: {
          authorization: structuredClone(authorization),
          dispatched,
          ...(kind === 'prompt' && dispatched
            ? {
                executionDeadlineAt:
                  proof?.executionDeadlineAt ??
                  authorization.dispatchDeadlineAt + SANDBOX_CONTROL_EXECUTION_TIMEOUT_MS,
                executionDeadlineSource: proof?.executionDeadlineSource ?? 'dispatch',
              }
            : {}),
        },
      },
    };
  });
}

export function markSessionOperationRejection(
  messages: readonly SessionMessage[],
  authorization: SessionOperationAuthorization
): SessionMessage[] | undefined {
  if (authorization.operation !== 'session.attach') return [...messages];
  const message = messages.find(item => item.messageId === authorization.messageId);
  const proof = message?.proofs?.attach;
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
          proofs: { ...item.proofs, attach: { ...proof, rejectionReceived: true } },
        }
      : item
  );
}

export function recordSessionOperationExecutionDeadline(
  messages: readonly SessionMessage[],
  authorization: SessionOperationAuthorization,
  executionDeadlineAt: number
): SessionMessage[] | undefined {
  const message = messages.find(item => item.messageId === authorization.messageId);
  const prompt = message?.proofs?.prompt;
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
          proofs: {
            ...item.proofs,
            prompt: { ...prompt, executionDeadlineAt, executionDeadlineSource: 'wrapper' },
          },
        }
      : item
  );
}

export function completeSessionOperationAttachment(
  messages: readonly SessionMessage[],
  authorization: SessionOperationAuthorization
): SessionMessage[] | undefined {
  const message = messages.find(item => item.messageId === authorization.messageId);
  const proof = message?.proofs?.attach;
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
  const attachmentEpoch = proof.attachmentEpoch ?? nextAttachmentEpoch(messages);
  return messages.map(item =>
    item.messageId === message.messageId
      ? {
          ...withProofs(item, {
            ...item.proofs,
            attach: { ...proof, completedAt: proof.completedAt ?? Date.now(), attachmentEpoch },
          }),
          state: withoutFields(item.state, ['unresolvedDispatch']) as QueuedMessageState,
        }
      : item
  );
}
