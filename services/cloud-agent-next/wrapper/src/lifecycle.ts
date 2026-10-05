import type { WrapperState } from './state.js';
import type { WrapperKiloClient } from './kilo-api.js';
import { runAutoCommit } from './auto-commit.js';
import { runCondenseOnComplete } from './condense-on-complete.js';
import { getCurrentBranch, logToFile } from './utils.js';
import {
  decidePublicationRecovery,
  PUBLICATION_RECOVERY_PROMPT,
} from './publication-recovery.js';

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
  /** True only when the runtime config hook installed the publication tool. */
  isGitHubReviewPublicationInstalled: () => boolean;
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
  resetPublicationRecoveryBudget: () => void;
  onSseEvent: () => void;
};

export function createLifecycleManager(
  config: LifecycleConfig,
  deps: LifecycleDependencies
): LifecycleManager {
  const { state, kiloClient } = deps;
  let sseTransportTimer: ReturnType<typeof setTimeout> | null = null;
  let stableIdleTimer: ReturnType<typeof setTimeout> | null = null;
  let isAborted = false;
  let rootIdleCandidatePresent = false;
  let idleObservedDuringDelivery = false;
  let postProcessingResolve: (() => void) | null = null;
  let drainPromise: Promise<void> | null = null;
  let lifecycleGeneration = 0;
  let postProcessingCompleted = false;
  let publicationRecoveryBudgetUsed = false;
  let publicationRecoveryInFlight = false;
  let publicationRecoveryArmId = 0;
  let publicationRecoverySubmitController: AbortController | null = null;

  type PublicationRecoveryPromptOutcome = 'delivered' | 'failed' | 'superseded';

  /**
   * Invalidates the current recovery arm before aborting its submit, so the
   * arm's catch can no longer emit an error, abort a session, or finalize on
   * behalf of a superseded recovery. It does not touch the per-batch budget:
   * a new admitted batch resets that separately.
   */
  function supersedePublicationRecovery(): void {
    publicationRecoveryArmId += 1;
    publicationRecoverySubmitController?.abort();
    publicationRecoverySubmitController = null;
  }

  function clearSseTransportTimer(): void {
    if (!sseTransportTimer) return;
    clearTimeout(sseTransportTimer);
    sseTransportTimer = null;
  }

  function clearStableIdleCandidate(): void {
    rootIdleCandidatePresent = false;
    idleObservedDuringDelivery = false;
    if (!stableIdleTimer) return;
    clearTimeout(stableIdleTimer);
    stableIdleTimer = null;
  }

  function resetSseTransportTimer(): void {
    clearSseTransportTimer();
    // Idle is the last expected SSE event. Reconnecting during drain races
    // auto-commit and used to abort the complete event.
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
    clearStableIdleCandidate();
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

  async function abortSessionBounded(sessionId: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      await deps.kiloClient.abortSession({
        sessionId,
        directory: config.workspacePath,
        signal: controller.signal,
      });
    } catch (error) {
      logToFile(
        `publication recovery abort failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  function emitPublicationRecoveryError(message: string): void {
    state.sendToIngest({
      streamEventType: 'error',
      data: { error: message, fatal: false },
      timestamp: new Date().toISOString(),
    });
  }

  async function promptForPublication(): Promise<PublicationRecoveryPromptOutcome> {
    const session = state.currentSession;
    if (!session) return 'failed';
    const controller = new AbortController();
    publicationRecoverySubmitController = controller;
    const armId = publicationRecoveryArmId + 1;
    publicationRecoveryArmId = armId;
    const isCurrentArm = () => publicationRecoveryArmId === armId;
    try {
      await deps.kiloClient.sendPromptAsync({
        sessionId: session.kiloSessionId,
        // Kilo rejects a message id without its `msg` prefix (400), so the
        // synthetic recovery turn must use the same convention as admissions.
        messageId: `msg_recovery_${crypto.randomUUID()}`,
        prompt: PUBLICATION_RECOVERY_PROMPT,
        directory: config.workspacePath,
        signal: controller.signal,
      });
      logToFile('publication check: prompt sent');
      return 'delivered';
    } catch (error) {
      if (!isCurrentArm()) {
        // Superseded by reset or a new admitted batch before/while aborting the
        // submit: never emit or abort a session on a stale arm's behalf.
        return 'superseded';
      }
      logToFile(
        `publication check: send failed${error instanceof Error ? `: ${error.message}` : ''}`
      );
      emitPublicationRecoveryError('Failed to send publication recovery prompt');
      await abortSessionBounded(session.kiloSessionId);
      // A reset or new admitted batch can supersede during the bounded abort;
      // never seal the new batch from a stale arm.
      return isCurrentArm() ? 'failed' : 'superseded';
    } finally {
      if (publicationRecoverySubmitController === controller) {
        publicationRecoverySubmitController = null;
      }
    }
  }

  async function settleIdleBatch(): Promise<void> {
    if (publicationRecoveryInFlight) return;
    const decision = decidePublicationRecovery({
      configured: deps.isGitHubReviewPublicationInstalled(),
      outputLimit: state.consumeAssistantOutputLimit(),
      signal: state.consumePublicationSignal(),
      budgetUsed: publicationRecoveryBudgetUsed,
    });
    if (decision === 'prompt' && rootIdleCandidatePresent && deps.isConnected()) {
      publicationRecoveryBudgetUsed = true;
      publicationRecoveryInFlight = true;
      let outcome: PublicationRecoveryPromptOutcome;
      try {
        outcome = await promptForPublication();
      } finally {
        publicationRecoveryInFlight = false;
      }
      // A superseded arm must not finalize here; the new batch owns it.
      if (outcome === 'superseded') return;
      if (outcome === 'delivered' && deps.isConnected()) return;
    }
    if (state.beginFinalizing()) {
      triggerDrainAndClose();
    }
  }

  function trySealIdleBatch(): void {
    stableIdleTimer = null;
    if (!rootIdleCandidatePresent || state.deliveryAcknowledgementsInFlight > 0) {
      return;
    }
    if (!deps.isConnected()) {
      armStableIdleCandidate();
      return;
    }
    void settleIdleBatch();
  }

  function armStableIdleCandidate(): void {
    if (!rootIdleCandidatePresent || stableIdleTimer || !state.hasPendingMessages) return;
    stableIdleTimer = setTimeout(trySealIdleBatch, STABLE_ROOT_IDLE_MS);
  }

  function restartStableIdleCandidate(): void {
    if (stableIdleTimer) clearTimeout(stableIdleTimer);
    stableIdleTimer = null;
    armStableIdleCandidate();
  }

  return {
    start: () => logToFile('lifecycle started (transport timer is event-driven)'),
    stop: () => {
      isAborted = true;
      clearSseTransportTimer();
      clearStableIdleCandidate();
      supersedePublicationRecovery();
    },
    onSessionIdle: () => {
      rootIdleCandidatePresent = true;
      if (state.deliveryAcknowledgementsInFlight > 0) idleObservedDuringDelivery = true;
      armStableIdleCandidate();
    },
    onRootSessionActivity: clearStableIdleCandidate,
    onDeliveryAcknowledged: kind => {
      if (kind === 'async-prompt') {
        if (!idleObservedDuringDelivery) {
          clearStableIdleCandidate();
          return;
        }
        if (state.deliveryAcknowledgementsInFlight > 0) return;
        idleObservedDuringDelivery = false;
        restartStableIdleCandidate();
        return;
      }
      if (state.deliveryAcknowledgementsInFlight === 0) idleObservedDuringDelivery = false;
      if (kind === 'sync-command') {
        rootIdleCandidatePresent = true;
      }
      armStableIdleCandidate();
    },
    onConnectionRestored: armStableIdleCandidate,
    triggerDrainAndClose,
    drainAndClose,
    signalCompletion,
    setAborted: () => {
      isAborted = true;
      state.blockAdmissions();
      clearStableIdleCandidate();
      supersedePublicationRecovery();
    },
    reset: () => {
      lifecycleGeneration += 1;
      isAborted = false;
      clearStableIdleCandidate();
      postProcessingCompleted = false;
      postProcessingResolve = null;
      clearSseTransportTimer();
      supersedePublicationRecovery();
      publicationRecoveryBudgetUsed = false;
      publicationRecoveryInFlight = false;
      state.clearAssistantOutputLimit();
      drainPromise = null;
    },
    resetPublicationRecoveryBudget: () => {
      supersedePublicationRecovery();
      publicationRecoveryBudgetUsed = false;
      state.clearAssistantOutputLimit();
    },
    onSseEvent: resetSseTransportTimer,
  };
}
