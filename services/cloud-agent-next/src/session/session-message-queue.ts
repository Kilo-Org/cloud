import { TRPCError } from '@trpc/server';
import type {
  ExecutionDeliveryContext,
  AdmitAcceptedSessionMessageRequest,
  MessageDeliveryRequest,
  MessageDeliveryResult,
  SessionMessageAdmissionResult,
  SessionMessageIntent,
  SubmittedSessionMessageRequest,
} from '../execution/types.js';
import { renderExecutionTurnContent } from '../execution/types.js';
import { isExecutionError } from '../execution/errors.js';
import { logger } from '../logger.js';
import { dispatchedKilocodeModelId } from '../persistence/model-utils.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { isSandboxWorkspaceProbeTimeoutError } from '../sandbox-recovery.js';
import {
  MESSAGE_ID_FORMAT_DESCRIPTION,
  createMessageId,
  isCanonicalMessageId,
} from './message-id.js';
import {
  createPendingSessionMessageFromIntent,
  listPendingSessionMessages,
  findPendingSessionMessageByMessageId,
  deletePendingSessionMessageByMessageId,
  checkPendingSessionMessageCapacity,
  recordPendingFlushFailure,
  resolvePendingSessionMessageIntent,
  shouldSkipPendingFlush,
  storePendingSessionMessage,
  type PendingFlushFailureResult,
  type PendingFlushPolicy,
  type PendingSessionExecutionDefaults,
  type PendingSessionMessage,
  type SessionQueueStorage,
} from './pending-messages.js';
import {
  createQueuedSessionMessageState,
  getSessionMessageState,
  listReconnectVisibleTerminalQueuedMessages,
  putSessionMessageState,
  type SessionMessageStorage,
  type TerminalizeParams,
} from './session-message-state.js';
import type { QueuedMessageSnapshot } from '../websocket/stream.js';

export const PENDING_FLUSH_DEBOUNCE_MS = 1_000;

export type SessionMessageQueueStorage = SessionQueueStorage & SessionMessageStorage;

const INTERRUPT_PENDING_BATCH_KEY = 'session_message_interrupt_pending_batch';

type PendingInterruptBatch = {
  messageIds: string[];
  createdAt: number;
};

export type PendingFlushFailure = {
  type: 'failure';
  message: PendingSessionMessage;
  attempts: number;
  exhausted: boolean;
  nextFlushAttemptAt?: number;
  remainingCount: number;
};

export type PendingFlushSkipped = {
  type: 'skipped';
  nextFlushAttemptAt?: number;
  remainingCount: number;
};

export type PendingFlushDelivered = {
  type: 'delivered';
  remainingCount: number;
};

export type PendingFlushResult = PendingFlushFailure | PendingFlushSkipped | PendingFlushDelivered;

type PersistedQueuedMessageEvent = {
  sessionId: string;
  streamEventType: string;
  payload: string;
  timestamp: number;
};

type QueueTerminalizationOptions = {
  allowIdleBatchWithoutObservedIdle?: boolean;
};

export type PendingMessageDrainResult = {
  retryAt?: number;
  remainingPendingCount: number;
};

export type SessionMessageQueue = {
  hasMessageAdmission(messageId: string): Promise<boolean>;
  admitSubmittedMessage(
    request: SubmittedSessionMessageRequest
  ): Promise<SessionMessageAdmissionResult>;
  admitAcceptedMessage(
    request: AdmitAcceptedSessionMessageRequest
  ): Promise<SessionMessageAdmissionResult>;
  drainNextPendingMessage(): Promise<PendingMessageDrainResult>;
  snapshotForStreamConnect(): Promise<QueuedMessageSnapshot[]>;
  interruptPendingQueuedMessages(
    afterTransition?: (messages: PendingSessionMessage[]) => Promise<void>
  ): Promise<PendingSessionMessage[]>;
  recoverPendingInterruption(
    afterTransition?: (messages: PendingSessionMessage[]) => Promise<void>
  ): Promise<boolean>;
  requestPendingDrain(): Promise<void>;
  requestPendingDrainIfNeeded(): Promise<boolean>;
};

export type SessionMessageQueueDependencies = {
  storage: SessionMessageQueueStorage;
  getMetadata: () => Promise<SessionMetadata | null>;
  requireSessionId: () => Promise<string>;
  validateModeAgainstRuntimeAgents: (metadata: SessionMetadata, mode: string) => string | null;
  getDeliveryContext: () => Promise<ExecutionDeliveryContext | null>;
  deliver: (plan: MessageDeliveryRequest) => Promise<MessageDeliveryResult>;
  ensureQueuedMessageEvent: (event: PersistedQueuedMessageEvent & { entityId: string }) => void;
  ensureAcceptedMessageEffects: (messageId: string) => Promise<void>;
  persistTerminalTransition: (
    messageId: string,
    params: TerminalizeParams,
    options?: QueueTerminalizationOptions
  ) => Promise<{
    changed: boolean;
    state: { status: 'queued' | 'accepted' | 'completed' | 'failed' | 'interrupted' } | null;
  }>;
  repairTerminalMessageEffects: (messageId: string) => Promise<void>;
  finalizeTerminalCallbackEffects: (options?: {
    allowWithoutObservedIdle?: boolean;
  }) => Promise<void>;
  requestAlarmAtOrBefore: (deadline: number) => Promise<void>;
  getSessionIdForLogs: () => string | undefined;
};

/**
 * Build a PendingFlushFailure result from a recorded failure, adjusting the
 * remaining count based on whether the message was evicted (exhausted) or
 * kept in the queue for retry.
 */
function toFailureResult(
  failure: PendingFlushFailureResult,
  totalCount: number
): PendingFlushFailure {
  return {
    type: 'failure',
    ...failure,
    remainingCount: totalCount,
  };
}

function getPendingFlushPolicy(
  totalCount: number,
  context: ExecutionDeliveryContext | null
): PendingFlushPolicy {
  const workspace = context?.metadata.workspace;
  const hasWorkspaceFields = Boolean(
    workspace?.workspacePath && workspace.sandboxId && workspace.sessionHome && workspace.branchName
  );

  // Workspace readiness is the cold-vs-warm signal. If rapid admission puts
  // several messages in the queue before the first drain, all of that first
  // bootstrap attempt still needs the longer cold-init retry budget.
  return !hasWorkspaceFields && totalCount >= 1 ? 'cold-init' : 'warm-followup';
}

function buildMessageDeliveryRequest(
  intent: SessionMessageIntent,
  context: ExecutionDeliveryContext,
  validateModeAgainstRuntimeAgents: SessionMessageQueueDependencies['validateModeAgainstRuntimeAgents']
): MessageDeliveryRequest {
  const modeInput = intent.agent.mode;
  const modeCheck = validateModeAgainstRuntimeAgents(context.metadata, modeInput);
  if (modeCheck) {
    throw new MessageDeliveryRequestValidationError(modeCheck);
  }

  const model = dispatchedKilocodeModelId(intent.agent.model);
  if (!model) {
    throw new Error('Session is missing a valid model');
  }

  return {
    scope: {
      sessionId: context.sessionId,
      userId: context.userId,
      orgId: context.orgId,
    },
    turn: intent.turn,
    agent: {
      ...intent.agent,
      mode: modeInput,
      model,
    },
    finalization: intent.finalization,
    workspace: {
      sandboxId: context.sandboxId,
      metadata: context.metadata,
    },
    wrapper: {
      kiloSessionId: context.kiloSessionId,
    },
  } satisfies MessageDeliveryRequest;
}

class MessageDeliveryRequestValidationError extends Error {
  readonly code = 'BAD_REQUEST' as const;

  constructor(message: string) {
    super(message);
    this.name = 'MessageDeliveryRequestValidationError';
  }
}

export async function flushNextPendingSessionMessage(params: {
  storage: SessionMessageQueueStorage;
  now: number;
  getDeliveryContext: () => Promise<ExecutionDeliveryContext | null>;
  validateModeAgainstRuntimeAgents: SessionMessageQueueDependencies['validateModeAgainstRuntimeAgents'];
  deliver: (plan: MessageDeliveryRequest) => Promise<MessageDeliveryResult>;
  repairQueuedMessageEffects?: (intent: SessionMessageIntent) => Promise<void>;
  ensureAcceptedMessageEffects?: (messageId: string) => Promise<void>;
}): Promise<PendingFlushResult> {
  const context = await params.getDeliveryContext();
  const messages = await listPendingSessionMessages(
    params.storage,
    context
      ? {
          mode: context.metadata.agent?.mode,
          model: context.metadata.agent?.model,
          variant: context.metadata.agent?.variant,
          autoCommit: context.metadata.finalization?.autoCommit,
          condenseOnComplete: context.metadata.finalization?.condenseOnComplete,
        }
      : undefined
  );
  const [message] = messages;
  const totalCount = messages.length;

  if (!message) {
    return { type: 'skipped', remainingCount: 0 };
  }

  const existingState = await getSessionMessageState(params.storage, message.messageId);
  if (existingState?.status === 'accepted') {
    await params.ensureAcceptedMessageEffects?.(message.messageId);
    await deletePendingSessionMessageByMessageId(params.storage, message.messageId);
    return { type: 'delivered', remainingCount: Math.max(0, totalCount - 1) };
  }
  if (
    existingState?.status === 'completed' ||
    existingState?.status === 'failed' ||
    existingState?.status === 'interrupted'
  ) {
    await deletePendingSessionMessageByMessageId(params.storage, message.messageId);
    return { type: 'delivered', remainingCount: Math.max(0, totalCount - 1) };
  }

  if (shouldSkipPendingFlush(message, params.now)) {
    return {
      type: 'skipped',
      nextFlushAttemptAt: message.nextFlushAttemptAt,
      remainingCount: totalCount,
    };
  }

  if (message.deliveryDisposition === 'terminalization-pending') {
    return {
      type: 'failure',
      message,
      attempts: message.flushAttempts ?? 0,
      exhausted: true,
      remainingCount: totalCount,
    };
  }

  const policy = getPendingFlushPolicy(totalCount, context);
  if (!context) {
    const failure = await recordPendingFlushFailure(
      params.storage,
      message,
      'Session metadata is not available',
      params.now,
      { policy, code: 'NOT_FOUND' }
    );
    return toFailureResult(failure, totalCount);
  }

  const intent = resolvePendingSessionMessageIntent(message, {
    mode: context.metadata.agent?.mode,
    model: context.metadata.agent?.model,
    variant: context.metadata.agent?.variant,
    autoCommit: context.metadata.finalization?.autoCommit,
    condenseOnComplete: context.metadata.finalization?.condenseOnComplete,
  } satisfies PendingSessionExecutionDefaults);

  if (!intent) {
    const failure = await recordPendingFlushFailure(
      params.storage,
      message,
      'Session is missing a valid model',
      params.now,
      { policy, code: 'BAD_REQUEST' }
    );
    return toFailureResult(failure, totalCount);
  }

  if (!existingState) {
    const callbackSnapshot =
      message.callbackSnapshot ??
      (context.metadata.callback?.target
        ? { required: true, target: context.metadata.callback.target }
        : undefined);
    await putSessionMessageState(
      params.storage,
      createQueuedSessionMessageState(intent, callbackSnapshot, message.createdAt)
    );
  }
  await params.repairQueuedMessageEffects?.(intent);

  try {
    const plan = buildMessageDeliveryRequest(
      intent,
      context,
      params.validateModeAgainstRuntimeAgents
    );
    const startResult = await params.deliver(plan);
    if (!startResult.success) {
      const failure = await recordPendingFlushFailure(
        params.storage,
        message,
        startResult.error,
        params.now,
        { policy, code: startResult.code }
      );
      throw new PendingFlushRecordedError(failure);
    }
    await deletePendingSessionMessageByMessageId(params.storage, message.messageId);
    return { type: 'delivered', remainingCount: totalCount - 1 };
  } catch (error) {
    if (error instanceof PendingFlushRecordedError) {
      return toFailureResult(error.failure, totalCount);
    }
    const code =
      error instanceof MessageDeliveryRequestValidationError
        ? error.code
        : isSandboxWorkspaceProbeTimeoutError(error)
          ? 'INTERNAL'
          : undefined;
    const failure = await recordPendingFlushFailure(
      params.storage,
      message,
      error instanceof Error ? error.message : String(error),
      params.now,
      code === undefined ? { policy } : { policy, code }
    );
    return toFailureResult(failure, totalCount);
  }
}

class PendingFlushRecordedError extends Error {
  constructor(readonly failure: PendingFlushFailureResult) {
    super(failure.message.lastFlushError ?? 'Pending flush failure recorded');
    this.name = 'PendingFlushRecordedError';
  }
}

function buildAdmissionAck(
  messageId: string,
  compatibilityDelivery: 'queued' | 'sent' = 'queued'
): SessionMessageAdmissionResult {
  return {
    success: true,
    outcome: 'queued',
    compatibilityDelivery,
    messageId,
  };
}

function mapTRPCCodeToResultCode(
  trpcCode: string
): Extract<SessionMessageAdmissionResult, { success: false }>['code'] {
  switch (trpcCode) {
    case 'BAD_REQUEST':
      return 'BAD_REQUEST';
    case 'NOT_FOUND':
      return 'NOT_FOUND';
    default:
      return 'INTERNAL';
  }
}

export function createSessionMessageQueue(
  dependencies: SessionMessageQueueDependencies
): SessionMessageQueue {
  const {
    storage,
    getMetadata,
    requireSessionId,
    validateModeAgainstRuntimeAgents,
    getDeliveryContext,
    deliver,
    ensureQueuedMessageEvent,
    ensureAcceptedMessageEffects,
    persistTerminalTransition,
    repairTerminalMessageEffects,
    finalizeTerminalCallbackEffects,
    requestAlarmAtOrBefore,
    getSessionIdForLogs,
  } = dependencies;

  function buildAdmissionError(
    code: Extract<SessionMessageAdmissionResult, { success: false }>['code'],
    error: string
  ): SessionMessageAdmissionResult {
    logger
      .withFields({ sessionId: getSessionIdForLogs(), code })
      .warn('Building failed session message admission result');
    return {
      success: false,
      code,
      error,
    };
  }

  async function checkPendingQueueCapacity(): Promise<SessionMessageAdmissionResult | undefined> {
    const capacity = await checkPendingSessionMessageCapacity(storage);
    if (capacity.available) return undefined;

    logger
      .withFields({ sessionId: getSessionIdForLogs() })
      .warn('Pending session message queue is full');
    return buildAdmissionError(
      'PENDING_QUEUE_FULL',
      capacity.message ?? 'Pending message queue is full'
    );
  }

  async function requestPendingDrain(): Promise<void> {
    await requestAlarmAtOrBefore(Date.now() + PENDING_FLUSH_DEBOUNCE_MS);
  }

  async function requestPendingDrainIfNeeded(): Promise<boolean> {
    const pendingCount = (await listPendingSessionMessages(storage)).length;
    if (pendingCount === 0) return false;
    await requestPendingDrain();
    return true;
  }

  async function completeQueuedAdmissionEffects(intent: SessionMessageIntent): Promise<void> {
    const sessionId = await requireSessionId();
    ensureQueuedMessageEvent({
      entityId: `queued-message/${intent.turn.messageId}`,
      sessionId,
      streamEventType: 'cloud.message.queued',
      payload: JSON.stringify({
        messageId: intent.turn.messageId,
        content: renderExecutionTurnContent(intent.turn),
        delivery: 'queued',
      }),
      timestamp: Date.now(),
    });
    await requestPendingDrain();
    logger
      .withFields({ sessionId, messageId: intent.turn.messageId })
      .info('Queued message event persisted and pending flush scheduled');
  }

  async function hasMessageAdmission(messageId: string): Promise<boolean> {
    const pendingMessage = await getQueuedMessageByMessageId(storage, messageId);
    if (pendingMessage) return true;
    return (await getSessionMessageState(storage, messageId)) !== undefined;
  }

  async function getExistingAdmissionAckForMessageId(
    messageId: string,
    requestedIntent?: SessionMessageIntent
  ): Promise<SessionMessageAdmissionResult | undefined> {
    const pendingMessage = await getQueuedMessageByMessageId(storage, messageId);
    const metadata = pendingMessage ? await getMetadata() : undefined;
    const persistedIntent = pendingMessage
      ? resolvePendingSessionMessageIntent(pendingMessage, {
          mode: metadata?.agent?.mode,
          model: metadata?.agent?.model,
          variant: metadata?.agent?.variant,
          autoCommit: metadata?.finalization?.autoCommit,
          condenseOnComplete: metadata?.finalization?.condenseOnComplete,
        } satisfies PendingSessionExecutionDefaults)
      : undefined;
    const messageState = await getSessionMessageState(storage, messageId);
    if (
      messageState?.status === 'completed' ||
      messageState?.status === 'failed' ||
      messageState?.status === 'interrupted'
    ) {
      return buildAdmissionError(
        'BAD_REQUEST',
        'Message ID is already terminal; submit a new message ID'
      );
    }
    if (
      requestedIntent &&
      messageState &&
      !matchesAdmissionConstraints(requestedIntent, messageState)
    ) {
      return buildAdmissionError('BAD_REQUEST', 'Message intent does not match admitted message');
    }
    if (
      requestedIntent &&
      !messageState &&
      persistedIntent &&
      !sameMessageIntent(requestedIntent, persistedIntent)
    ) {
      return buildAdmissionError('BAD_REQUEST', 'Message intent does not match admitted message');
    }

    if (messageState) {
      if (messageState.status === 'queued') {
        const repairIntent = persistedIntent ?? requestedIntent;
        if (repairIntent) await completeQueuedAdmissionEffects(repairIntent);
        return buildAdmissionAck(messageId);
      }
      if (messageState.status === 'accepted') {
        return buildAdmissionAck(messageId, 'sent');
      }
    }

    if (pendingMessage) {
      await repairMissingQueuedStateFromPendingMessage(pendingMessage);
      const repairIntent = persistedIntent ?? requestedIntent;
      if (repairIntent) await completeQueuedAdmissionEffects(repairIntent);
      return buildAdmissionAck(pendingMessage.messageId);
    }

    return undefined;
  }

  function sameMessageIntent(left: SessionMessageIntent, right: SessionMessageIntent): boolean {
    return (
      JSON.stringify(left.turn) === JSON.stringify(right.turn) &&
      left.agent.mode === right.agent.mode &&
      left.agent.model === right.agent.model &&
      left.agent.variant === right.agent.variant &&
      left.finalization?.autoCommit === right.finalization?.autoCommit &&
      left.finalization?.condenseOnComplete === right.finalization?.condenseOnComplete
    );
  }

  function matchesAdmissionConstraints(
    requested: SessionMessageIntent,
    state: NonNullable<Awaited<ReturnType<typeof getSessionMessageState>>>
  ): boolean {
    if (state.admissionSnapshot) return sameMessageIntent(requested, state.admissionSnapshot);
    const legacy = state.legacyAdmissionConstraints;
    if (!legacy) return true;
    return (
      (legacy.turn === undefined ||
        JSON.stringify(requested.turn) === JSON.stringify(legacy.turn)) &&
      (legacy.agent === undefined ||
        ((legacy.agent.mode === undefined || requested.agent.mode === legacy.agent.mode) &&
          (legacy.agent.model === undefined || requested.agent.model === legacy.agent.model) &&
          (legacy.agent.variant === undefined ||
            requested.agent.variant === legacy.agent.variant))) &&
      (legacy.finalization === undefined ||
        (requested.finalization?.autoCommit === legacy.finalization.autoCommit &&
          requested.finalization?.condenseOnComplete === legacy.finalization.condenseOnComplete))
    );
  }

  async function repairMissingQueuedStateFromPendingMessage(
    message: PendingSessionMessage
  ): Promise<void> {
    const metadata = await getMetadata();
    const intent = resolvePendingSessionMessageIntent(message, {
      mode: metadata?.agent?.mode,
      model: metadata?.agent?.model,
      variant: metadata?.agent?.variant,
      autoCommit: metadata?.finalization?.autoCommit,
      condenseOnComplete: metadata?.finalization?.condenseOnComplete,
    } satisfies PendingSessionExecutionDefaults);

    if (!intent) {
      logger
        .withFields({ sessionId: getSessionIdForLogs(), messageId: message.messageId })
        .warn('Pending queued message is missing enough state to repair message state');
      return;
    }

    const callbackSnapshot =
      message.callbackSnapshot ??
      (metadata?.callback?.target
        ? { required: true, target: metadata.callback.target }
        : undefined);
    await putSessionMessageState(
      storage,
      createQueuedSessionMessageState(intent, callbackSnapshot, message.createdAt)
    );
  }

  async function admitIntent(intent: SessionMessageIntent): Promise<SessionMessageAdmissionResult> {
    const { turn } = intent;
    const idempotentResult = await getExistingAdmissionAckForMessageId(turn.messageId, intent);
    if (idempotentResult) return idempotentResult;

    const capacityError = await checkPendingQueueCapacity();
    if (capacityError) return capacityError;

    const metadata = await getMetadata();
    const callbackTarget = metadata?.callback?.target;
    const callbackSnapshot = callbackTarget
      ? { required: true, target: callbackTarget }
      : undefined;

    await enqueuePendingSessionMessageIntent(storage, intent, Date.now(), callbackSnapshot);
    const messageState = createQueuedSessionMessageState(intent, callbackSnapshot);
    await putSessionMessageState(storage, messageState);
    await completeQueuedAdmissionEffects(intent);
    return buildAdmissionAck(turn.messageId);
  }

  async function admitAcceptedMessage(
    request: AdmitAcceptedSessionMessageRequest
  ): Promise<SessionMessageAdmissionResult> {
    await requireSessionId();
    if (!isCanonicalMessageId(request.turn.messageId)) {
      return buildAdmissionError('BAD_REQUEST', MESSAGE_ID_FORMAT_DESCRIPTION);
    }

    const metadata = await getMetadata();
    if (!metadata) {
      return buildAdmissionError('NOT_FOUND', 'Session not found');
    }

    const modeCheck = validateModeAgainstRuntimeAgents(metadata, request.agent.mode);
    if (modeCheck) {
      return buildAdmissionError('BAD_REQUEST', modeCheck);
    }
    const model = dispatchedKilocodeModelId(request.agent.model);
    if (!model) {
      return buildAdmissionError(
        'BAD_REQUEST',
        'No model specified and session has no default model'
      );
    }

    return admitIntent({
      turn: request.turn,
      agent: {
        ...request.agent,
        model,
      },
      finalization: request.finalization,
    });
  }

  async function admitSubmittedMessage(
    request: SubmittedSessionMessageRequest
  ): Promise<SessionMessageAdmissionResult> {
    await requireSessionId();
    const requestedMessageId = request.turn.id;
    if (
      requestedMessageId !== undefined &&
      requestedMessageId !== null &&
      !isCanonicalMessageId(requestedMessageId)
    ) {
      return buildAdmissionError('BAD_REQUEST', MESSAGE_ID_FORMAT_DESCRIPTION);
    }

    try {
      const metadata = await getMetadata();
      if (!metadata) {
        return buildAdmissionError('NOT_FOUND', 'Session not found');
      }

      const explicitTurn = request.turn;
      const messageId = requestedMessageId ?? createMessageId();
      if (!isCanonicalMessageId(messageId)) {
        return buildAdmissionError('BAD_REQUEST', MESSAGE_ID_FORMAT_DESCRIPTION);
      }

      if (explicitTurn.type === 'prompt' && !explicitTurn.prompt) {
        return buildAdmissionError('BAD_REQUEST', 'No prompt provided');
      }
      if (explicitTurn.type === 'command' && explicitTurn.attachments !== undefined) {
        return buildAdmissionError(
          'BAD_REQUEST',
          'Attachments cannot be attached to slash commands'
        );
      }

      const requestedAgent = request.agent;
      const requestedFinalization = request.finalization;
      const modeInput = requestedAgent?.mode ?? metadata.agent?.mode ?? 'code';
      const modeCheck = validateModeAgainstRuntimeAgents(metadata, modeInput);
      if (modeCheck) {
        return buildAdmissionError('BAD_REQUEST', modeCheck);
      }
      const model = dispatchedKilocodeModelId(requestedAgent?.model ?? metadata.agent?.model);
      const variant = requestedAgent?.variant ?? metadata.agent?.variant;
      if (!model) {
        return buildAdmissionError(
          'BAD_REQUEST',
          'No model specified and session has no default model'
        );
      }

      const intent: SessionMessageIntent = {
        turn:
          explicitTurn.type === 'prompt'
            ? {
                type: 'prompt',
                messageId,
                prompt: explicitTurn.prompt,
                attachments: explicitTurn.attachments,
              }
            : {
                type: 'command',
                messageId,
                command: explicitTurn.command,
                arguments: explicitTurn.arguments,
              },
        agent: {
          mode: modeInput,
          model,
          variant,
        },
        finalization: {
          autoCommit: requestedFinalization?.autoCommit ?? metadata.finalization?.autoCommit,
          condenseOnComplete:
            requestedFinalization?.condenseOnComplete ?? metadata.finalization?.condenseOnComplete,
        },
      };
      const existingAdmission = await getExistingAdmissionAckForMessageId(messageId, intent);
      if (existingAdmission) return existingAdmission;
      const capacityError = await checkPendingQueueCapacity();
      if (capacityError) return capacityError;
      return await admitIntent(intent);
    } catch (error) {
      if (isExecutionError(error)) {
        if (error.retryable) {
          return buildAdmissionError(
            error.code as Extract<SessionMessageAdmissionResult, { success: false }>['code'],
            error.message
          );
        }
        return buildAdmissionError('INTERNAL', error.message);
      }
      if (error instanceof TRPCError) {
        return buildAdmissionError(mapTRPCCodeToResultCode(error.code), error.message);
      }
      return buildAdmissionError(
        'INTERNAL',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async function drainNextPendingMessage(): Promise<PendingMessageDrainResult> {
    const now = Date.now();
    const flushResult = await flushNextPendingSessionMessage({
      storage,
      now,
      getDeliveryContext,
      validateModeAgainstRuntimeAgents,
      deliver,
      repairQueuedMessageEffects: completeQueuedAdmissionEffects,
      ensureAcceptedMessageEffects,
    });

    if (flushResult.type === 'skipped') {
      if (flushResult.nextFlushAttemptAt !== undefined) {
        return {
          retryAt: flushResult.nextFlushAttemptAt,
          remainingPendingCount: flushResult.remainingCount,
        };
      }

      return {
        retryAt: undefined,
        remainingPendingCount: flushResult.remainingCount,
      };
    }

    if (flushResult.type === 'delivered') {
      logger
        .withFields({
          sessionId: getSessionIdForLogs(),
          remainingPendingCount: flushResult.remainingCount,
        })
        .info('Pending session message delivered to wrapper path');
      return { remainingPendingCount: flushResult.remainingCount };
    }

    const metadata = await getMetadata();
    logger
      .withFields({
        sessionId: metadata?.identity.sessionId,
        messageId: flushResult.message.messageId,
        error: flushResult.message.lastFlushError,
        attempts: flushResult.attempts,
        exhausted: flushResult.exhausted,
        nextFlushAttemptAt: flushResult.nextFlushAttemptAt,
      })
      .warn('Failed to flush pending session message');
    if (flushResult.exhausted) {
      await persistTerminalTransition(
        flushResult.message.messageId,
        {
          kind: 'failed',
          reason: 'exhausted',
          error: flushResult.message.lastFlushError ?? 'Pending message delivery failed',
          completionSource: 'delivery_failure',
          attempts: flushResult.attempts,
        },
        { allowIdleBatchWithoutObservedIdle: true }
      );
      try {
        await deletePendingSessionMessageByMessageId(storage, flushResult.message.messageId);
      } catch (error) {
        logger
          .withFields({
            sessionId: getSessionIdForLogs(),
            messageId: flushResult.message.messageId,
            error: error instanceof Error ? error.message : String(error),
          })
          .warn('Failed to remove terminal pending message; later drain will quarantine it');
      }
      try {
        await repairTerminalMessageEffects(flushResult.message.messageId);
        await finalizeTerminalCallbackEffects({ allowWithoutObservedIdle: true });
      } catch (error) {
        logger
          .withFields({
            sessionId: getSessionIdForLogs(),
            messageId: flushResult.message.messageId,
            error: error instanceof Error ? error.message : String(error),
          })
          .warn('Terminal delivery-failure effects remain pending for alarm repair');
        await requestAlarmAtOrBefore(Date.now() + 1_000);
      }
      return {
        retryAt: undefined,
        remainingPendingCount: Math.max(0, flushResult.remainingCount - 1),
      };
    }
    return {
      retryAt: flushResult.nextFlushAttemptAt,
      remainingPendingCount: flushResult.remainingCount,
    };
  }

  async function snapshotForStreamConnect(): Promise<QueuedMessageSnapshot[]> {
    const pending = await listPendingSessionMessages(storage);
    const pendingMessageIds = new Set(pending.map(message => message.messageId));
    const terminalQueued = await listReconnectVisibleTerminalQueuedMessages(storage);

    return [
      ...pending.map(message => ({
        messageId: message.messageId,
        content: message.content,
        timestamp: message.createdAt,
      })),
      ...terminalQueued
        .filter(state => !pendingMessageIds.has(state.messageId))
        .map(state => ({
          messageId: state.messageId,
          content: state.prompt,
          timestamp: state.queuedAt ?? state.createdAt,
          terminalFailure: {
            status: state.status,
            completionSource: state.completionSource,
            reason: state.failureReason,
            error: state.error,
            attempts: state.attempts,
            timestamp: state.terminalAt ?? state.createdAt,
          },
        })),
    ].sort((left, right) => left.timestamp - right.timestamp);
  }

  async function persistPendingInterruptBatch(messages: PendingSessionMessage[]): Promise<void> {
    const existing = await storage.get<PendingInterruptBatch>(INTERRUPT_PENDING_BATCH_KEY);
    if (existing) return;
    await storage.put(INTERRUPT_PENDING_BATCH_KEY, {
      messageIds: messages.map(message => message.messageId),
      createdAt: Date.now(),
    } satisfies PendingInterruptBatch);
    await requestAlarmAtOrBefore(Date.now() + PENDING_FLUSH_DEBOUNCE_MS);
  }

  async function settlePendingInterruptBatch(
    capturedMessages: PendingSessionMessage[],
    afterTransition?: (messages: PendingSessionMessage[]) => Promise<void>
  ): Promise<void> {
    for (const message of capturedMessages) {
      const existing = await getSessionMessageState(storage, message.messageId);
      if (!existing) {
        await repairMissingQueuedStateFromPendingMessage(message);
      }
      const durableTransition = await persistTerminalTransition(
        message.messageId,
        {
          kind: 'interrupted',
          error: 'Pending queued message interrupted by user',
          completionSource: 'interrupt',
        },
        { allowIdleBatchWithoutObservedIdle: true }
      );
      if (!durableTransition.state || durableTransition.state.status !== 'interrupted') {
        throw new Error(
          `Failed to persist interrupted transition for message ${message.messageId}`
        );
      }
      try {
        await repairTerminalMessageEffects(message.messageId);
      } catch (error) {
        logger
          .withFields({
            sessionId: getSessionIdForLogs(),
            messageId: message.messageId,
            error: error instanceof Error ? error.message : String(error),
          })
          .warn('Interrupted message effects incomplete; alarm repair will continue recovery');
        await requestAlarmAtOrBefore(Date.now() + 1_000);
      }
    }
    if (afterTransition) {
      await afterTransition(capturedMessages);
    }
    for (const message of capturedMessages) {
      await deletePendingSessionMessageByMessageId(storage, message.messageId);
    }
    await storage.delete(INTERRUPT_PENDING_BATCH_KEY);
  }

  async function recoverPendingInterruption(
    afterTransition?: (messages: PendingSessionMessage[]) => Promise<void>
  ): Promise<boolean> {
    const marker = await storage.get<PendingInterruptBatch>(INTERRUPT_PENDING_BATCH_KEY);
    if (!marker) return false;
    const pending = await listPendingSessionMessages(storage);
    const captured = marker.messageIds.flatMap(messageId => {
      const message = pending.find(candidate => candidate.messageId === messageId);
      return message ? [message] : [];
    });
    await settlePendingInterruptBatch(captured, afterTransition);
    return true;
  }

  async function interruptPendingQueuedMessages(
    afterTransition?: (messages: PendingSessionMessage[]) => Promise<void>
  ): Promise<PendingSessionMessage[]> {
    const capturedMessages = await listPendingSessionMessages(storage);
    await persistPendingInterruptBatch(capturedMessages);
    await settlePendingInterruptBatch(capturedMessages, afterTransition);
    return capturedMessages;
  }

  return {
    hasMessageAdmission,
    admitSubmittedMessage,
    admitAcceptedMessage,
    drainNextPendingMessage,
    snapshotForStreamConnect,
    interruptPendingQueuedMessages,
    recoverPendingInterruption,
    requestPendingDrain,
    requestPendingDrainIfNeeded,
  };
}

export async function enqueuePendingSessionMessageIntent(
  storage: SessionQueueStorage,
  intent: SessionMessageIntent,
  createdAt = Date.now(),
  callbackSnapshot?: PendingSessionMessage['callbackSnapshot']
): Promise<PendingSessionMessage> {
  const message = createPendingSessionMessageFromIntent(intent, createdAt, callbackSnapshot);
  await storePendingSessionMessage(storage, message);
  return message;
}

export async function getQueuedMessageByMessageId(
  storage: SessionQueueStorage,
  messageId: string
): Promise<PendingSessionMessage | undefined> {
  return findPendingSessionMessageByMessageId(storage, messageId);
}
