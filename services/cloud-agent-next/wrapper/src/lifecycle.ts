/**
 * Lifecycle management for the long-running wrapper.
 *
 * Handles:
 * - SSE transport timer (15s reconnect on inactivity)
 * - Drain period (grace period before closing connections)
 * - Auto-commit and condense on completion
 */

import type { WrapperState } from './state.js';
import type { WrapperKiloClient } from './kilo-api.js';
import { runAutoCommit } from './auto-commit.js';
import { runCondenseOnComplete } from './condense-on-complete.js';
import { getCurrentBranch, logToFile } from './utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Grace period before closing connections after inflight hits 0 (250ms) */
const DRAIN_DELAY_MS = 250;

/** If no SSE event arrives within this window, reconnect the event subscription (15s) */
const SSE_TRANSPORT_TIMEOUT_MS = 15_000;

/** Overall timeout for auto-commit operation (2 minutes) */
const AUTO_COMMIT_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LifecycleConfig = {
  /** Workspace path for auto-commit/condense (session-stable) */
  workspacePath: string;
};

/**
 * Per-turn options set by the prompt handler.
 * These override defaults for the current turn and are consumed
 * when session.idle fires (auto-commit, condense, timeout).
 */
export type PerTurnConfig = {
  autoCommit: boolean;
  condenseOnComplete: boolean;
  model?: string;
  upstreamBranch?: string;
};

export type LifecycleDependencies = {
  state: WrapperState;
  kiloClient: WrapperKiloClient;
  /** Close all connections (ingest WS + event subscription) */
  closeConnections: () => Promise<void>;
  /** Check if ingest WS is currently connected */
  isConnected: () => boolean;
  /** Abort and restart the SDK event subscription */
  reconnectEventSubscription: () => void;
};

export type LifecycleManager = {
  /** Start lifecycle monitoring */
  start: () => void;
  /** Stop lifecycle monitoring */
  stop: () => void;
  /** Called when a message completes - checks if idle */
  onMessageComplete: (messageId: string) => void;
  /** Called to trigger drain and close sequence */
  triggerDrainAndClose: () => void;
  /** Signal completion for post-processing waiters (called by connection on completion events) */
  signalCompletion: () => void;
  /** Set the aborted flag to prevent post-completion tasks from running */
  setAborted: () => void;
  /** Reset lifecycle state for a new execution (clears isAborted, isDraining, etc.) */
  reset: () => void;
  /** Set per-turn config (called by prompt handler before each turn) */
  setPerTurnConfig: (turnConfig: PerTurnConfig) => void;
  /** Called by connection manager on every SSE event to reset the transport timer */
  onSseEvent: () => void;
};

// ---------------------------------------------------------------------------
// Lifecycle Manager
// ---------------------------------------------------------------------------

export function createLifecycleManager(
  config: LifecycleConfig,
  deps: LifecycleDependencies
): LifecycleManager {
  const { state, kiloClient } = deps;

  let sseTransportTimer: ReturnType<typeof setTimeout> | null = null;
  let drainTimeout: ReturnType<typeof setTimeout> | null = null;
  let isDraining = false;
  let isAborted = false;

  // Per-turn config, set by the prompt handler before each turn
  let perTurn: PerTurnConfig = {
    autoCommit: false,
    condenseOnComplete: false,
  };

  // Completion waiter for post-processing tasks (auto-commit, condense)
  let postProcessingResolve: (() => void) | null = null;
  let postProcessingCompleted = false;

  function clearSseTransportTimer(): void {
    if (sseTransportTimer) {
      clearTimeout(sseTransportTimer);
      sseTransportTimer = null;
    }
  }

  function resetSseTransportTimer(): void {
    clearSseTransportTimer();
    if (!state.hasJob) return;
    sseTransportTimer = setTimeout(() => {
      logToFile('SSE transport timeout — reconnecting event subscription');
      deps.reconnectEventSubscription();
    }, SSE_TRANSPORT_TIMEOUT_MS);
  }

  /**
   * Signal that a completion event was received (called by connection manager).
   * This resolves any pending waitForCompletion() promises used by post-processing tasks.
   */
  function signalCompletion(): void {
    postProcessingCompleted = true;
    if (postProcessingResolve) {
      postProcessingResolve();
      postProcessingResolve = null;
    }
  }

  /**
   * Run post-completion tasks (auto-commit, condense).
   */
  async function runPostCompletionTasks(): Promise<void> {
    const job = state.currentJob;
    if (!job) return;

    // Skip post-completion tasks when aborted — the execution already failed
    // (e.g. disconnect, fatal error) so auto-commit/condense on partial work is unsafe
    if (isAborted) {
      logToFile('skipping post-completion tasks — execution was aborted');
      return;
    }

    // Run auto-commit if enabled
    if (perTurn.autoCommit) {
      logToFile('running auto-commit');
      try {
        const autoCommitController = new AbortController();
        let autoCommitTimedOut = false;
        const timeout = setTimeout(() => {
          autoCommitTimedOut = true;
          logToFile('auto-commit lifecycle timeout reached; aborting in-flight work');
          autoCommitController.abort();
        }, AUTO_COMMIT_TIMEOUT_MS);
        const result = await runAutoCommit({
          workspacePath: config.workspacePath,
          onEvent: event => state.sendToIngest(event),
          kiloClient,
          messageId: state.lastAssistantMessageId ?? undefined,
          upstreamBranch: perTurn.upstreamBranch,
          signal: autoCommitController.signal,
        }).finally(() => clearTimeout(timeout));
        if (autoCommitTimedOut && !result.success) {
          logToFile('auto-commit aborted by lifecycle timeout');
          state.sendToIngest({
            streamEventType: 'error',
            data: { error: 'Auto-commit timed out', fatal: false },
            timestamp: new Date().toISOString(),
          });
        } else {
          logToFile(
            `auto-commit complete: success=${result.success} skipped=${result.skipped ?? false} error=${result.error ?? '(none)'}`
          );
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logToFile(`auto-commit error: ${msg}`);
        state.sendToIngest({
          streamEventType: 'error',
          data: { error: `Auto-commit failed: ${msg}`, fatal: false },
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Completion/abort helpers are only needed for condense (which still uses the prompt-based approach)
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

    const wasAborted = () => isAborted;

    // Run condense if enabled
    if (perTurn.condenseOnComplete) {
      logToFile('running condense');
      try {
        await runCondenseOnComplete({
          workspacePath: config.workspacePath,
          kiloSessionId: job.kiloSessionId,
          model: perTurn.model,
          onEvent: event => state.sendToIngest(event),
          kiloClient,
          expectCompletion,
          waitForCompletion,
          wasAborted,
        });
        logToFile('condense complete');
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logToFile(`condense error: ${msg}`);
        state.sendToIngest({
          streamEventType: 'error',
          data: { error: `Condense failed: ${msg}`, fatal: false },
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  /**
   * Trigger drain period and close connections.
   * Runs post-completion tasks (auto-commit, condense), sends complete event, then closes after drain delay.
   */
  function triggerDrainAndClose(): void {
    if (isDraining) return;
    isDraining = true;

    logToFile(`starting drain period (isAborted=${isAborted})`);

    // Run the full drain sequence as a single async flow.
    // Order matters: post-completion tasks (autocommit/condense) → log upload →
    // complete event → drain delay → close connections.
    void (async () => {
      try {
        // 1. Post-completion tasks (auto-commit, condense)
        try {
          await runPostCompletionTasks();
        } catch (err) {
          logToFile(
            `post-completion tasks failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }

        // 2. Final log upload
        const uploader = state.logUploader;
        if (uploader) {
          try {
            await uploader.uploadNow();
          } catch (err) {
            logToFile(
              `final log upload failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
          uploader.stop();
        }
      } finally {
        // 3. Send complete event (always runs, even if upload/post-processing failed)
        const job = state.currentJob;
        if (job && !isAborted) {
          const currentBranch = await getCurrentBranch(config.workspacePath, 10_000).catch(
            () => ''
          );
          logToFile(
            `sending complete event for executionId=${job.executionId} branch=${currentBranch || '(none)'}`
          );
          state.sendToIngest({
            streamEventType: 'complete',
            data: {
              exitCode: 0,
              executionId: job.executionId,
              kiloSessionId: job.kiloSessionId,
              ...(currentBranch ? { currentBranch } : {}),
            },
            timestamp: new Date().toISOString(),
          });
        } else if (job && isAborted) {
          logToFile('skipping complete event — execution was aborted');
        }

        // 4. Drain delay, then close connections
        drainTimeout = setTimeout(() => {
          logToFile('drain complete, closing connections');
          deps
            .closeConnections()
            .catch(err =>
              logToFile(`close failed: ${err instanceof Error ? err.message : String(err)}`)
            )
            .finally(() => {
              isDraining = false;
              drainTimeout = null;
            });
        }, DRAIN_DELAY_MS);
      }
    })();
  }

  /**
   * Handle message completion.
   */
  function onMessageComplete(messageId: string): void {
    logToFile(`message complete: messageId=${messageId}`);
    state.setActive(false);

    if (state.isIdle && deps.isConnected()) {
      triggerDrainAndClose();
    }
  }

  return {
    start: () => {
      logToFile('lifecycle started (transport timer is event-driven)');
    },

    stop: () => {
      logToFile('stopping lifecycle');
      isAborted = true;
      clearSseTransportTimer();

      if (drainTimeout) {
        clearTimeout(drainTimeout);
        drainTimeout = null;
      }
    },

    onMessageComplete,
    triggerDrainAndClose,
    signalCompletion,

    setAborted: () => {
      isAborted = true;
    },

    setPerTurnConfig: (turnConfig: PerTurnConfig) => {
      perTurn = turnConfig;
    },

    reset: () => {
      isAborted = false;
      isDraining = false;
      postProcessingCompleted = false;
      postProcessingResolve = null;
      clearSseTransportTimer();
      if (drainTimeout) {
        clearTimeout(drainTimeout);
        drainTimeout = null;
      }
    },

    onSseEvent: () => {
      resetSseTransportTimer();
    },
  };
}
