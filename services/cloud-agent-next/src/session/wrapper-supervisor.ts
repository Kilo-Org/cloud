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
import { countPendingSessionMessages, type SessionQueueStorage } from './pending-messages.js';
import type { SessionMessageQueue } from './session-message-queue.js';
import {
  listNonTerminalAcceptedMessages,
  type SessionMessageStorage,
} from './session-message-state.js';
import type { LatestAssistantMessage } from './types.js';
import {
  clearCurrentWrapperRuntimeFailureState,
  clearCurrentWrapperRuntimeLivenessState,
  clearWrapperIdleState,
  clearWrapperRuntimeIdentity,
  getWrapperLease,
  getWrapperRuntimeState,
  hasCompleteWrapperIdentity,
  IDLE_KEEP_WARM_MS,
  IDLE_RECONCILIATION_GRACE_MS,
  isCurrentWrapperConnection,
  markWrapperPingSent,
  nextWrapperLeaseDeadline,
  putWrapperLease,
  recordMeaningfulWrapperOutput,
  recordRootSessionIdle,
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
  gateResult?: 'pass' | 'fail';
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
  observeRootIdle(
    wrapperGeneration: number,
    wrapperConnectionId: string,
    now: number
  ): Promise<void>;
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
    if (acceptedMessages.length === 0 && !isWaitingForWrapperTerminalGateResult) return;

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
    if (acceptedMessages.length === 0) {
      logger
        .withFields({ wrapperRunId })
        .info('No accepted messages during grace period - skipping failure');
      await storage.delete(DISCONNECT_GRACE_KEY);
      await releaseWrapperTerminalWaitForIdleBatch();
      return;
    }

    logger
      .withFields({ wrapperRunId, messageCount: acceptedMessages.length })
      .warn('Grace period expired - failing accepted messages');
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
    await releaseWrapperTerminalWaitForIdleBatch();
  }

  async function hasActiveWrapperWork(state: WrapperRuntimeState): Promise<boolean> {
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

    let failedTerminalObserved = !metadata.auth.kiloSessionId;
    if (!failedTerminalObserved && metadata.auth.kiloSessionId) {
      failedTerminalObserved = acceptedMessages.some(message => {
        const assistantMessage = getAssistantMessageForUserMessage(
          metadata.identity.sessionId,
          metadata.auth.kiloSessionId ?? '',
          message.messageId
        );
        return (
          !assistantMessage || getAssistantErrorMessage(assistantMessage.info.error) !== undefined
        );
      });
    }
    if (failedTerminalObserved) {
      await requestPhysicalWrapperStop('terminal-failed');
    }

    for (const message of acceptedMessages) {
      if (!metadata.auth.kiloSessionId) {
        failedTerminalObserved = true;
        await messageSettlementOutbox.terminalizeSessionMessageOnce(message.messageId, {
          kind: 'failed',
          reason: 'missing_assistant_reply',
          error: 'No assistant reply found after idle timeout',
          completionSource: 'idle_reconciliation',
          failureStage: 'post_dispatch_no_activity',
          failureCode: 'missing_assistant_reply',
        });
        continue;
      }

      const assistantMessage = getAssistantMessageForUserMessage(
        metadata.identity.sessionId,
        metadata.auth.kiloSessionId,
        message.messageId
      );
      if (!assistantMessage) {
        failedTerminalObserved = true;
        await messageSettlementOutbox.terminalizeSessionMessageOnce(message.messageId, {
          kind: 'failed',
          reason: 'missing_assistant_reply',
          error: 'No assistant reply found after idle timeout',
          completionSource: 'idle_reconciliation',
          failureStage: 'post_dispatch_no_activity',
          failureCode: 'missing_assistant_reply',
        });
        continue;
      }

      await observeCorrelatedAgentActivity?.(message.messageId);
      const assistantError = getAssistantErrorMessage(assistantMessage.info.error);
      if (assistantError !== undefined) {
        failedTerminalObserved = true;
        await messageSettlementOutbox.terminalizeSessionMessageOnce(message.messageId, {
          kind: 'failed',
          reason: 'assistant_error',
          error: assistantError,
          completionSource: 'idle_reconciliation',
          failureStage: 'agent_activity',
          failureCode: 'assistant_error',
        });
        continue;
      }

      await messageSettlementOutbox.terminalizeSessionMessageOnce(message.messageId, {
        kind: 'completed',
        assistantMessageId: assistantMessage.info.id,
        completionSource: 'idle_reconciliation',
      });
    }

    if (failedTerminalObserved) {
      if (state.wrapperConnectionId) {
        await clearWrapperRuntimeIdentity(storage, {
          wrapperGeneration: state.wrapperGeneration,
          wrapperConnectionId: state.wrapperConnectionId,
        });
      }
    } else {
      await retainPhysicalWrapperWarm(now);
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
    const lease = await getWrapperLease(storage);
    if (lease.state === 'owns_wrapper' && lease.startupDeadlineAt !== undefined) return;
    const wrapperState = await getWrapperRuntimeState(storage);
    const keepWarmUntil =
      lease.state === 'owns_wrapper' ? lease.keepWarmUntil : wrapperState.wrapperIdleDeadlineAt;
    if (keepWarmUntil === undefined || keepWarmUntil > now) return;

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
      await putWrapperLease(
        storage,
        reduceWrapperLease(latest, { type: 'stop_absent', attemptId })
      );
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
        retryAt: stopRetryAt(now, stopping.attempts),
        error,
      })
    );
  }

  async function onTerminalEvent(params: WrapperTerminalEvent): Promise<void> {
    const { wrapperRunId, status, error, gateResult } = params;
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
        error,
        gateResult,
      })
      .info('Wrapper terminal event received by supervisor');

    if (status === 'failed' || status === 'interrupted') {
      await requestPhysicalWrapperStop(
        status === 'failed' ? 'terminal-failed' : 'terminal-interrupted'
      );
      const acceptedMessages = await listNonTerminalAcceptedMessages(storage, wrapperRunId);
      for (const message of acceptedMessages) {
        if (status === 'failed') {
          const activityObserved = message.agentActivityObservedAt !== undefined;
          await messageSettlementOutbox.terminalizeSessionMessageOnce(message.messageId, {
            kind: 'failed',
            reason: 'wrapper_error',
            error: error ?? 'Wrapper error',
            completionSource: 'wrapper_failure',
            failureStage: activityObserved ? 'agent_activity' : 'post_dispatch_no_activity',
            failureCode: activityObserved
              ? 'wrapper_error_after_activity'
              : 'wrapper_error_before_activity',
          });
          continue;
        }

        await messageSettlementOutbox.terminalizeSessionMessageOnce(message.messageId, {
          kind: 'interrupted',
          error: error ?? 'Wrapper interrupted',
          completionSource: 'interrupt',
          failureStage: 'interruption',
          failureCode: 'system_interrupt',
        });
      }
    }

    if (status === 'completed') {
      const acceptedMessages = await listNonTerminalAcceptedMessages(storage, wrapperRunId);
      if (acceptedMessages.length === 0) {
        await retainPhysicalWrapperWarm(Date.now());
        await clearInterruptRequest();
      }
    } else {
      await clearWrapperRuntimeIdentity(storage, {
        wrapperGeneration: state.wrapperGeneration,
        wrapperConnectionId: state.wrapperConnectionId,
      });
      await clearInterruptRequest();
    }

    await clearDisconnectGrace();
    await messageSettlementOutbox.observeWrapperTerminalForIdleBatch(gateResult);
    await messageSettlementOutbox.finalizeIdleBatchCallbackIfReady({
      allowWithoutObservedIdle: true,
    });
    await sessionMessageQueue.requestPendingDrainIfNeeded();
  }

  async function runMaintenance(now: number): Promise<void> {
    await reconcilePhysicalCleanup(now);
    await checkDisconnectGrace(now);
    await checkWrapperLiveness(now);
    await checkIdleReconciliation(now);
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
    requestPhysicalWrapperStop,
    clearDisconnectGrace,
    runMaintenance,
    nextMaintenanceDeadlines,
  };
}
