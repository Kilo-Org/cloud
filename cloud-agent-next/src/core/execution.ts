/**
 * Execution state machine for the cloud-agent system.
 *
 * This module contains pure business logic for managing execution states.
 * No side effects or dependencies - just state transition validation.
 */

import { STALE_THRESHOLD_MS } from './lease.js';

// ---------------------------------------------------------------------------
// Execution Status
// ---------------------------------------------------------------------------

/** Possible states of an execution */
export type ExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';

/** Health status for active executions */
export type ExecutionHealth = 'healthy' | 'stale' | 'unknown';

// ---------------------------------------------------------------------------
// State Machine
// ---------------------------------------------------------------------------

/**
 * Valid state transitions for executions.
 * Maps each status to the list of statuses it can transition to.
 */
const VALID_TRANSITIONS: Record<ExecutionStatus, ExecutionStatus[]> = {
  pending: ['running', 'failed'], // Allow failed for expired queue entries
  running: ['completed', 'failed', 'interrupted'],
  completed: [],
  failed: [],
  interrupted: [],
};

/**
 * Check if a state transition is valid.
 *
 * @param from - Current execution status
 * @param to - Target execution status
 * @returns true if the transition is allowed
 */
export function canTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/**
 * Check if a status is terminal (no more transitions possible).
 * Terminal statuses: completed, failed, interrupted
 *
 * @param status - Status to check
 * @returns true if no transitions are possible from this status
 */
export function isTerminal(status: ExecutionStatus): boolean {
  return VALID_TRANSITIONS[status].length === 0;
}

/**
 * Get the list of statuses that can be transitioned to from the given status.
 *
 * @param status - Current status
 * @returns Array of valid target statuses
 */
export function getAllowedTransitions(status: ExecutionStatus): ExecutionStatus[] {
  return VALID_TRANSITIONS[status];
}

// ---------------------------------------------------------------------------
// Execution Health
// ---------------------------------------------------------------------------

/** Startup grace period before marking execution as unknown (2 minutes) */
const STARTUP_GRACE_MS = 2 * 60 * 1000;

/** Threshold for healthy heartbeat (1 minute) */
const HEALTHY_HEARTBEAT_MS = 60_000;

/**
 * Compute the health status of an execution based on heartbeat recency.
 *
 * Health statuses:
 * - 'healthy': Heartbeat received within last minute, or still in startup grace period
 * - 'unknown': No heartbeat but within stale threshold (1-10 minutes)
 * - 'stale': No heartbeat for longer than stale threshold (10+ minutes)
 *
 * @param status - Current execution status
 * @param startedAt - Timestamp when execution started
 * @param lastHeartbeat - Timestamp of last heartbeat (undefined if never received)
 * @param now - Current timestamp (defaults to Date.now())
 * @returns Health status, or null if execution is not running
 */
export function computeExecutionHealth(
  status: ExecutionStatus,
  startedAt: number,
  lastHeartbeat: number | undefined,
  now: number = Date.now()
): ExecutionHealth | null {
  // Only compute health for running executions
  if (status !== 'running') {
    return null;
  }

  // If we have a heartbeat, check its recency
  if (lastHeartbeat !== undefined) {
    const timeSinceHeartbeat = now - lastHeartbeat;

    if (timeSinceHeartbeat < HEALTHY_HEARTBEAT_MS) {
      return 'healthy';
    }
    if (timeSinceHeartbeat < STALE_THRESHOLD_MS) {
      return 'unknown';
    }
    return 'stale';
  }

  // No heartbeat received yet - check if still in startup grace period
  const timeSinceStart = now - startedAt;

  if (timeSinceStart < STARTUP_GRACE_MS) {
    // Still starting up - give it time
    return 'healthy';
  }
  if (timeSinceStart < STALE_THRESHOLD_MS) {
    // Past startup grace but within stale threshold
    return 'unknown';
  }
  // Never received heartbeat and past stale threshold
  return 'stale';
}
