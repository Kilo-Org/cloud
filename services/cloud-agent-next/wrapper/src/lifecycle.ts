import type { WrapperState } from './state.js';
import type { WrapperKiloClient } from './kilo-api.js';
import { createDrainWaiter } from './drain-wait.js';
import { runAutoCommit } from './auto-commit.js';
import { runCondenseOnComplete } from './condense-on-complete.js';
import { getCurrentBranch, logToFile } from './utils.js';

const DRAIN_DELAY_MS = 250;
export const STABLE_ROOT_IDLE_MS = 3_000;
const SSE_TRANSPORT_TIMEOUT_MS = 15_000;
const AUTO_COMMIT_TIMEOUT_MS = 120_000;

export type LifecycleConfig = {
  workspacePath: string;
};

export type LifecycleDependencies = {
  state: WrapperState;
  kiloClient: WrapperKiloClient;
  closeConnections: () => Promise<void>;
  isConnected: () => boolean;
  reconnectEventSubscription: () => void;
};

export type LifecycleManager = {
  start: () => void;
  stop: () => void;
  onSessionIdle: () => void;
  onRootSessionActivity: () => void;
  onDeliveryAcknowledged: (kind: 'async-prompt' | 'sync-command' | 'failed') => void;
  onConnectionRestored: () => void;
  triggerDrainAndClose: () => void;
  drainAndClose: () => Promise<void>;
  signalCompletion: () => void;
  setAborted: () => void;
  reset: () => void;
  onSseEvent: () => void;
};

export function createLifecycleManager(
  config: LifecycleConfig,
  deps: LifecycleDependencies
): LifecycleManager {
  const { state, kiloClient } = deps;
  let sseTransportTimer: ReturnType<typeof setTimeout> | null = null;
  let isAborted = false;
  let idleHint = false;
  let idleObservedDuringDelivery = false;
  let drainEpoch = 0;
  let drainSucceededWhileAckingEpoch: number | null = null;
  let drainReadyWhileDisconnected = false;
  let pendingDrainFailure: string | null = null;
  let postProcessingResolve: (() => void) | null = null;
  let drainPromise: Promise<void> | null = null;
  let lifecycleGeneration = 0;
  let postProcessingCompleted = false;

  const drainWaiter = createDrainWaiter(signal => {
    const session = state.currentSession;
    if (!session) throw new Error('drain requested without a current session');
    return kiloClient.drainSession({ sessionId: session.kiloSessionId, signal });
  });

  function clearSseTransportTimer(): void {
    if (!sseTransportTimer) return;
    clearTimeout(sseTransportTimer);
    sseTransportTimer = null;
  }

  function resetDrainState(): void {
    drainWaiter.cancel();
    drainEpoch += 1;
    drainSucceededWhileAckingEpoch = null;
    drainReadyWhileDisconnected = false;
  }

  function abortDrain(): void {
    resetDrainState();
    idleHint = false;
    idleObservedDuringDelivery = false;
    pendingDrainFailure = null;
  }

  function markAborted(): void {
    isAborted = true;
    state.blockAdmissions();
    abortDrain();
  }

  function resetSseTransportTimer(): void {
    clearSseTransportTimer();
    // Completion now waits on a drain HTTP call; reconnecting during the close
    // drain races auto-commit.
    if (!state.hasSession || drainPromise) return;
    sseTransportTimer = setTimeout(() => {
      logToFile('SSE transport timeout — reconnecting event subscription');
      deps.reconnectEventSubscription();
    }, SSE_TRANSPORT_TIMEOUT_MS);
  }

  function signalCompletion(): void {
    postProcessingCompleted = true;
    postProcessingResolve?.();
    postProcessingResolve = null;
  }

  async function runPostCompletionTasks(): Promise<void> {
    const session = state.currentSession;
    const msgConfig = state.batchFinalizationConfig;
    if (!session || !msgConfig || isAborted) return;

    if (msgConfig.autoCommit) {
      try {
        const autoCommitController = new AbortController();
        let autoCommitTimedOut = false;
        const timeout = setTimeout(() => {
          autoCommitTimedOut = true;
          autoCommitController.abort();
        }, AUTO_COMMIT_TIMEOUT_MS);
        const result = await runAutoCommit({
          workspacePath: config.workspacePath,
          onEvent: event => state.sendToIngest(event),
          kiloClient,
          messageId: state.lastAssistantMessageId ?? undefined,
          userMessageId: state.pendingMessageIds.at(-1),
          upstreamBranch: msgConfig.upstreamBranch,
          ...(msgConfig.commitCoAuthor ? { commitCoAuthor: msgConfig.commitCoAuthor } : {}),
          signal: autoCommitController.signal,
        }).finally(() => clearTimeout(timeout));
        if (autoCommitTimedOut && !result.success) {
          state.sendToIngest({
            streamEventType: 'error',
            data: { error: 'Auto-commit timed out', fatal: false },
            timestamp: new Date().toISOString(),
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.sendToIngest({
          streamEventType: 'error',
          data: { error: `Auto-commit failed: ${message}`, fatal: false },
          timestamp: new Date().toISOString(),
        });
      }
    }

    if (msgConfig.condenseOnComplete) {
      const expectCompletion = () => {
        postProcessingCompleted = false;
        postProcessingResolve = null;
      };
      const waitForCompletion = (): Promise<void> => {
        if (postProcessingCompleted) return Promise.resolve();
        return new Promise(resolve => {
          postProcessingResolve = resolve;
        });
      };
      try {
        await runCondenseOnComplete({
          workspacePath: config.workspacePath,
          kiloSessionId: session.kiloSessionId,
          model: msgConfig.model,
          onEvent: event => state.sendToIngest(event),
          kiloClient,
          expectCompletion,
          waitForCompletion,
          wasAborted: () => isAborted,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.sendToIngest({
          streamEventType: 'error',
          data: { error: `Condense failed: ${message}`, fatal: false },
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  async function finalizeDrain(
    drainGeneration: number,
    completeSession: typeof state.currentSession | undefined,
    sealedMessageIds: string[]
  ): Promise<void> {
    if (drainGeneration !== lifecycleGeneration) return;
    const currentSession = state.currentSession;
    if (completeSession && currentSession) {
      const currentBranch = await getCurrentBranch(config.workspacePath, 10_000).catch(() => '');
      if (drainGeneration !== lifecycleGeneration) return;
      if (!isAborted) {
        const gateResult = state.consumeObservedGateResult();
        state.sendToIngest({
          streamEventType: 'complete',
          data: {
            exitCode: 0,
            kiloSessionId: currentSession.kiloSessionId,
            messageIds: sealedMessageIds,
            ...(currentBranch ? { currentBranch } : {}),
            ...(gateResult ? { gateResult } : {}),
          },
          timestamp: new Date().toISOString(),
        });
      }
    }

    await new Promise<void>(resolve => setTimeout(resolve, DRAIN_DELAY_MS));
    if (drainGeneration !== lifecycleGeneration) return;
    await deps
      .closeConnections()
      .catch(error =>
        logToFile(`close failed: ${error instanceof Error ? error.message : String(error)}`)
      );
    if (drainGeneration === lifecycleGeneration) state.clearSession();
  }

  function drainAndClose(): Promise<void> {
    state.blockAdmissions();
    if (drainPromise) return drainPromise;
    const drainGeneration = lifecycleGeneration;
    resetDrainState();
    idleHint = false;
    idleObservedDuringDelivery = false;
    clearSseTransportTimer();
    const sealedMessageIds = state.pendingMessageIds;
    const session = state.currentSession;
    // Capture before post-processing. SSE timeout / ingest disconnect can set
    // aborted during auto-commit; a sealed idle batch must still complete.
    const completeSession = !isAborted ? session : undefined;

    if (completeSession) {
      state.sendToIngest({
        streamEventType: 'wrapper_finalizing',
        data: { wrapperRunId: completeSession.wrapperRunId },
        timestamp: new Date().toISOString(),
      });
    }

    drainPromise = (async () => {
      try {
        await runPostCompletionTasks();
        const uploader = state.logUploader;
        if (uploader) {
          try {
            await uploader.uploadNow();
          } catch (error) {
            logToFile(
              `final log upload failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
          uploader.stop();
        }
      } finally {
        await finalizeDrain(drainGeneration, completeSession, sealedMessageIds);
      }
    })();
    const currentDrain = drainPromise;
    void currentDrain.then(
      () => {
        if (drainPromise === currentDrain) drainPromise = null;
      },
      () => {
        if (drainPromise === currentDrain) drainPromise = null;
      }
    );
    return currentDrain;
  }

  function triggerDrainAndClose(): void {
    void drainAndClose();
  }

  function startDrainWait(): void {
    if (isAborted || drainPromise || pendingDrainFailure !== null) return;
    if (!state.hasPendingMessages) return;
    if (!state.currentSession) return;
    if (state.deliveryAcknowledgementsInFlight > 0) return;
    if (drainSucceededWhileAckingEpoch !== null || drainReadyWhileDisconnected) return;
    if (drainWaiter.active) return;
    const epoch = ++drainEpoch;
    void drainWaiter.start().then(result => {
      if (epoch !== drainEpoch) return;
      if (result.state === 'drained') {
        handleDrainTrue(epoch);
        return;
      }
      if (result.state === 'failed') {
        if (result.exhaustedTransient) {
          logToFile(`drain-transient-limit: ${result.reason}`);
        }
        failDrain(epoch, result.reason);
      }
    });
  }

  function handleDrainTrue(epoch: number): void {
    if (state.deliveryAcknowledgementsInFlight > 0) {
      drainSucceededWhileAckingEpoch = epoch;
      return;
    }
    sealDrainSuccess(epoch);
  }

  function sealDrainSuccess(epoch: number = drainEpoch): void {
    if (epoch !== drainEpoch) return;
    if (isAborted || drainPromise) return;
    if (state.deliveryAcknowledgementsInFlight > 0) return;
    if (!state.hasPendingMessages) return;
    if (!deps.isConnected()) {
      drainReadyWhileDisconnected = true;
      return;
    }
    if (!state.beginFinalizing()) return;
    drainSucceededWhileAckingEpoch = null;
    drainReadyWhileDisconnected = false;
    triggerDrainAndClose();
  }

  function failDrain(epoch: number, reason: string): void {
    if (epoch !== drainEpoch) return;
    if (isAborted) return;
    resetDrainState();

    const sessionId = state.currentSession?.kiloSessionId;
    if (sessionId) {
      void kiloClient.abortSession({ sessionId }).catch(() => {});
    }

    if (!deps.isConnected()) {
      pendingDrainFailure = reason;
      return;
    }

    state.sendToIngest({
      streamEventType: 'error',
      data: { error: reason, fatal: true },
      timestamp: new Date().toISOString(),
    });
    markAborted();
    triggerDrainAndClose();
  }

  return {
    start: () => logToFile('lifecycle started (transport timer is event-driven)'),
    stop: () => {
      isAborted = true;
      clearSseTransportTimer();
      abortDrain();
    },
    onSessionIdle: () => {
      if (isAborted || state.isFinalizing || drainPromise) return;
      if (!state.hasPendingMessages || pendingDrainFailure !== null) return;
      idleHint = true;
      if (state.deliveryAcknowledgementsInFlight > 0) {
        idleObservedDuringDelivery = true;
        return;
      }
      if (drainWaiter.active) return;
      if (drainSucceededWhileAckingEpoch !== null || drainReadyWhileDisconnected) return;
      startDrainWait();
    },
    onRootSessionActivity: () => {
      resetDrainState();
      idleHint = false;
      idleObservedDuringDelivery = false;
    },
    onDeliveryAcknowledged: kind => {
      if (kind === 'async-prompt') {
        resetDrainState();
        if (!idleObservedDuringDelivery) {
          idleHint = false;
          return;
        }
        if (state.deliveryAcknowledgementsInFlight > 0) return;
        idleObservedDuringDelivery = false;
        startDrainWait();
        return;
      }
      if (kind === 'sync-command') {
        resetDrainState();
        idleHint = true;
        if (state.deliveryAcknowledgementsInFlight > 0) return;
        idleObservedDuringDelivery = false;
        startDrainWait();
        return;
      }
      if (state.deliveryAcknowledgementsInFlight > 0) return;
      idleObservedDuringDelivery = false;
      if (drainSucceededWhileAckingEpoch !== null || drainReadyWhileDisconnected) {
        sealDrainSuccess();
        return;
      }
      if (idleHint && !drainWaiter.active) startDrainWait();
    },
    onConnectionRestored: () => {
      if (pendingDrainFailure !== null) {
        const reason = pendingDrainFailure;
        pendingDrainFailure = null;
        state.sendToIngest({
          streamEventType: 'error',
          data: { error: reason, fatal: true },
          timestamp: new Date().toISOString(),
        });
        markAborted();
        triggerDrainAndClose();
        return;
      }
      if (drainReadyWhileDisconnected) {
        sealDrainSuccess();
        return;
      }
      if (drainSucceededWhileAckingEpoch !== null) return;
      if (idleHint && !drainWaiter.active && state.deliveryAcknowledgementsInFlight === 0) {
        startDrainWait();
      }
    },
    triggerDrainAndClose,
    drainAndClose,
    signalCompletion,
    setAborted: markAborted,
    reset: () => {
      lifecycleGeneration += 1;
      isAborted = false;
      abortDrain();
      postProcessingCompleted = false;
      postProcessingResolve = null;
      clearSseTransportTimer();
      drainPromise = null;
    },
    onSseEvent: resetSseTransportTimer,
  };
}
