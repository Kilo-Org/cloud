import { logger } from '../logger.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import type { ExecutionId } from '../types/ids.js';
import type { AgentRuntime } from './agent-runtime.js';
import { WRAPPER_NO_OUTPUT_TIMEOUT_MS, WRAPPER_PING_INTERVAL_MS } from './agent-runtime.js';
import type { MessageSettlementOutbox } from './message-settlement-outbox.js';
import { countPendingSessionMessages, type SessionQueueStorage } from './pending-messages.js';
import type { SessionMessageQueue } from './session-message-queue.js';
import {
  listNonTerminalAcceptedMessages,
  type SessionMessageStorage,
} from './session-message-state.js';
import type { ExecutionMetadata, LatestAssistantMessage } from './types.js';
import {
  clearCurrentWrapperRuntimeFailureState,
  clearCurrentWrapperRuntimeLivenessState,
  clearWrapperIdleState,
  clearWrapperRuntimeIdentity,
  getWrapperRuntimeState,
  IDLE_RECONCILIATION_GRACE_MS,
  isCurrentWrapperConnection,
  markWrapperPingSent,
  recordMeaningfulWrapperOutput,
  recordRootSessionIdle,
  recordWrapperPong,
  type WrapperRuntimeFence,
  type WrapperRuntimeState,
} from './wrapper-runtime-state.js';

const DISCONNECT_GRACE_MS = 10_000;
const WRAPPER_PING_TIMEOUT_MS = 30_000;
const DISCONNECT_GRACE_KEY = 'disconnect_grace';

type DisconnectGraceState = {
  executionId?: ExecutionId;
  wrapperRunId?: string;
  disconnectedAt: number;
  wsCloseCode: number;
  wsCloseReason: string;
  wrapperGeneration?: number;
  wrapperConnectionId?: string;
};

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
    executionId?: ExecutionId;
    wrapperRunId?: string;
    wrapperGeneration?: number;
    wrapperConnectionId?: string;
  };
  wsCloseCode: number;
  wsCloseReason: string;
};

export type WrapperTerminalEvent = {
  wrapperRunId: string;
  status: 'completed' | 'failed' | 'interrupted';
  error?: string;
  gateResult?: 'pass' | 'fail';
};

type PersistedExecutionFailure = {
  executionId: ExecutionId;
  status: 'failed';
  error: string;
  streamEventType: string;
  streamPayload?: Record<string, unknown>;
};

export type WrapperSupervisorStorage = DurableObjectStorage &
  SessionQueueStorage &
  SessionMessageStorage;

export type WrapperSupervisor = {
  checkReconnect(input: WrapperReconnectInput): Promise<WrapperReconnectDecision>;
  recordReconnectAccepted(fence: WrapperRuntimeFence): Promise<void>;
  isCurrentConnection(wrapperGeneration: number, wrapperConnectionId: string): Promise<boolean>;
  observePong(wrapperGeneration: number, wrapperConnectionId: string, now: number): Promise<void>;
  observeMeaningfulOutput(
    wrapperGeneration: number,
    wrapperConnectionId: string,
    now: number
  ): Promise<void>;
  observeRootIdle(
    wrapperGeneration: number,
    wrapperConnectionId: string,
    now: number
  ): Promise<void>;
  onDisconnected(input: WrapperDisconnectedInput): Promise<void>;
  onTerminalEvent(params: WrapperTerminalEvent): Promise<void>;
  clearDisconnectGraceForExecution(executionId?: ExecutionId): Promise<void>;
  runMaintenance(now: number): Promise<void>;
  nextMaintenanceDeadlines(): Promise<number[]>;
};

export type WrapperSupervisorDependencies = {
  storage: WrapperSupervisorStorage;
  agentRuntime: Pick<AgentRuntime, 'sendPing' | 'stopWrapperProcess'>;
  messageSettlementOutbox: Pick<
    MessageSettlementOutbox,
    | 'terminalizeSessionMessageOnce'
    | 'observeWrapperTerminalForIdleBatch'
    | 'releaseWrapperTerminalWaitForIdleBatch'
    | 'releaseWrapperTerminalWaitForIdleBatchForWrapperRun'
    | 'isWaitingForWrapperTerminalGateResult'
    | 'finalizeIdleBatchCallbackIfReady'
  >;
  sessionMessageQueue: Pick<SessionMessageQueue, 'requestPendingDrainIfNeeded'>;
  getMetadata: () => Promise<SessionMetadata | null>;
  getAssistantMessageForUserMessage: (
    sessionId: string,
    kiloSessionId: string,
    parentMessageId: string
  ) => LatestAssistantMessage | null;
  getCurrentRuntimeExecutionId: () => Promise<ExecutionId | null>;
  getExecution: (executionId: ExecutionId) => Promise<ExecutionMetadata | null>;
  hasActiveIngestConnection: (params: {
    executionId?: ExecutionId;
    wrapperRunId?: string;
    wrapperGeneration?: number;
    wrapperConnectionId?: string;
  }) => Promise<boolean>;
  failExecution: (params: PersistedExecutionFailure) => Promise<boolean>;
  clearInterruptRequest: () => Promise<void>;
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
    getCurrentRuntimeExecutionId,
    getExecution,
    hasActiveIngestConnection,
    failExecution,
    clearInterruptRequest,
    getSessionIdForLogs,
  } = dependencies;

  async function cancelDisconnectGrace(fence?: DisconnectGraceFence): Promise<void> {
    const graceState = await storage.get<DisconnectGraceState>(DISCONNECT_GRACE_KEY);
    if (!graceState) return;
    if (!matchesDisconnectGraceFence(graceState, fence)) return;
    await storage.delete(DISCONNECT_GRACE_KEY);
  }

  async function clearDisconnectGraceForExecution(executionId?: ExecutionId): Promise<void> {
    const graceState = await storage.get<DisconnectGraceState>(DISCONNECT_GRACE_KEY);
    if (!graceState) return;
    if (executionId && graceState.executionId !== executionId) return;
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

    await messageSettlementOutbox.finalizeIdleBatchCallbackIfReady({
      allowWithoutObservedIdle: true,
    });
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

  async function recordReconnectAccepted(fence: WrapperRuntimeFence): Promise<void> {
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

  async function observeRootIdle(
    wrapperGeneration: number,
    wrapperConnectionId: string,
    now: number
  ): Promise<void> {
    await recordRootSessionIdle(
      storage,
      wrapperGeneration,
      wrapperConnectionId,
      now,
      now + IDLE_RECONCILIATION_GRACE_MS
    );
    await messageSettlementOutbox.finalizeIdleBatchCallbackIfReady();
  }

  async function startDisconnectGrace(input: WrapperDisconnectedInput): Promise<void> {
    const { disconnected, wsCloseCode, wsCloseReason } = input;
    const now = Date.now();

    logger
      .withFields({
        sessionId: getSessionIdForLogs(),
        executionId: disconnected.executionId,
        wrapperRunId: disconnected.wrapperRunId,
        wsCloseCode,
        wsCloseReason,
        graceMs: DISCONNECT_GRACE_MS,
      })
      .warn('Wrapper disconnected — starting grace period before marking as failed');

    await storage.put(DISCONNECT_GRACE_KEY, {
      executionId: disconnected.executionId,
      wrapperRunId: disconnected.wrapperRunId,
      disconnectedAt: now,
      wsCloseCode,
      wsCloseReason,
      wrapperGeneration: disconnected.wrapperGeneration,
      wrapperConnectionId: disconnected.wrapperConnectionId,
    } satisfies DisconnectGraceState);
  }

  async function onDisconnected(input: WrapperDisconnectedInput): Promise<void> {
    const { disconnected } = input;
    const state = await getWrapperRuntimeState(storage);
    const isCurrentDisconnectedConnection =
      disconnected.wrapperGeneration === undefined || disconnected.wrapperConnectionId === undefined
        ? state.wrapperConnectionId === undefined
        : state.wrapperGeneration === disconnected.wrapperGeneration &&
          state.wrapperConnectionId === disconnected.wrapperConnectionId;
    if (!isCurrentDisconnectedConnection) return;

    if (!disconnected.wrapperRunId) {
      // Rollout-only compatibility for wrappers that reconnect with executionId
      // instead of the current fenced wrapper-run identity.
      if (!disconnected.executionId) return;
      const legacyExecution = await getExecution(disconnected.executionId);
      if (legacyExecution?.status !== 'pending' && legacyExecution?.status !== 'running') {
        return;
      }
      await startDisconnectGrace(input);
      return;
    }

    const acceptedMessages = await listNonTerminalAcceptedMessages(
      storage,
      disconnected.wrapperRunId
    );
    const isWaitingForWrapperTerminalGateResult =
      await messageSettlementOutbox.isWaitingForWrapperTerminalGateResult();
    if (acceptedMessages.length === 0 && !isWaitingForWrapperTerminalGateResult) return;

    await startDisconnectGrace(input);
  }

  async function handleUnhealthyWrapper(
    state: WrapperRuntimeState,
    error: string,
    fallbackExecutionId?: ExecutionId
  ): Promise<void> {
    logger
      .withFields({
        sessionId: getSessionIdForLogs(),
        wrapperRunId: state.wrapperRunId,
        wrapperGeneration: state.wrapperGeneration,
        wrapperConnectionId: state.wrapperConnectionId,
        hasFallbackExecutionId: fallbackExecutionId !== undefined,
      })
      .warn('Handling unhealthy wrapper runtime');

    const executionId =
      state.acceptedExecutionId ?? state.wrapperExecutionId ?? fallbackExecutionId;
    if (executionId) {
      const execution = await getExecution(executionId as ExecutionId);
      if (execution?.status === 'pending' || execution?.status === 'running') {
        await failExecution({
          executionId: executionId as ExecutionId,
          status: 'failed',
          error,
          streamEventType: 'error',
        });
      }
    }

    const acceptedMessages = await listNonTerminalAcceptedMessages(storage, state.wrapperRunId);
    for (const message of acceptedMessages) {
      await messageSettlementOutbox.terminalizeSessionMessageOnce(message.messageId, {
        kind: 'failed',
        reason: 'wrapper_failure',
        error,
        completionSource: 'wrapper_failure',
      });
    }
    await messageSettlementOutbox.releaseWrapperTerminalWaitForIdleBatch();
    await messageSettlementOutbox.finalizeIdleBatchCallbackIfReady({
      allowWithoutObservedIdle: true,
    });

    if (state.wrapperConnectionId) {
      await clearCurrentWrapperRuntimeFailureState(
        storage,
        state.wrapperGeneration,
        state.wrapperConnectionId
      );
    }

    await agentRuntime.stopWrapperProcess('unhealthy-wrapper');
  }

  async function checkDisconnectGrace(now: number): Promise<void> {
    const graceState = await storage.get<DisconnectGraceState>(DISCONNECT_GRACE_KEY);
    if (!graceState) return;
    if (now - graceState.disconnectedAt < DISCONNECT_GRACE_MS) return;

    await storage.delete(DISCONNECT_GRACE_KEY);
    const { executionId, wrapperRunId, wsCloseCode, wsCloseReason } = graceState;
    const state = await getWrapperRuntimeState(storage);
    if (
      graceState.wrapperGeneration !== undefined &&
      state.wrapperGeneration !== graceState.wrapperGeneration
    ) {
      await releaseWrapperTerminalWaitForIdleBatchForWrapperRun(wrapperRunId);
      return;
    }
    if (
      graceState.wrapperConnectionId !== undefined &&
      state.wrapperConnectionId !== graceState.wrapperConnectionId
    ) {
      await releaseWrapperTerminalWaitForIdleBatchForWrapperRun(wrapperRunId);
      return;
    }

    if (
      await hasActiveIngestConnection({
        executionId,
        wrapperRunId,
        wrapperGeneration: graceState.wrapperGeneration,
        wrapperConnectionId: graceState.wrapperConnectionId,
      })
    ) {
      logger
        .withFields({ executionId, wrapperRunId })
        .info('Wrapper reconnected during grace period — skipping failure');
      return;
    }

    if (wrapperRunId && !executionId) {
      const acceptedMessages = await listNonTerminalAcceptedMessages(storage, wrapperRunId);
      if (acceptedMessages.length === 0) {
        logger
          .withFields({ wrapperRunId })
          .info('No accepted messages during grace period — skipping failure');
        await releaseWrapperTerminalWaitForIdleBatch();
        return;
      }

      logger
        .withFields({ wrapperRunId, messageCount: acceptedMessages.length })
        .warn('Grace period expired — failing accepted messages');
      for (const message of acceptedMessages) {
        await messageSettlementOutbox.terminalizeSessionMessageOnce(message.messageId, {
          kind: 'failed',
          reason: 'wrapper_disconnected',
          error: 'Wrapper disconnected',
          completionSource: 'wrapper_failure',
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
      await agentRuntime.stopWrapperProcess('unhealthy-wrapper');
      await releaseWrapperTerminalWaitForIdleBatch();
      return;
    }

    if (!executionId) return;
    const currentExecution = await getExecution(executionId);
    if (
      !currentExecution ||
      (currentExecution.status !== 'running' && currentExecution.status !== 'pending')
    ) {
      logger
        .withFields({
          executionId,
          status: currentExecution?.status,
        })
        .info('Execution no longer active during grace period — skipping failure');
      return;
    }

    logger.withFields({ executionId }).warn('Grace period expired — marking execution as failed');
    await failExecution({
      executionId,
      status: 'failed',
      error: 'Wrapper disconnected',
      streamEventType: 'wrapper_disconnected',
      streamPayload: { wsCloseCode, wsCloseReason },
    });
  }

  async function hasActiveWrapperWork(state: WrapperRuntimeState): Promise<{
    runtimeExecutionId: ExecutionId | null;
    hasAcceptedMessages: boolean;
  }> {
    const runtimeExecutionId = await getCurrentRuntimeExecutionId();
    const hasAcceptedMessages =
      (await listNonTerminalAcceptedMessages(storage, state.wrapperRunId)).length > 0;
    return { runtimeExecutionId, hasAcceptedMessages };
  }

  async function getNextWrapperLivenessDeadline(): Promise<number | undefined> {
    const state = await getWrapperRuntimeState(storage);
    if (!state.wrapperConnectionId) return undefined;

    const { runtimeExecutionId, hasAcceptedMessages } = await hasActiveWrapperWork(state);
    if (!runtimeExecutionId && !hasAcceptedMessages) {
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

    const { runtimeExecutionId, hasAcceptedMessages } = await hasActiveWrapperWork(state);
    if (!runtimeExecutionId && !hasAcceptedMessages) {
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
        runtimeExecutionId ?? undefined
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
        runtimeExecutionId ?? undefined
      );
      return true;
    }

    if (
      state.pingDeadlineAt === undefined &&
      state.nextPingAt !== undefined &&
      now >= state.nextPingAt
    ) {
      const ingestTagId = state.wrapperRunId ?? runtimeExecutionId;
      if (ingestTagId) {
        agentRuntime.sendPing(ingestTagId);
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

  async function checkIdleReconciliation(now: number): Promise<void> {
    const metadata = await getMetadata();
    if (!metadata) return;

    const state = await getWrapperRuntimeState(storage);
    if (!state.wrapperRunId) return;

    const acceptedMessages = await listNonTerminalAcceptedMessages(storage, state.wrapperRunId);
    if (acceptedMessages.length === 0) {
      if (
        state.wrapperConnectionId &&
        (state.lastWrapperIdleAt !== undefined || state.idleReconcileAfter !== undefined)
      ) {
        await clearWrapperIdleState(storage, state.wrapperGeneration, state.wrapperConnectionId);
      }
      return;
    }

    if (state.idleReconcileAfter !== undefined) {
      if (now < state.idleReconcileAfter) return;
    } else {
      const hasRecentOutput =
        state.lastWrapperMessageAt !== undefined &&
        now - state.lastWrapperMessageAt < WRAPPER_NO_OUTPUT_TIMEOUT_MS;
      if (hasRecentOutput) return;
    }

    logger
      .withFields({
        sessionId: metadata.identity.sessionId,
        wrapperRunId: state.wrapperRunId,
        acceptedMessageCount: acceptedMessages.length,
        hasKiloSessionId: metadata.auth.kiloSessionId !== undefined,
      })
      .info('Idle reconciliation processing accepted messages');

    for (const message of acceptedMessages) {
      if (!metadata.auth.kiloSessionId) {
        await messageSettlementOutbox.terminalizeSessionMessageOnce(message.messageId, {
          kind: 'failed',
          reason: 'missing_assistant_reply',
          error: 'No assistant reply found after idle timeout',
          completionSource: 'idle_reconciliation',
        });
        continue;
      }

      const assistantMessage = getAssistantMessageForUserMessage(
        metadata.identity.sessionId,
        metadata.auth.kiloSessionId,
        message.messageId
      );
      if (!assistantMessage) {
        await messageSettlementOutbox.terminalizeSessionMessageOnce(message.messageId, {
          kind: 'failed',
          reason: 'missing_assistant_reply',
          error: 'No assistant reply found after idle timeout',
          completionSource: 'idle_reconciliation',
        });
        continue;
      }

      const assistantError = getAssistantErrorMessage(assistantMessage.info.error);
      if (assistantError !== undefined) {
        await messageSettlementOutbox.terminalizeSessionMessageOnce(message.messageId, {
          kind: 'failed',
          reason: 'assistant_error',
          error: assistantError,
          completionSource: 'idle_reconciliation',
        });
        continue;
      }

      await messageSettlementOutbox.terminalizeSessionMessageOnce(message.messageId, {
        kind: 'completed',
        assistantMessageId: assistantMessage.info.id,
        completionSource: 'idle_reconciliation',
      });
    }

    await messageSettlementOutbox.finalizeIdleBatchCallbackIfReady();
    logger
      .withFields({
        sessionId: metadata.identity.sessionId,
        wrapperRunId: state.wrapperRunId,
        acceptedMessageCount: acceptedMessages.length,
      })
      .info('Idle reconciliation pass completed');
  }

  async function checkKeepWarmCleanup(now: number): Promise<void> {
    const wrapperState = await getWrapperRuntimeState(storage);
    if (wrapperState.wrapperIdleDeadlineAt === undefined) return;
    if (wrapperState.wrapperIdleDeadlineAt > now) return;

    const pendingCount = await countPendingSessionMessages(storage);
    const acceptedMessages = await listNonTerminalAcceptedMessages(
      storage,
      wrapperState.wrapperRunId
    );
    if (pendingCount > 0 || acceptedMessages.length > 0) {
      if (wrapperState.wrapperConnectionId) {
        await clearWrapperIdleState(
          storage,
          wrapperState.wrapperGeneration,
          wrapperState.wrapperConnectionId
        );
      }
      return;
    }

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
    await agentRuntime.stopWrapperProcess('keep-warm-expired');
  }

  async function onTerminalEvent(params: WrapperTerminalEvent): Promise<void> {
    const { wrapperRunId, status, error, gateResult } = params;
    const sessionId = getSessionIdForLogs();
    const state = await getWrapperRuntimeState(storage);

    logger
      .withFields({
        sessionId,
        wrapperRunId,
        status,
        error,
        gateResult,
      })
      .info('Wrapper terminal event received by supervisor');

    if (status === 'failed' || status === 'interrupted') {
      const acceptedMessages = await listNonTerminalAcceptedMessages(storage, wrapperRunId);
      for (const message of acceptedMessages) {
        if (status === 'failed') {
          await messageSettlementOutbox.terminalizeSessionMessageOnce(message.messageId, {
            kind: 'failed',
            reason: 'wrapper_error',
            error: error ?? 'Wrapper error',
            completionSource: 'wrapper_failure',
          });
          continue;
        }

        await messageSettlementOutbox.terminalizeSessionMessageOnce(message.messageId, {
          kind: 'interrupted',
          error: error ?? 'Wrapper interrupted',
          completionSource: 'interrupt',
        });
      }
    }

    if (state.wrapperRunId === wrapperRunId) {
      if (status === 'completed') {
        const acceptedMessages = await listNonTerminalAcceptedMessages(storage, wrapperRunId);
        if (acceptedMessages.length === 0) {
          await clearWrapperRuntimeIdentity(storage, {
            wrapperGeneration: state.wrapperGeneration,
            wrapperConnectionId: state.wrapperConnectionId,
          });
          await clearInterruptRequest();
        }
      } else {
        await clearWrapperRuntimeIdentity(storage, {
          wrapperGeneration: state.wrapperGeneration,
          wrapperConnectionId: state.wrapperConnectionId,
        });
        await clearInterruptRequest();
      }
    }

    await clearDisconnectGraceForExecution();
    await messageSettlementOutbox.observeWrapperTerminalForIdleBatch(gateResult);
    await messageSettlementOutbox.finalizeIdleBatchCallbackIfReady({
      allowWithoutObservedIdle: true,
    });
    await sessionMessageQueue.requestPendingDrainIfNeeded();
  }

  async function runMaintenance(now: number): Promise<void> {
    await checkDisconnectGrace(now);
    await checkWrapperLiveness(now);
    await checkIdleReconciliation(now);
    await checkKeepWarmCleanup(now);
  }

  async function nextMaintenanceDeadlines(): Promise<number[]> {
    const deadlines: number[] = [];
    const livenessDeadline = await getNextWrapperLivenessDeadline();
    if (livenessDeadline !== undefined) {
      deadlines.push(livenessDeadline);
    }

    const graceState = await storage.get<DisconnectGraceState>(DISCONNECT_GRACE_KEY);
    if (graceState) {
      deadlines.push(graceState.disconnectedAt + DISCONNECT_GRACE_MS);
    }

    const wrapperState = await getWrapperRuntimeState(storage);
    if (wrapperState.idleReconcileAfter !== undefined) {
      deadlines.push(wrapperState.idleReconcileAfter);
    }
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
    observeRootIdle,
    onDisconnected,
    onTerminalEvent,
    clearDisconnectGraceForExecution,
    runMaintenance,
    nextMaintenanceDeadlines,
  };
}
