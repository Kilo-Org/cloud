import { TRPCError } from '@trpc/server';
import type {
  ExecutionDeliveryContext,
  MessageDeliveryPlan,
  QueueSessionMessageRequest,
  QueueSessionMessageResult,
  SessionMessageIntent,
  StartExecutionDelivery,
} from '../execution/types.js';
import { isExecutionError } from '../execution/errors.js';
import { logger } from '../logger.js';
import { normalizeKilocodeModel } from '../persistence/model-utils.js';
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
  clearPendingSessionMessages,
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
  listNeverAcceptedTerminalQueuedMessages,
  putSessionMessageState,
  type SessionMessageStorage,
  type TerminalizeParams,
} from './session-message-state.js';
import type { QueuedMessageSnapshot } from '../websocket/stream.js';

export const PENDING_FLUSH_DEBOUNCE_MS = 1_000;

export type SessionMessageQueueStorage = SessionQueueStorage & SessionMessageStorage;

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

export type DrainPolicy = 'hot-only' | 'ensure-wrapper';

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
  enqueue(request: QueueSessionMessageRequest): Promise<QueueSessionMessageResult>;
  drainNextPendingMessage(): Promise<PendingMessageDrainResult>;
  snapshotForStreamConnect(): Promise<QueuedMessageSnapshot[]>;
  interruptPendingQueuedMessages(
    afterClear?: (messages: PendingSessionMessage[]) => Promise<void>
  ): Promise<PendingSessionMessage[]>;
  requestPendingDrain(): Promise<void>;
  requestPendingDrainIfNeeded(): Promise<boolean>;
};

export type SessionMessageQueueDependencies = {
  storage: SessionMessageQueueStorage;
  getMetadata: () => Promise<SessionMetadata | null>;
  requireSessionId: () => Promise<string>;
  validateModeAgainstRuntimeAgents: (metadata: SessionMetadata, mode: string) => string | null;
  getDeliveryContext: () => Promise<ExecutionDeliveryContext | null>;
  hasCurrentRuntimeExecution: () => Promise<boolean>;
  hasActiveAcceptedWrapperMessages: () => Promise<boolean>;
  isLegacyAcceptedMessageRunning: (messageId: string) => Promise<boolean>;
  deliver: (plan: MessageDeliveryPlan) => Promise<QueueSessionMessageResult>;
  insertAndBroadcastMessageEvent: (event: PersistedQueuedMessageEvent) => void;
  terminalizeSessionMessageOnce: (
    messageId: string,
    params: TerminalizeParams,
    options?: QueueTerminalizationOptions
  ) => Promise<unknown>;
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
    remainingCount: failure.exhausted ? totalCount - 1 : totalCount,
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

function buildMessageDeliveryPlan(
  intent: SessionMessageIntent,
  context: ExecutionDeliveryContext,
  validateModeAgainstRuntimeAgents: SessionMessageQueueDependencies['validateModeAgainstRuntimeAgents']
): MessageDeliveryPlan {
  const modeInput = intent.agent.mode;
  const modeCheck = validateModeAgainstRuntimeAgents(context.metadata, modeInput);
  if (modeCheck) {
    throw new Error(modeCheck);
  }

  const model = normalizeKilocodeModel(intent.agent.model);
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
      model: model.replace(/^kilo\//, ''),
    },
    finalization: intent.finalization,
    workspace: {
      sandboxId: context.sandboxId,
      metadata: context.metadata,
      repositoryAuthOverrides: intent.repositoryAuthOverrides,
    },
    wrapper: {
      kiloSessionId: context.kiloSessionId,
    },
  } satisfies MessageDeliveryPlan;
}

export async function flushNextPendingSessionMessage(params: {
  storage: SessionMessageQueueStorage;
  now: number;
  drainPolicy: DrainPolicy;
  hasCurrentRuntimeExecution: () => Promise<boolean>;
  getDeliveryContext: () => Promise<ExecutionDeliveryContext | null>;
  validateModeAgainstRuntimeAgents: SessionMessageQueueDependencies['validateModeAgainstRuntimeAgents'];
  deliver: (plan: MessageDeliveryPlan) => Promise<QueueSessionMessageResult>;
}): Promise<PendingFlushResult> {
  const messages = await listPendingSessionMessages(params.storage);
  const [message] = messages;
  const totalCount = messages.length;

  if (!message) {
    return { type: 'skipped', remainingCount: 0 };
  }

  if (shouldSkipPendingFlush(message, params.now)) {
    return {
      type: 'skipped',
      nextFlushAttemptAt: message.nextFlushAttemptAt,
      remainingCount: totalCount,
    };
  }

  // ensure-wrapper drain cannot start another wrapper while execution work is
  // active. hot-only drain intentionally keeps feeding the connected wrapper.
  if (params.drainPolicy === 'ensure-wrapper' && (await params.hasCurrentRuntimeExecution())) {
    return { type: 'skipped', remainingCount: totalCount };
  }

  const context = await params.getDeliveryContext();
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

  try {
    const plan = buildMessageDeliveryPlan(intent, context, params.validateModeAgainstRuntimeAgents);
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
    const code = isSandboxWorkspaceProbeTimeoutError(error) ? 'INTERNAL' : undefined;
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

function buildStartResult(
  messageId: string,
  delivery: StartExecutionDelivery = 'sent',
  wrapperRunId?: string
): QueueSessionMessageResult {
  return {
    success: true,
    status: 'started',
    messageId,
    delivery,
    ...(wrapperRunId ? { wrapperRunId } : {}),
  };
}

function mapTRPCCodeToResultCode(
  trpcCode: string
): Extract<QueueSessionMessageResult, { success: false }>['code'] {
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
    hasCurrentRuntimeExecution,
    hasActiveAcceptedWrapperMessages,
    isLegacyAcceptedMessageRunning,
    deliver,
    insertAndBroadcastMessageEvent,
    terminalizeSessionMessageOnce,
    requestAlarmAtOrBefore,
    getSessionIdForLogs,
  } = dependencies;

  function buildStartError(
    code: Extract<QueueSessionMessageResult, { success: false }>['code'],
    error: string
  ): QueueSessionMessageResult {
    logger
      .withFields({ sessionId: getSessionIdForLogs(), code })
      .warn('Building failed queueSessionMessage result');
    return {
      success: false,
      code,
      error,
    };
  }

  async function checkPendingQueueCapacity(): Promise<QueueSessionMessageResult | undefined> {
    const capacity = await checkPendingSessionMessageCapacity(storage);
    if (capacity.available) return undefined;

    logger
      .withFields({ sessionId: getSessionIdForLogs() })
      .warn('Pending session message queue is full');
    return buildStartError(
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

  async function getExistingStartResultForMessageId(
    messageId: string
  ): Promise<QueueSessionMessageResult | undefined> {
    const messageState = await getSessionMessageState(storage, messageId);
    if (messageState) {
      if (messageState.status === 'queued') {
        return buildStartResult(messageId, 'queued');
      }
      if (messageState.status === 'accepted' || messageState.status === 'completed') {
        return buildStartResult(messageId, 'sent');
      }
      if (messageState.status === 'failed' || messageState.status === 'interrupted') {
        return undefined;
      }
    }

    const existingMessage = await getQueuedMessageByMessageId(storage, messageId);
    if (existingMessage) {
      return buildStartResult(existingMessage.messageId, 'queued');
    }

    if (await isLegacyAcceptedMessageRunning(messageId)) {
      return buildStartResult(messageId, 'sent');
    }

    return undefined;
  }

  async function admitIntent(intent: SessionMessageIntent): Promise<QueueSessionMessageResult> {
    const { turn } = intent;
    const idempotentResult = await getExistingStartResultForMessageId(turn.messageId);
    if (idempotentResult) return idempotentResult;

    const capacityError = await checkPendingQueueCapacity();
    if (capacityError) return capacityError;

    const metadata = await getMetadata();
    const callbackTarget = metadata?.callback?.target;
    const callbackSnapshot = callbackTarget
      ? { required: true, target: callbackTarget }
      : undefined;

    const messageState = createQueuedSessionMessageState(intent, callbackSnapshot);
    await putSessionMessageState(storage, messageState);
    await enqueuePendingSessionMessageIntent(storage, intent, Date.now());

    const sessionId = await requireSessionId();
    insertAndBroadcastMessageEvent({
      sessionId,
      streamEventType: 'cloud.message.queued',
      payload: JSON.stringify({
        messageId: turn.messageId,
        content: turn.prompt,
        delivery: 'queued',
      }),
      timestamp: Date.now(),
    });
    await requestPendingDrain();
    logger
      .withFields({ sessionId, messageId: turn.messageId })
      .info('Queued message event persisted and pending flush scheduled');
    return buildStartResult(turn.messageId, 'queued');
  }

  async function enqueue(request: QueueSessionMessageRequest): Promise<QueueSessionMessageResult> {
    await requireSessionId();
    const requestedMessageId = request.kind === 'user-message' ? request.message.id : undefined;
    if (
      requestedMessageId !== undefined &&
      requestedMessageId !== null &&
      !isCanonicalMessageId(requestedMessageId)
    ) {
      return buildStartError('BAD_REQUEST', MESSAGE_ID_FORMAT_DESCRIPTION);
    }

    try {
      const metadata = await getMetadata();
      if (!metadata) {
        return buildStartError('NOT_FOUND', 'Session not found');
      }

      const explicitMessage =
        request.kind === 'registered-initial' ? metadata.initialMessage : request.message;
      const messageId =
        request.kind === 'registered-initial'
          ? (metadata.initialMessage?.id ?? requestedMessageId ?? createMessageId())
          : (requestedMessageId ?? createMessageId());
      if (!isCanonicalMessageId(messageId)) {
        return buildStartError('BAD_REQUEST', MESSAGE_ID_FORMAT_DESCRIPTION);
      }

      const idempotentResult = await getExistingStartResultForMessageId(messageId);
      if (idempotentResult) return idempotentResult;

      const capacityError = await checkPendingQueueCapacity();
      if (capacityError) return capacityError;

      const prompt = explicitMessage?.prompt;
      if (!prompt) {
        return buildStartError('BAD_REQUEST', 'No prompt provided');
      }

      const requestedAgent = request.kind === 'user-message' ? request.agent : undefined;
      const requestedFinalization =
        request.kind === 'user-message' ? request.finalization : undefined;
      const modeInput = requestedAgent?.mode ?? metadata.agent?.mode ?? 'code';
      const modeCheck = validateModeAgainstRuntimeAgents(metadata, modeInput);
      if (modeCheck) {
        return buildStartError('BAD_REQUEST', modeCheck);
      }
      const model = normalizeKilocodeModel(requestedAgent?.model ?? metadata.agent?.model);
      const variant = requestedAgent?.variant ?? metadata.agent?.variant;
      if (!model) {
        return buildStartError(
          'BAD_REQUEST',
          'No model specified and session has no default model'
        );
      }

      const intent: SessionMessageIntent = {
        turn: {
          messageId,
          prompt,
          images: explicitMessage?.images,
        },
        agent: {
          mode: modeInput,
          model: model.replace(/^kilo\//, ''),
          variant,
        },
        finalization: {
          autoCommit: requestedFinalization?.autoCommit ?? metadata.finalization?.autoCommit,
          condenseOnComplete:
            requestedFinalization?.condenseOnComplete ?? metadata.finalization?.condenseOnComplete,
        },
        repositoryAuthOverrides:
          request.kind === 'user-message' ? request.tokenOverrides : undefined,
      };
      return admitIntent(intent);
    } catch (error) {
      if (isExecutionError(error)) {
        if (error.retryable) {
          return buildStartError(
            error.code as Extract<QueueSessionMessageResult, { success: false }>['code'],
            error.message
          );
        }
        return buildStartError('INTERNAL', error.message);
      }
      if (error instanceof TRPCError) {
        return buildStartError(mapTRPCCodeToResultCode(error.code), error.message);
      }
      return buildStartError('INTERNAL', error instanceof Error ? error.message : String(error));
    }
  }

  async function drainNextPendingMessage(): Promise<PendingMessageDrainResult> {
    const now = Date.now();
    const hasAcceptedWrapperMessages = await hasActiveAcceptedWrapperMessages();
    const flushResult = await flushNextPendingSessionMessage({
      storage,
      now,
      drainPolicy: hasAcceptedWrapperMessages ? 'hot-only' : 'ensure-wrapper',
      hasCurrentRuntimeExecution: async () =>
        (await hasCurrentRuntimeExecution()) || (await hasActiveAcceptedWrapperMessages()),
      getDeliveryContext,
      validateModeAgainstRuntimeAgents,
      deliver,
    });

    if (flushResult.type === 'skipped') {
      if (flushResult.nextFlushAttemptAt !== undefined) {
        return {
          retryAt: flushResult.nextFlushAttemptAt,
          remainingPendingCount: flushResult.remainingCount,
        };
      }

      const shouldRetrySkippedDrain =
        flushResult.remainingCount > 0 && (await hasCurrentRuntimeExecution());
      return {
        retryAt: shouldRetrySkippedDrain ? now + PENDING_FLUSH_DEBOUNCE_MS : undefined,
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
      await terminalizeSessionMessageOnce(
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
    }
    return {
      retryAt: flushResult.nextFlushAttemptAt,
      remainingPendingCount: flushResult.remainingCount,
    };
  }

  async function snapshotForStreamConnect(): Promise<QueuedMessageSnapshot[]> {
    const pending = await listPendingSessionMessages(storage);
    const pendingMessageIds = new Set(pending.map(message => message.messageId));
    const terminalQueued = await listNeverAcceptedTerminalQueuedMessages(storage);

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

  async function interruptPendingQueuedMessages(
    afterClear?: (messages: PendingSessionMessage[]) => Promise<void>
  ): Promise<PendingSessionMessage[]> {
    const clearedMessages = await clearPendingSessionMessages(storage);
    if (afterClear) {
      await afterClear(clearedMessages);
    }
    for (const message of clearedMessages) {
      await terminalizeSessionMessageOnce(message.messageId, {
        kind: 'interrupted',
        error: 'Pending queued message interrupted by user',
        completionSource: 'interrupt',
      });
    }
    return clearedMessages;
  }

  return {
    enqueue,
    drainNextPendingMessage,
    snapshotForStreamConnect,
    interruptPendingQueuedMessages,
    requestPendingDrain,
    requestPendingDrainIfNeeded,
  };
}

export async function enqueuePendingSessionMessageIntent(
  storage: SessionQueueStorage,
  intent: SessionMessageIntent,
  createdAt = Date.now()
): Promise<PendingSessionMessage> {
  const message = createPendingSessionMessageFromIntent(intent, createdAt);
  await storePendingSessionMessage(storage, message);
  return message;
}

export async function getQueuedMessageByMessageId(
  storage: SessionQueueStorage,
  messageId: string
): Promise<PendingSessionMessage | undefined> {
  return findPendingSessionMessageByMessageId(storage, messageId);
}
