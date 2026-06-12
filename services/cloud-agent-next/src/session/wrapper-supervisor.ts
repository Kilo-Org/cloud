import { z } from 'zod';
import { logger } from '../logger.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import type {
  StopWrappersResult,
  WrapperStopReason,
  WrapperStopTarget,
} from '../agent-sandbox/protocol.js';
import type { AgentRuntime } from './agent-runtime.js';
import { WRAPPER_NO_OUTPUT_TIMEOUT_MS, WRAPPER_PING_INTERVAL_MS } from './agent-runtime.js';
import type { MessageSettlementOutbox } from './message-settlement-outbox.js';
import { classifyAssistantFailureMessage } from './safe-failure-projection.js';
import { countPendingSessionMessages, type SessionQueueStorage } from './pending-messages.js';
import type { SessionMessageQueue } from './session-message-queue.js';
import {
  listMessagesForWrapperRun,
  listNonTerminalAcceptedMessages,
  type SessionMessageState,
  type SessionMessageStorage,
} from './session-message-state.js';
import type { WrapperTerminalFailureCode } from '../shared/protocol.js';
import type { LatestAssistantMessage } from './types.js';
import {
  MODEL_NOT_FOUND_RUNTIME_DIAGNOSTIC_LOG_CHUNK_SIZE,
  MODEL_NOT_FOUND_RUNTIME_DIAGNOSTIC_MAX_SERIALIZED_BYTES,
  isModelNotFoundRuntimeDiagnosticsWithinQueueBudget,
  type ModelNotFoundRuntimeDiagnostics,
} from '../shared/runtime-model-diagnostics.js';
import {
  clearCurrentWrapperRuntimeFailureState,
  clearCurrentWrapperRuntimeLivenessState,
  clearWrapperRuntimeIdentity,
  getWrapperLease,
  getWrapperRuntimeState,
  hasCompleteWrapperIdentity,
  hasCompleteWrapperRunMessageIndex,
  IDLE_KEEP_WARM_MS,
  isCurrentWrapperConnection,
  isWrapperDeliveryHeld,
  isWrapperRunFinalizing,
  markWrapperFinalizing,
  markWrapperPingSent,
  nextWrapperLeaseDeadline,
  putWrapperLease,
  recordMeaningfulWrapperOutput,
  recordWrapperPong,
  reduceWrapperLease,
  type WrapperConnectionFence,
  type WrapperRuntimeState,
} from './wrapper-runtime-state.js';

const DISCONNECT_GRACE_MS = 10_000;
const WRAPPER_PING_TIMEOUT_MS = 30_000;
const WRAPPER_STOP_ATTEMPT_TIMEOUT_MS = 45_000;
const WRAPPER_STOP_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 300_000];
const DISCONNECT_GRACE_KEY = 'disconnect_grace';
const MODEL_NOT_FOUND_SAFE_ERROR_MESSAGE = 'Assistant request failed: model not found';

const disconnectGraceStateSchema = z.object({
  wrapperRunId: z.string(),
  disconnectedAt: z.number(),
  wsCloseCode: z.number(),
  wsCloseReason: z.string(),
  wrapperGeneration: z.number().int().nonnegative(),
  wrapperConnectionId: z.string(),
});

type DisconnectGraceState = z.infer<typeof disconnectGraceStateSchema>;

type DisconnectGraceFence = {
  wrapperGeneration?: number;
  wrapperConnectionId?: string;
};

export type WrapperReconnectInput = {
  wrapperRunId: string;
  wrapperGeneration: number;
  wrapperConnectionId: string;
};

export type WrapperReconnectDecision =
  | { accepted: true }
  | { accepted: false; reason: 'stale-wrapper-run' | 'stale-wrapper-connection' };

export type WrapperDisconnectedInput = {
  disconnected: {
    wrapperRunId: string;
    wrapperGeneration: number;
    wrapperConnectionId: string;
  };
  wsCloseCode: number;
  wsCloseReason: string;
};

export type WrapperTerminalEvent = {
  wrapperRunId: string;
  status: 'completed' | 'failed' | 'interrupted';
  error?: string;
  errorSource?: 'assistant';
  modelNotFoundRuntimeDiagnostics?: ModelNotFoundRuntimeDiagnostics;
  interruptionSource?: 'container_shutdown';
  failureCode?: WrapperTerminalFailureCode;
  gateResult?: 'pass' | 'fail';
  messageIds?: string[];
};

type SealedBatchSettlementResult = {
  failedTerminalObserved: boolean;
};

export type WrapperSupervisorStorage = DurableObjectStorage &
  SessionQueueStorage &
  SessionMessageStorage;

export type WrapperSupervisor = {
  checkReconnect(input: WrapperReconnectInput): Promise<WrapperReconnectDecision>;
  recordReconnectAccepted(fence: WrapperConnectionFence): Promise<void>;
  isCurrentConnection(wrapperGeneration: number, wrapperConnectionId: string): Promise<boolean>;
  observePong(wrapperGeneration: number, wrapperConnectionId: string, now: number): Promise<void>;
  observeMeaningfulOutput(
    wrapperGeneration: number,
    wrapperConnectionId: string,
    now: number
  ): Promise<void>;
  observeFinalizing(wrapperRunId: string): Promise<void>;
  onDisconnected(input: WrapperDisconnectedInput): Promise<void>;
  onTerminalEvent(params: WrapperTerminalEvent): Promise<void>;
  requestPhysicalWrapperStop(reason: WrapperStopReason, target?: WrapperStopTarget): Promise<void>;
  clearDisconnectGrace(): Promise<void>;
  runMaintenance(now: number): Promise<void>;
  nextMaintenanceDeadlines(): Promise<number[]>;
};

export type WrapperSupervisorDependencies = {
  storage: WrapperSupervisorStorage;
  agentRuntime: Pick<AgentRuntime, 'sendPing'>;
  messageSettlementOutbox: Pick<
    MessageSettlementOutbox,
    | 'terminalizeSessionMessageOnce'
    | 'observeWrapperTerminalForIdleBatch'
    | 'releaseWrapperTerminalWaitForIdleBatch'
    | 'releaseWrapperTerminalWaitForIdleBatchForWrapperRun'
    | 'isWaitingForWrapperTerminalGateResult'
    | 'finalizeIdleBatchCallbackIfReady'
    | 'finalizeTerminalWrapperRunCallbackIfReady'
  >;
  sessionMessageQueue: Pick<SessionMessageQueue, 'requestPendingDrainIfNeeded'>;
  getMetadata: () => Promise<SessionMetadata | null>;
  getAssistantMessageForUserMessage: (
    sessionId: string,
    kiloSessionId: string,
    parentMessageId: string
  ) => LatestAssistantMessage | null;
  observeCorrelatedAgentActivity?: (messageId: string) => Promise<void>;
  hasActiveIngestConnection: (params: {
    wrapperRunId: string;
    wrapperGeneration: number;
    wrapperConnectionId: string;
  }) => Promise<boolean>;
  clearInterruptRequest: () => Promise<void>;
  ensureAcceptedMessageBeforeTerminal: (messageId: string, wrapperRunId: string) => Promise<void>;
  stopWrappers?: (request: {
    target: WrapperStopTarget;
    attemptId: string;
    reason: WrapperStopReason;
  }) => Promise<StopWrappersResult>;
  requestAlarmAtOrBefore?: (deadline: number) => Promise<void>;
  getSessionIdForLogs: () => string | undefined;
};

function matchesDisconnectGraceFence(
  graceState: DisconnectGraceState,
  fence?: DisconnectGraceFence
): boolean {
  const graceHasIdentity =
    graceState.wrapperGeneration !== undefined || graceState.wrapperConnectionId !== undefined;

  if (graceHasIdentity) {
    if (fence?.wrapperGeneration === undefined || fence.wrapperConnectionId === undefined) {
      return false;
    }
  }

  if (
    fence?.wrapperGeneration !== undefined &&
    graceState.wrapperGeneration !== fence.wrapperGeneration
  ) {
    return false;
  }

  if (
    fence?.wrapperConnectionId !== undefined &&
    graceState.wrapperConnectionId !== fence.wrapperConnectionId
  ) {
    return false;
  }

  return true;
}

function getAssistantErrorMessage(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    if ('data' in error && error.data && typeof error.data === 'object') {
      if ('message' in error.data && typeof error.data.message === 'string') {
        return error.data.message;
      }
    }
    if ('message' in error && typeof error.message === 'string') {
      return error.message;
    }
  }
  return 'Assistant message failed';
}

function getWrapperInterruptionFailureCode(
  interruptionSource: WrapperTerminalEvent['interruptionSource'],
  error: string | undefined
): 'container_shutdown' | 'system_interrupt' {
  if (interruptionSource === 'container_shutdown') return 'container_shutdown';

  // Preserve classification for wrappers already running during deployment.
  return error === 'Container shutdown: SIGTERM' || error === 'Container shutdown: SIGINT'
    ? 'container_shutdown'
    : 'system_interrupt';
}

function parseCodeReviewCallbackTarget(
  metadata: SessionMetadata | null
): { reviewId: string; attemptId?: string } | undefined {
  const callbackUrl = metadata?.callback?.target?.url;
  if (!callbackUrl) return undefined;

  try {
    const url = new URL(callbackUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    const markerIndex = segments.findIndex(
      (segment, index) =>
        segment === 'code-review-status' &&
        segments[index - 2] === 'api' &&
        segments[index - 1] === 'internal'
    );
    const reviewId = markerIndex === -1 ? undefined : segments[markerIndex + 1];
    if (!reviewId) return undefined;
    const attemptId = url.searchParams.get('attemptId') ?? undefined;
    return { reviewId, ...(attemptId ? { attemptId } : {}) };
  } catch {
    return undefined;
  }
}

function serializedDiagnosticsByteLength(
  diagnostics: ModelNotFoundRuntimeDiagnostics
): number | undefined {
  try {
    return new TextEncoder().encode(JSON.stringify(diagnostics)).byteLength;
  } catch {
    return undefined;
  }
}

function logCodeReviewRuntimeModelDiagnostics(params: {
  diagnostics: ModelNotFoundRuntimeDiagnostics;
  metadata: SessionMetadata;
  reviewId?: string;
  attemptId?: string;
  wrapperRunId: string;
  wrapperGeneration: number;
  wrapperConnectionId: string;
}): void {
  const {
    diagnostics,
    metadata,
    reviewId,
    attemptId,
    wrapperRunId,
    wrapperGeneration,
    wrapperConnectionId,
  } = params;
  const serializedByteLength = serializedDiagnosticsByteLength(diagnostics);
  const fitsQueueBudget = isModelNotFoundRuntimeDiagnosticsWithinQueueBudget(diagnostics);
  const baseFields = {
    logTag: 'code-review-runtime-model-not-found',
    reviewId,
    attemptId,
    sessionId: metadata.identity.sessionId,
    wrapperRunId,
    wrapperGeneration,
    wrapperConnectionId,
    requestedModel: diagnostics.requestedModel,
    availableModelCount: diagnostics.availableModelCount,
    suggestedModels: diagnostics.suggestedModels,
    suggestionSource: diagnostics.suggestionSource,
    serializedByteLength,
  };

  if (fitsQueueBudget) {
    logger
      .withFields({
        ...baseFields,
        availableModels: diagnostics.availableModels,
      })
      .warn('Code review runtime model not found');
    return;
  }

  const chunkCount = Math.ceil(
    diagnostics.availableModels.length / MODEL_NOT_FOUND_RUNTIME_DIAGNOSTIC_LOG_CHUNK_SIZE
  );
  logger
    .withFields({
      ...baseFields,
      maxSerializedByteLength: MODEL_NOT_FOUND_RUNTIME_DIAGNOSTIC_MAX_SERIALIZED_BYTES,
      chunkCount,
    })
    .warn('Code review runtime model diagnostics exceeded callback budget');

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * MODEL_NOT_FOUND_RUNTIME_DIAGNOSTIC_LOG_CHUNK_SIZE;
    logger
      .withFields({
        ...baseFields,
        chunkIndex,
        chunkCount,
        availableModels: diagnostics.availableModels.slice(
          start,
          start + MODEL_NOT_FOUND_RUNTIME_DIAGNOSTIC_LOG_CHUNK_SIZE
        ),
      })
      .warn('Code review runtime model not found model-list chunk');
  }
}

export function createWrapperSupervisor(
  dependencies: WrapperSupervisorDependencies
): WrapperSupervisor {
  const {
    storage,
    agentRuntime,
    messageSettlementOutbox,
    sessionMessageQueue,
    getMetadata,
    getAssistantMessageForUserMessage,
    observeCorrelatedAgentActivity,
    hasActiveIngestConnection,
    clearInterruptRequest,
    ensureAcceptedMessageBeforeTerminal,
    stopWrappers,
    requestAlarmAtOrBefore,
    getSessionIdForLogs,
  } = dependencies;

  async function readDisconnectGrace(): Promise<DisconnectGraceState | undefined> {
    const stored = await storage.get<unknown>(DISCONNECT_GRACE_KEY);
    const parsed = disconnectGraceStateSchema.safeParse(stored);
    if (parsed.success) return parsed.data;
    if (stored !== undefined) {
      try {
        await storage.delete(DISCONNECT_GRACE_KEY);
      } catch {
        // Invalid pre-fence grace state must not block current wrapper work.
      }
    }
    return undefined;
  }

  async function cancelDisconnectGrace(fence?: DisconnectGraceFence): Promise<void> {
    const graceState = await readDisconnectGrace();
    if (!graceState) return;
    if (!matchesDisconnectGraceFence(graceState, fence)) return;
    await storage.delete(DISCONNECT_GRACE_KEY);
  }

  async function clearDisconnectGrace(): Promise<void> {
    await storage.delete(DISCONNECT_GRACE_KEY);
  }

  async function releaseWrapperTerminalWaitForIdleBatch(): Promise<void> {
    await messageSettlementOutbox.releaseWrapperTerminalWaitForIdleBatch();
    await messageSettlementOutbox.finalizeIdleBatchCallbackIfReady({
      allowWithoutObservedIdle: true,
    });
  }

  async function releaseWrapperTerminalWaitForIdleBatchForWrapperRun(
    wrapperRunId?: string
  ): Promise<void> {
    if (!wrapperRunId) return;

    const released =
      await messageSettlementOutbox.releaseWrapperTerminalWaitForIdleBatchForWrapperRun(
        wrapperRunId
      );
    if (!released) return;

    await messageSettlementOutbox.finalizeTerminalWrapperRunCallbackIfReady(wrapperRunId);
  }

  async function checkReconnect(input: WrapperReconnectInput): Promise<WrapperReconnectDecision> {
    const runtimeState = await getWrapperRuntimeState(storage);
    if (runtimeState.wrapperRunId !== input.wrapperRunId) {
      return { accepted: false, reason: 'stale-wrapper-run' };
    }

    if (
      !(await isCurrentWrapperConnection(
        storage,
        input.wrapperGeneration,
        input.wrapperConnectionId
      ))
    ) {
      return { accepted: false, reason: 'stale-wrapper-connection' };
    }

    return { accepted: true };
  }

  async function recordReconnectAccepted(fence: WrapperConnectionFence): Promise<void> {
    await cancelDisconnectGrace(fence);
  }

  async function isCurrentConnection(
    wrapperGeneration: number,
    wrapperConnectionId: string
  ): Promise<boolean> {
    return isCurrentWrapperConnection(storage, wrapperGeneration, wrapperConnectionId);
  }

  async function observePong(
    wrapperGeneration: number,
    wrapperConnectionId: string,
    now: number
  ): Promise<void> {
    await recordWrapperPong(
      storage,
      wrapperGeneration,
      wrapperConnectionId,
      now,
      now + WRAPPER_PING_INTERVAL_MS
    );
  }

  async function observeMeaningfulOutput(
    wrapperGeneration: number,
    wrapperConnectionId: string,
    now: number
  ): Promise<void> {
    await recordMeaningfulWrapperOutput(
      storage,
      wrapperGeneration,
      wrapperConnectionId,
      now,
      now + WRAPPER_PING_INTERVAL_MS,
      now + WRAPPER_NO_OUTPUT_TIMEOUT_MS
    );
  }

  async function retainPhysicalWrapperWarm(now: number): Promise<void> {
    const lease = await getWrapperLease(storage);
    if (lease.state !== 'owns_wrapper') return;
    const warm = reduceWrapperLease(lease, {
      type: 'retain_warm',
      instanceId: lease.instance.instanceId,
      keepWarmUntil: now + IDLE_KEEP_WARM_MS,
    });
    await putWrapperLease(storage, warm);

    const runtimeState = await getWrapperRuntimeState(storage);
    if (runtimeState.wrapperConnectionId) {
      await clearWrapperRuntimeIdentity(
        storage,
        {
          wrapperGeneration: runtimeState.wrapperGeneration,
          wrapperConnectionId: runtimeState.wrapperConnectionId,
        },
        { incrementGeneration: true }
      );
    }
    await requestAlarmAtOrBefore?.(now + IDLE_KEEP_WARM_MS);
  }

  async function observeFinalizing(wrapperRunId: string): Promise<void> {
    await markWrapperFinalizing(storage, wrapperRunId);
  }

  async function startDisconnectGrace(input: WrapperDisconnectedInput): Promise<void> {
    const { disconnected, wsCloseCode, wsCloseReason } = input;
    const now = Date.now();

    logger
      .withFields({
        sessionId: getSessionIdForLogs(),
        wrapperRunId: disconnected.wrapperRunId,
        wsCloseCode,
        wsCloseReason,
        graceMs: DISCONNECT_GRACE_MS,
      })
      .warn('Wrapper disconnected — starting grace period before marking as failed');

    await storage.put(
      DISCONNECT_GRACE_KEY,
      disconnectGraceStateSchema.parse({
        wrapperRunId: disconnected.wrapperRunId,
        disconnectedAt: now,
        wsCloseCode,
        wsCloseReason,
        wrapperGeneration: disconnected.wrapperGeneration,
        wrapperConnectionId: disconnected.wrapperConnectionId,
      })
    );
  }

  async function onDisconnected(input: WrapperDisconnectedInput): Promise<void> {
    const { disconnected } = input;
    const state = await getWrapperRuntimeState(storage);
    const isCurrentDisconnectedConnection =
      state.wrapperRunId === disconnected.wrapperRunId &&
      state.wrapperGeneration === disconnected.wrapperGeneration &&
      state.wrapperConnectionId === disconnected.wrapperConnectionId;
    if (!isCurrentDisconnectedConnection) return;

    const acceptedMessages = await listNonTerminalAcceptedMessages(
      storage,
      disconnected.wrapperRunId
    );
    const isWaitingForWrapperTerminalGateResult =
      await messageSettlementOutbox.isWaitingForWrapperTerminalGateResult();
    if (
      acceptedMessages.length === 0 &&
      !isWaitingForWrapperTerminalGateResult &&
      !isWrapperRunFinalizing(state)
    ) {
      return;
    }

    await startDisconnectGrace(input);
  }

  async function requestPhysicalWrapperStop(
    reason: WrapperStopReason,
    target?: WrapperStopTarget
  ): Promise<void> {
    const current = await getWrapperLease(storage);
    const resolvedTarget =
      target ??
      (current.state === 'owns_wrapper'
        ? { kind: 'instance' as const, instance: current.instance }
        : { kind: 'session' as const });
    const now = Date.now();
    const next = reduceWrapperLease(current, {
      type: 'request_stop',
      target: resolvedTarget,
      reason,
      now,
    });
    if (next !== current) {
      await putWrapperLease(storage, next);
      await requestAlarmAtOrBefore?.(now);
    }
  }

  async function handleUnhealthyWrapper(
    state: WrapperRuntimeState,
    error: string,
    failureCode: 'wrapper_no_output' | 'wrapper_ping_timeout'
  ): Promise<void> {
    logger
      .withFields({
        sessionId: getSessionIdForLogs(),
        wrapperRunId: state.wrapperRunId,
        wrapperGeneration: state.wrapperGeneration,
        wrapperConnectionId: state.wrapperConnectionId,
      })
      .warn('Handling unhealthy wrapper runtime');

    await requestPhysicalWrapperStop('unhealthy-wrapper');

    const acceptedMessages = await listNonTerminalAcceptedMessages(storage, state.wrapperRunId);
    for (const message of acceptedMessages) {
      const activityObserved = message.agentActivityObservedAt !== undefined;
      await messageSettlementOutbox.terminalizeSessionMessageOnce(message.messageId, {
        kind: 'failed',
        reason: 'wrapper_failure',
        error,
        completionSource: 'wrapper_failure',
        failureStage: activityObserved ? 'agent_activity' : 'post_dispatch_no_activity',
        failureCode: activityObserved ? 'wrapper_error_after_activity' : failureCode,
      });
    }
    await messageSettlementOutbox.releaseWrapperTerminalWaitForIdleBatch();
    if (isWrapperRunFinalizing(state) && state.wrapperRunId) {
      await messageSettlementOutbox.finalizeTerminalWrapperRunCallbackIfReady(state.wrapperRunId);
    } else {
      await messageSettlementOutbox.finalizeIdleBatchCallbackIfReady({
        allowWithoutObservedIdle: true,
      });
    }

    if (state.wrapperConnectionId) {
      await clearCurrentWrapperRuntimeFailureState(
        storage,
        state.wrapperGeneration,
        state.wrapperConnectionId
      );
    }
  }

  async function checkDisconnectGrace(now: number): Promise<void> {
    const graceState = await readDisconnectGrace();
    if (!graceState) return;
    if (now - graceState.disconnectedAt < DISCONNECT_GRACE_MS) return;

    const { wrapperRunId } = graceState;
    const state = await getWrapperRuntimeState(storage);
    if (
      state.wrapperRunId !== wrapperRunId ||
      state.wrapperGeneration !== graceState.wrapperGeneration
    ) {
      await storage.delete(DISCONNECT_GRACE_KEY);
      await releaseWrapperTerminalWaitForIdleBatchForWrapperRun(wrapperRunId);
      return;
    }
    if (state.wrapperConnectionId !== graceState.wrapperConnectionId) {
      await storage.delete(DISCONNECT_GRACE_KEY);
      await releaseWrapperTerminalWaitForIdleBatchForWrapperRun(wrapperRunId);
      return;
    }

    if (
      await hasActiveIngestConnection({
        wrapperRunId,
        wrapperGeneration: graceState.wrapperGeneration,
        wrapperConnectionId: graceState.wrapperConnectionId,
      })
    ) {
      logger
        .withFields({ wrapperRunId })
        .info('Wrapper reconnected during grace period — skipping failure');
      await storage.delete(DISCONNECT_GRACE_KEY);
      return;
    }

    const acceptedMessages = await listNonTerminalAcceptedMessages(storage, wrapperRunId);
    if (acceptedMessages.length === 0 && !isWrapperRunFinalizing(state)) {
      logger
        .withFields({ wrapperRunId })
        .info('No accepted messages during grace period - skipping failure');
      await storage.delete(DISCONNECT_GRACE_KEY);
      await releaseWrapperTerminalWaitForIdleBatch();
      return;
    }

    logger
      .withFields({ wrapperRunId, messageCount: acceptedMessages.length })
      .warn('Grace period expired - failing supervised wrapper work');
    await requestPhysicalWrapperStop('unhealthy-wrapper');
    await storage.delete(DISCONNECT_GRACE_KEY);
    for (const message of acceptedMessages) {
      const activityObserved = message.agentActivityObservedAt !== undefined;
      await messageSettlementOutbox.terminalizeSessionMessageOnce(message.messageId, {
        kind: 'failed',
        reason: 'wrapper_disconnected',
        error: 'Wrapper disconnected',
        completionSource: 'wrapper_failure',
        failureStage: activityObserved ? 'agent_activity' : 'post_dispatch_no_activity',
        failureCode: activityObserved ? 'wrapper_error_after_activity' : 'wrapper_disconnected',
      });
    }
    await clearWrapperRuntimeIdentity(
      storage,
      {
        wrapperGeneration: state.wrapperGeneration,
        wrapperConnectionId: state.wrapperConnectionId,
      },
      { incrementGeneration: true }
    );
    await releaseWrapperTerminalWaitForIdleBatchForWrapperRun(wrapperRunId);
  }

  async function hasActiveWrapperWork(state: WrapperRuntimeState): Promise<boolean> {
    if (isWrapperRunFinalizing(state)) return true;
    return (await listNonTerminalAcceptedMessages(storage, state.wrapperRunId)).length > 0;
  }

  async function getNextWrapperLivenessDeadline(): Promise<number | undefined> {
    const state = await getWrapperRuntimeState(storage);
    if (!state.wrapperConnectionId) return undefined;

    if (!(await hasActiveWrapperWork(state))) {
      const hasLivenessFields =
        state.noOutputDeadlineAt !== undefined ||
        state.pingDeadlineAt !== undefined ||
        state.nextPingAt !== undefined;
      if (hasLivenessFields) {
        await clearCurrentWrapperRuntimeLivenessState(
          storage,
          state.wrapperGeneration,
          state.wrapperConnectionId
        );
      }
      return undefined;
    }

    const deadlines = [state.pingDeadlineAt, state.nextPingAt, state.noOutputDeadlineAt].filter(
      (deadline): deadline is number => deadline !== undefined
    );
    return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
  }

  async function checkWrapperLiveness(now: number): Promise<boolean> {
    const state = await getWrapperRuntimeState(storage);
    const hasLivenessDeadline =
      state.noOutputDeadlineAt !== undefined ||
      state.pingDeadlineAt !== undefined ||
      state.nextPingAt !== undefined;
    if (!hasLivenessDeadline || !state.wrapperConnectionId) return false;

    if (!(await hasActiveWrapperWork(state))) {
      await clearCurrentWrapperRuntimeLivenessState(
        storage,
        state.wrapperGeneration,
        state.wrapperConnectionId
      );
      return false;
    }

    if (state.noOutputDeadlineAt !== undefined && now >= state.noOutputDeadlineAt) {
      logger
        .withFields({
          sessionId: getSessionIdForLogs(),
          wrapperRunId: state.wrapperRunId,
          wrapperGeneration: state.wrapperGeneration,
          wrapperConnectionId: state.wrapperConnectionId,
          noOutputDeadlineAt: state.noOutputDeadlineAt,
        })
        .warn('Wrapper liveness no-output deadline expired');
      await handleUnhealthyWrapper(
        state,
        'Wrapper accepted the message but produced no output',
        'wrapper_no_output'
      );
      return true;
    }

    if (state.pingDeadlineAt !== undefined && now >= state.pingDeadlineAt) {
      logger
        .withFields({
          sessionId: getSessionIdForLogs(),
          wrapperRunId: state.wrapperRunId,
          wrapperGeneration: state.wrapperGeneration,
          wrapperConnectionId: state.wrapperConnectionId,
          pingDeadlineAt: state.pingDeadlineAt,
        })
        .warn('Wrapper liveness ping deadline expired');
      await handleUnhealthyWrapper(
        state,
        'Wrapper did not respond to liveness ping',
        'wrapper_ping_timeout'
      );
      return true;
    }

    if (
      state.pingDeadlineAt === undefined &&
      state.nextPingAt !== undefined &&
      now >= state.nextPingAt
    ) {
      if (state.wrapperRunId) {
        agentRuntime.sendPing(state.wrapperRunId);
      }
      await markWrapperPingSent(
        storage,
        state.wrapperGeneration,
        state.wrapperConnectionId,
        now + WRAPPER_PING_TIMEOUT_MS
      );
      return true;
    }

    return false;
  }

  function isPromptMessage(message: SessionMessageState): boolean {
    const turn = message.admissionSnapshot?.turn ?? message.legacyAdmissionConstraints?.turn;
    return turn?.type !== 'command';
  }

  async function failAcceptedMessagesForProtocolError(
    acceptedMessages: SessionMessageState[],
    error: string
  ): Promise<void> {
    for (const message of acceptedMessages) {
      await messageSettlementOutbox.terminalizeSessionMessageOnce(message.messageId, {
        kind: 'failed',
        reason: 'wrapper_protocol_error',
        error,
        completionSource: 'wrapper_failure',
        failureStage: 'agent_activity',
        failureCode: 'wrapper_error_after_activity',
      });
    }
  }

  async function settleSealedBatch(
    wrapperRunId: string,
    messageIds: string[],
    dispatchingMessageId?: string,
    membershipProtocolError?: string
  ): Promise<SealedBatchSettlementResult | null> {
    const sealedMessageIds = [...new Set(messageIds)];
    const repairMessageIds = [
      ...new Set([...sealedMessageIds, ...(dispatchingMessageId ? [dispatchingMessageId] : [])]),
    ];
    for (const messageId of repairMessageIds) {
      await ensureAcceptedMessageBeforeTerminal(messageId, wrapperRunId);
    }

    const wrapperRunMessages = await listMessagesForWrapperRun(storage, wrapperRunId);
    const wrapperRunMessagesById = new Map(
      wrapperRunMessages.map(message => [message.messageId, message])
    );
    const acceptedMessages = wrapperRunMessages.filter(message => message.status === 'accepted');
    const earlyProtocolError =
      membershipProtocolError ??
      (sealedMessageIds.length !== messageIds.length
        ? 'Wrapper complete contained duplicate sealed batch membership'
        : undefined);
    if (earlyProtocolError) {
      await requestPhysicalWrapperStop('terminal-failed');
      await failAcceptedMessagesForProtocolError(acceptedMessages, earlyProtocolError);
      return { failedTerminalObserved: true };
    }

    const invalidMessageIds: string[] = [];
    for (const messageId of sealedMessageIds) {
      const state = wrapperRunMessagesById.get(messageId);
      if (!state || state.status === 'queued') invalidMessageIds.push(messageId);
    }
    const sealedSet = new Set(sealedMessageIds);
    const omittedMessages = wrapperRunMessages.filter(message => !sealedSet.has(message.messageId));
    const protocolFailure = invalidMessageIds.length > 0 || omittedMessages.length > 0;

    if (protocolFailure) {
      await requestPhysicalWrapperStop('terminal-failed');
      await failAcceptedMessagesForProtocolError(
        acceptedMessages,
        'Wrapper complete contained invalid sealed batch membership'
      );
      logger
        .withFields({
          wrapperRunId,
          invalidMessageIds,
          omittedMessageIds: omittedMessages.map(message => message.messageId),
        })
        .warn('Wrapper complete contained invalid sealed batch membership');
      return { failedTerminalObserved: true };
    }

    const metadata = await getMetadata();
    if (!metadata) return null;
    const kiloSessionId = metadata.auth.kiloSessionId;
    let failedTerminalObserved = wrapperRunMessages.some(
      message =>
        sealedSet.has(message.messageId) &&
        (message.status === 'failed' || message.status === 'interrupted')
    );

    for (const messageId of sealedMessageIds) {
      const message = wrapperRunMessagesById.get(messageId);
      if (!message || message.status !== 'accepted') continue;
      const assistantMessage = kiloSessionId
        ? getAssistantMessageForUserMessage(metadata.identity.sessionId, kiloSessionId, messageId)
        : null;
      const assistantError = getAssistantErrorMessage(assistantMessage?.info.error);
      if (assistantError !== undefined) {
        failedTerminalObserved = true;
        await observeCorrelatedAgentActivity?.(messageId);
        await messageSettlementOutbox.terminalizeSessionMessageOnce(messageId, {
          kind: 'failed',
          reason: 'assistant_error',
          error: assistantError,
          completionSource: 'idle_reconciliation',
          failureStage: 'agent_activity',
          failureCode: 'assistant_error',
          safeFailureMessage: classifyAssistantFailureMessage(assistantError),
        });
      } else if (assistantMessage) {
        await observeCorrelatedAgentActivity?.(messageId);
        await messageSettlementOutbox.terminalizeSessionMessageOnce(messageId, {
          kind: 'completed',
          assistantMessageId: assistantMessage.info.id,
          completionSource: 'idle_reconciliation',
        });
      } else if (!isPromptMessage(message)) {
        await messageSettlementOutbox.terminalizeSessionMessageOnce(messageId, {
          kind: 'completed',
          completionSource: 'idle_reconciliation',
        });
      } else {
        failedTerminalObserved = true;
        await messageSettlementOutbox.terminalizeSessionMessageOnce(messageId, {
          kind: 'failed',
          reason: 'missing_assistant_reply',
          error: 'No assistant reply found during wrapper completion',
          completionSource: 'idle_reconciliation',
          failureStage: 'post_dispatch_no_activity',
          failureCode: 'missing_assistant_reply',
        });
      }
    }

    if (failedTerminalObserved) await requestPhysicalWrapperStop('terminal-failed');
    return { failedTerminalObserved };
  }

  async function checkKeepWarmCleanup(now: number): Promise<void> {
    const lease = await getWrapperLease(storage);
    if (lease.state === 'owns_wrapper' && lease.startupDeadlineAt !== undefined) return;
    const wrapperState = await getWrapperRuntimeState(storage);
    if (isWrapperRunFinalizing(wrapperState)) return;
    const keepWarmUntil =
      lease.state === 'owns_wrapper' ? lease.keepWarmUntil : wrapperState.wrapperIdleDeadlineAt;
    if (keepWarmUntil === undefined || keepWarmUntil > now) return;

    const pendingCount = await countPendingSessionMessages(storage);
    const acceptedMessages = await listNonTerminalAcceptedMessages(
      storage,
      wrapperState.wrapperRunId
    );
    if (pendingCount > 0 || acceptedMessages.length > 0) return;

    logger
      .withFields({
        sessionId: getSessionIdForLogs(),
        wrapperRunId: wrapperState.wrapperRunId,
      })
      .info('Keep-warm deadline expired, cleaning up idle wrapper');
    if (wrapperState.wrapperConnectionId) {
      await clearWrapperRuntimeIdentity(
        storage,
        {
          wrapperGeneration: wrapperState.wrapperGeneration,
          wrapperConnectionId: wrapperState.wrapperConnectionId,
        },
        { incrementGeneration: true }
      );
    }
    await releaseWrapperTerminalWaitForIdleBatch();
    await requestPhysicalWrapperStop('keep-warm-expired');
  }

  function stopRetryAt(now: number, attempts: number): number {
    const delay =
      WRAPPER_STOP_RETRY_DELAYS_MS[Math.min(attempts - 1, WRAPPER_STOP_RETRY_DELAYS_MS.length - 1)];
    return now + delay;
  }

  async function reconcilePhysicalCleanup(now: number): Promise<void> {
    if (!stopWrappers) return;
    let lease = await getWrapperLease(storage);
    if (
      lease.state === 'owns_wrapper' &&
      lease.startupDeadlineAt !== undefined &&
      now >= lease.startupDeadlineAt
    ) {
      const runtimeState = await getWrapperRuntimeState(storage);
      if (await hasActiveWrapperWork(runtimeState)) {
        lease = reduceWrapperLease(lease, {
          type: 'delivery_accepted',
          instanceId: lease.instance.instanceId,
        });
      } else {
        lease = reduceWrapperLease(lease, {
          type: 'request_stop',
          target: { kind: 'instance', instance: lease.instance },
          reason: 'startup-failed',
          now,
        });
      }
      await putWrapperLease(storage, lease);
    }
    if (lease.state === 'stopping') {
      if (now < lease.attemptDeadlineAt) return;
      lease = reduceWrapperLease(lease, {
        type: 'stop_attempt_expired',
        attemptId: lease.attemptId,
        retryAt: stopRetryAt(now, lease.attempts),
      });
      await putWrapperLease(storage, lease);
      return;
    }
    if (lease.state !== 'stop_needed' || now < lease.nextAttemptAt) return;

    const attemptId = crypto.randomUUID();
    const stopping = reduceWrapperLease(lease, {
      type: 'begin_stop_attempt',
      attemptId,
      now,
      attemptDeadlineAt: now + WRAPPER_STOP_ATTEMPT_TIMEOUT_MS,
    });
    if (stopping.state !== 'stopping') return;
    await putWrapperLease(storage, stopping);
    await requestAlarmAtOrBefore?.(stopping.attemptDeadlineAt);

    let result: StopWrappersResult;
    try {
      result = await stopWrappers({
        target: stopping.target,
        attemptId,
        reason: stopping.reason,
      });
    } catch (error) {
      result = {
        status: 'inspection-failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const latest = await getWrapperLease(storage);
    if (result.status === 'absent') {
      const cleaned = reduceWrapperLease(latest, { type: 'stop_absent', attemptId });
      await putWrapperLease(storage, cleaned);
      if (!isWrapperDeliveryHeld(await getWrapperRuntimeState(storage), cleaned)) {
        await sessionMessageQueue.requestPendingDrainIfNeeded();
      }
      return;
    }
    const error =
      result.status === 'inspection-failed'
        ? result.error
        : (result.error ?? 'Wrapper remains present');
    await putWrapperLease(
      storage,
      reduceWrapperLease(latest, {
        type: 'stop_not_confirmed',
        attemptId,
        retryAt: stopRetryAt(Date.now(), stopping.attempts),
        error,
      })
    );
  }

  async function onTerminalEvent(params: WrapperTerminalEvent): Promise<void> {
    const {
      wrapperRunId,
      status,
      error,
      errorSource,
      modelNotFoundRuntimeDiagnostics,
      interruptionSource,
      failureCode: terminalFailureCode,
      gateResult,
      messageIds,
    } = params;
    const sessionId = getSessionIdForLogs();
    const state = await getWrapperRuntimeState(storage);
    if (
      !hasCompleteWrapperIdentity(state) ||
      !state.wrapperRunId ||
      state.wrapperRunId !== wrapperRunId ||
      !state.wrapperConnectionId
    ) {
      logger
        .withFields({ sessionId, wrapperRunId, status })
        .warn('Ignoring non-current wrapper terminal event');
      return;
    }

    logger
      .withFields({
        sessionId,
        wrapperRunId,
        status,
        errorSource,
        interruptionSource,
        gateResult,
        messageCount: messageIds?.length,
      })
      .info('Wrapper terminal event received by supervisor');

    let persistedModelNotFoundDiagnostics: ModelNotFoundRuntimeDiagnostics | undefined;
    const canPersistModelNotFoundDiagnostics =
      status === 'failed' &&
      errorSource === 'assistant' &&
      classifyAssistantFailureMessage(error) === MODEL_NOT_FOUND_SAFE_ERROR_MESSAGE;
    if (modelNotFoundRuntimeDiagnostics && canPersistModelNotFoundDiagnostics) {
      const metadata = await getMetadata();
      if (metadata?.identity.createdOnPlatform === 'code-review') {
        const reviewTarget = parseCodeReviewCallbackTarget(metadata);
        logCodeReviewRuntimeModelDiagnostics({
          diagnostics: modelNotFoundRuntimeDiagnostics,
          metadata,
          reviewId: reviewTarget?.reviewId,
          attemptId: reviewTarget?.attemptId,
          wrapperRunId,
          wrapperGeneration: state.wrapperGeneration,
          wrapperConnectionId: state.wrapperConnectionId,
        });
        if (isModelNotFoundRuntimeDiagnosticsWithinQueueBudget(modelNotFoundRuntimeDiagnostics)) {
          persistedModelNotFoundDiagnostics = modelNotFoundRuntimeDiagnostics;
        }
      }
    }

    if (status === 'failed' || status === 'interrupted') {
      await requestPhysicalWrapperStop(
        status === 'failed' ? 'terminal-failed' : 'terminal-interrupted'
      );
      if (state.dispatchingMessageId) {
        await ensureAcceptedMessageBeforeTerminal(state.dispatchingMessageId, wrapperRunId);
      }
      const acceptedMessages = await listNonTerminalAcceptedMessages(storage, wrapperRunId);
      for (const message of acceptedMessages) {
        if (status === 'failed') {
          if (errorSource === 'assistant') {
            await messageSettlementOutbox.terminalizeSessionMessageOnce(message.messageId, {
              kind: 'failed',
              reason: 'assistant_error',
              error: error ?? 'Assistant request failed',
              completionSource: 'wrapper_failure',
              failureStage: 'agent_activity',
              failureCode: terminalFailureCode ?? 'assistant_error',
              safeFailureMessage: classifyAssistantFailureMessage(error),
              ...(persistedModelNotFoundDiagnostics
                ? { modelNotFoundRuntimeDiagnostics: persistedModelNotFoundDiagnostics }
                : {}),
            });
            continue;
          }

          const activityObserved = message.agentActivityObservedAt !== undefined;
          await messageSettlementOutbox.terminalizeSessionMessageOnce(message.messageId, {
            kind: 'failed',
            reason: 'wrapper_error',
            error: error ?? 'Wrapper error',
            completionSource: 'wrapper_failure',
            failureStage: activityObserved ? 'agent_activity' : 'post_dispatch_no_activity',
            failureCode:
              terminalFailureCode ??
              (activityObserved ? 'wrapper_error_after_activity' : 'wrapper_error_before_activity'),
          });
          continue;
        }

        await messageSettlementOutbox.terminalizeSessionMessageOnce(message.messageId, {
          kind: 'interrupted',
          error: error ?? 'Wrapper interrupted',
          completionSource: 'interrupt',
          failureStage: 'interruption',
          failureCode: getWrapperInterruptionFailureCode(interruptionSource, error),
        });
      }
    }

    if (status === 'completed') {
      const currentRunRequiresMembership = hasCompleteWrapperRunMessageIndex(state, wrapperRunId);
      const missingRequiredMembership = messageIds === undefined && currentRunRequiresMembership;
      const sealedMessageIds =
        messageIds ??
        (missingRequiredMembership
          ? []
          : [
              ...new Set([
                ...(await listMessagesForWrapperRun(storage, wrapperRunId)).map(
                  message => message.messageId
                ),
                ...(state.dispatchingMessageId ? [state.dispatchingMessageId] : []),
              ]),
            ]);
      const settlement = await settleSealedBatch(
        wrapperRunId,
        sealedMessageIds,
        state.dispatchingMessageId,
        missingRequiredMembership
          ? 'Current wrapper complete omitted sealed batch membership'
          : undefined
      );
      if (!settlement) {
        await requestPhysicalWrapperStop('terminal-failed');
        const acceptedMessages = await listNonTerminalAcceptedMessages(storage, wrapperRunId);
        await failAcceptedMessagesForProtocolError(
          acceptedMessages,
          'Wrapper complete omitted sealed batch membership'
        );
        await clearWrapperRuntimeIdentity(storage, {
          wrapperGeneration: state.wrapperGeneration,
          wrapperConnectionId: state.wrapperConnectionId,
        });
      } else if (settlement.failedTerminalObserved) {
        await clearWrapperRuntimeIdentity(storage, {
          wrapperGeneration: state.wrapperGeneration,
          wrapperConnectionId: state.wrapperConnectionId,
        });
      } else {
        await retainPhysicalWrapperWarm(Date.now());
      }
      await clearInterruptRequest();
    } else {
      await clearWrapperRuntimeIdentity(storage, {
        wrapperGeneration: state.wrapperGeneration,
        wrapperConnectionId: state.wrapperConnectionId,
      });
      await clearInterruptRequest();
    }

    await clearDisconnectGrace();
    await messageSettlementOutbox.observeWrapperTerminalForIdleBatch(gateResult);
    await messageSettlementOutbox.finalizeTerminalWrapperRunCallbackIfReady(wrapperRunId);
    if (
      !isWrapperDeliveryHeld(await getWrapperRuntimeState(storage), await getWrapperLease(storage))
    ) {
      await sessionMessageQueue.requestPendingDrainIfNeeded();
    }
  }

  async function runMaintenance(now: number): Promise<void> {
    await reconcilePhysicalCleanup(now);
    await checkDisconnectGrace(now);
    await checkWrapperLiveness(now);
    await checkKeepWarmCleanup(now);
  }

  async function nextMaintenanceDeadlines(): Promise<number[]> {
    const deadlines: number[] = [];
    const physicalDeadline = nextWrapperLeaseDeadline(await getWrapperLease(storage));
    if (physicalDeadline !== undefined) {
      deadlines.push(physicalDeadline);
    }
    const livenessDeadline = await getNextWrapperLivenessDeadline();
    if (livenessDeadline !== undefined) {
      deadlines.push(livenessDeadline);
    }

    const graceState = await readDisconnectGrace();
    if (graceState) {
      deadlines.push(graceState.disconnectedAt + DISCONNECT_GRACE_MS);
    }

    const wrapperState = await getWrapperRuntimeState(storage);
    if (wrapperState.wrapperIdleDeadlineAt !== undefined) {
      deadlines.push(wrapperState.wrapperIdleDeadlineAt);
    }

    return deadlines;
  }

  return {
    checkReconnect,
    recordReconnectAccepted,
    isCurrentConnection,
    observePong,
    observeMeaningfulOutput,
    observeFinalizing,
    onDisconnected,
    onTerminalEvent,
    requestPhysicalWrapperStop,
    clearDisconnectGrace,
    runMaintenance,
    nextMaintenanceDeadlines,
  };
}
