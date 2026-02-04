/**
 * Lifecycle management for the long-running wrapper.
 *
 * Handles:
 * - Inflight expiry (per-message timeout)
 * - Idle timeout (session-level cleanup)
 * - Drain period (grace period before closing connections)
 * - Auto-commit and condense on completion
 */

import type { WrapperState } from './state.js';
import type { KiloClient } from './kilo-client.js';
import type { ConnectionManager } from './connection.js';
import { runAutoCommit } from './auto-commit.js';
import { runCondenseOnComplete } from './condense-on-complete.js';
import { logToFile } from './utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Interval for checking inflight expiry (5 seconds) */
const INFLIGHT_CHECK_INTERVAL_MS = 5_000;

/** Interval for checking idle timeout (10 seconds) */
const IDLE_CHECK_INTERVAL_MS = 10_000;

/** Grace period before closing connections after inflight hits 0 (250ms) */
const DRAIN_DELAY_MS = 250;

/** Default per-message timeout if MAX_RUNTIME_MS not set (20 minutes) */
export const DEFAULT_INFLIGHT_TIMEOUT_MS = 1_200_000;

/** Default idle timeout if IDLE_TIMEOUT_MS not set (2 minutes) */
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

/** SSE inactivity timeout - if no SSE events for this long while active, assume broken (2 minutes) */
const SSE_INACTIVITY_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LifecycleConfig = {
  /** Per-message deadline timeout (from MAX_RUNTIME_MS env var) */
  maxRuntimeMs: number;
  /** Session-level idle timeout (from IDLE_TIMEOUT_MS env var) */
  idleTimeoutMs: number;
  /** Enable auto-commit on completion */
  autoCommit: boolean;
  /** Enable condense on completion */
  condenseOnComplete: boolean;
  /** Workspace path for auto-commit/condense */
  workspacePath: string;
  /** Upstream branch for auto-commit */
  upstreamBranch?: string;
  /** Model for auto-commit/condense */
  model?: string;
};

export type LifecycleDependencies = {
  state: WrapperState;
  kiloClient: KiloClient;
  connectionManager: ConnectionManager;
};

export type LifecycleManager = {
  /** Start lifecycle timers */
  start: () => void;
  /** Stop lifecycle timers */
  stop: () => void;
  /** Called when a message completes - checks if inflight is empty */
  onMessageComplete: (messageId: string) => void;
  /** Called to trigger drain and close sequence */
  triggerDrainAndClose: () => void;
  /** Get the max runtime in ms */
  getMaxRuntimeMs: () => number;
  /** Signal completion for post-processing waiters (called by connection on completion events) */
  signalCompletion: () => void;
  /** Set the aborted flag to prevent post-completion tasks from running */
  setAborted: () => void;
};

// ---------------------------------------------------------------------------
// Lifecycle Manager
// ---------------------------------------------------------------------------

export function createLifecycleManager(
  config: LifecycleConfig,
  deps: LifecycleDependencies
): LifecycleManager {
  const { state, kiloClient, connectionManager } = deps;

  let inflightCheckInterval: ReturnType<typeof setInterval> | null = null;
  let idleCheckInterval: ReturnType<typeof setInterval> | null = null;
  let drainTimeout: ReturnType<typeof setTimeout> | null = null;
  let isDraining = false;
  let isAborted = false;

  // Completion waiter for post-processing tasks (auto-commit, condense)
  let postProcessingResolve: (() => void) | null = null;
  let postProcessingCompleted = false;

  /**
   * Check for expired inflight entries and handle timeouts.
   */
  function checkInflightExpiry(): void {
    const now = Date.now();
    const expired = state.getExpiredInflight(now);

    for (const entry of expired) {
      logToFile(`inflight timeout: messageId=${entry.messageId}`);

      // Send timeout error event to ingest
      state.sendToIngest({
        streamEventType: 'error',
        data: {
          error: `Prompt ${entry.messageId} timed out after ${(now - entry.startedAt) / 1000}s`,
          fatal: false,
          code: 'INFLIGHT_TIMEOUT',
          messageId: entry.messageId,
        },
        timestamp: new Date().toISOString(),
      });

      // Cache error in state
      state.setLastError({
        code: 'INFLIGHT_TIMEOUT',
        messageId: entry.messageId,
        message: `Prompt timed out after ${(now - entry.startedAt) / 1000}s`,
        timestamp: now,
      });

      // Remove from inflight
      state.removeInflight(entry.messageId);
    }

    // Check if inflight is now empty
    if (state.isIdle && connectionManager.isConnected()) {
      triggerDrainAndClose();
    }
  }

  /**
   * Check for idle timeout and cleanup stale job context.
   */
  function checkIdleTimeout(): void {
    // Only check when has job context
    if (!state.hasJob) return;

    const now = Date.now();

    // Check SSE inactivity while active (inflight > 0)
    // If we have inflight prompts but SSE has gone silent, something is broken
    if (state.isActive && connectionManager.isConnected()) {
      const sseInactivityMs = state.getSseInactivityMs(now);

      // Only check if we've ever received SSE events (give initial connection time)
      if (sseInactivityMs !== null && sseInactivityMs >= SSE_INACTIVITY_TIMEOUT_MS) {
        logToFile(
          `SSE inactivity timeout: no events for ${sseInactivityMs / 1000}s while ${state.inflightCount} prompts inflight`
        );

        // Send error event
        state.sendToIngest({
          streamEventType: 'error',
          data: {
            error: `SSE stream inactive for ${sseInactivityMs / 1000}s - assuming connection broken`,
            fatal: true,
            code: 'SSE_INACTIVITY_TIMEOUT',
          },
          timestamp: new Date().toISOString(),
        });

        // Cache error
        state.setLastError({
          code: 'SSE_INACTIVITY_TIMEOUT',
          message: `SSE stream inactive for ${sseInactivityMs / 1000}s`,
          timestamp: now,
        });

        // Abort kilo session
        const job = state.currentJob;
        if (job) {
          kiloClient.abortSession({ sessionId: job.kiloSessionId }).catch(() => {});
        }

        // Mark as aborted so we don't send 'complete' event, then close
        isAborted = true;
        state.clearAllInflight();
        triggerDrainAndClose();
        return;
      }

      // Also check if we've been waiting too long for initial SSE events
      // after connection was established (give 30 seconds for first event)
      if (!state.hasSseActivity()) {
        const idleMs = state.getIdleMs(now);
        const SSE_INITIAL_TIMEOUT_MS = 30_000;
        if (idleMs >= SSE_INITIAL_TIMEOUT_MS) {
          logToFile(
            `SSE initial timeout: no events received within ${idleMs / 1000}s of connection`
          );

          state.sendToIngest({
            streamEventType: 'error',
            data: {
              error: `No SSE events received within ${idleMs / 1000}s - assuming connection broken`,
              fatal: true,
              code: 'SSE_INITIAL_TIMEOUT',
            },
            timestamp: new Date().toISOString(),
          });

          state.setLastError({
            code: 'SSE_INITIAL_TIMEOUT',
            message: `No SSE events received within ${idleMs / 1000}s`,
            timestamp: now,
          });

          const job = state.currentJob;
          if (job) {
            kiloClient.abortSession({ sessionId: job.kiloSessionId }).catch(() => {});
          }

          // Mark as aborted so we don't send 'complete' event, then close
          isAborted = true;
          state.clearAllInflight();
          triggerDrainAndClose();
          return;
        }
      }
    }

    // Check idle timeout when not active (inflight == 0)
    if (state.isIdle) {
      const idleMs = state.getIdleMs(now);

      if (idleMs >= config.idleTimeoutMs) {
        logToFile(`idle timeout: ${idleMs / 1000}s`);

        // Send idle timeout event if connected
        if (connectionManager.isConnected()) {
          state.sendToIngest({
            streamEventType: 'error',
            data: {
              error: `Session idle for ${idleMs / 1000}s`,
              fatal: false,
              code: 'IDLE_TIMEOUT',
            },
            timestamp: new Date().toISOString(),
          });
        }

        // Cache error in state
        state.setLastError({
          code: 'IDLE_TIMEOUT',
          message: `Session idle for ${idleMs / 1000}s`,
          timestamp: now,
        });

        // Close connection and clear job
        void connectionManager.close();
        state.clearJob();
      }
    }
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

    // Use the shared completion state for waiting on post-processing commands
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

    // Run auto-commit if enabled
    if (config.autoCommit) {
      logToFile('running auto-commit');
      try {
        await runAutoCommit({
          workspacePath: config.workspacePath,
          upstreamBranch: config.upstreamBranch,
          model: config.model,
          onEvent: event => state.sendToIngest(event),
          kiloClient,
          kiloSessionId: job.kiloSessionId,
          expectCompletion,
          waitForCompletion,
          wasAborted,
        });
        logToFile('auto-commit complete');
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

    // Run condense if enabled
    if (config.condenseOnComplete) {
      logToFile('running condense');
      try {
        await runCondenseOnComplete({
          workspacePath: config.workspacePath,
          kiloSessionId: job.kiloSessionId,
          model: config.model,
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
   * Sends complete event (unless aborted), runs post-completion tasks, then closes after drain delay.
   */
  function triggerDrainAndClose(): void {
    if (isDraining) return;
    isDraining = true;

    logToFile(`starting drain period (isAborted=${isAborted})`);

    // Send complete event to ingest so DO can update execution status and trigger callbacks
    // BUT only if not aborted - fatal errors already sent their own terminal event
    const job = state.currentJob;
    if (job && !isAborted) {
      logToFile(`sending complete event for executionId=${job.executionId}`);
      state.sendToIngest({
        streamEventType: 'complete',
        data: {
          exitCode: 0,
          executionId: job.executionId,
          kiloSessionId: job.kiloSessionId,
        },
        timestamp: new Date().toISOString(),
      });
    } else if (job && isAborted) {
      logToFile(`skipping complete event - execution was aborted`);
    }

    // Run post-completion tasks, then drain and close
    runPostCompletionTasks()
      .catch(err =>
        logToFile(
          `post-completion tasks failed: ${err instanceof Error ? err.message : String(err)}`
        )
      )
      .finally(() => {
        drainTimeout = setTimeout(() => {
          logToFile('drain complete, closing connections');
          connectionManager
            .close()
            .catch(err =>
              logToFile(`close failed: ${err instanceof Error ? err.message : String(err)}`)
            )
            .finally(() => {
              isDraining = false;
              drainTimeout = null;
            });
        }, DRAIN_DELAY_MS);
      });
  }

  /**
   * Handle message completion.
   */
  function onMessageComplete(messageId: string): void {
    const removed = state.removeInflight(messageId);
    if (!removed) {
      logToFile(`completion for unknown messageId=${messageId}`);
      return;
    }

    logToFile(`message complete: messageId=${messageId} remaining=${state.inflightCount}`);

    // Check if all inflight are done
    if (state.isIdle && connectionManager.isConnected()) {
      triggerDrainAndClose();
    }
  }

  return {
    start: () => {
      logToFile('starting lifecycle timers');
      inflightCheckInterval = setInterval(checkInflightExpiry, INFLIGHT_CHECK_INTERVAL_MS);
      idleCheckInterval = setInterval(checkIdleTimeout, IDLE_CHECK_INTERVAL_MS);
    },

    stop: () => {
      logToFile('stopping lifecycle timers');
      isAborted = true;

      if (inflightCheckInterval) {
        clearInterval(inflightCheckInterval);
        inflightCheckInterval = null;
      }

      if (idleCheckInterval) {
        clearInterval(idleCheckInterval);
        idleCheckInterval = null;
      }

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
      logToFile('abort flag set - post-completion tasks will be skipped');
    },

    getMaxRuntimeMs: () => config.maxRuntimeMs,
  };
}
