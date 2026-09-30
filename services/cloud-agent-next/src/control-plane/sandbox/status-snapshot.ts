/**
 * B10 projection from the V2 allocation state into the public
 * `SandboxStatusSnapshot` (spec "Sandbox Status"). It reads the V2
 * `AllocationView`, never the legacy allocation/health aggregate, so the old
 * model cannot leak back in through this path.
 *
 * This is a passive snapshot: `observedAt` is creation time, not a fresh probe.
 * `runtime` is intentionally omitted: the V2 allocation carries no runtime
 * versions, and inventing them would violate the bounded-runtime rule.
 */
import {
  getSandboxProviderLabel,
  type SandboxStatusSnapshot,
} from '../../shared/sandbox-status.js';
import type { AllocationView } from './allocation.js';

export type AllocationStatusSnapshotInput = {
  /** The V2 allocation view, or null when the sandbox has no owner. */
  allocation: AllocationView | null;
  /** Snapshot creation time; the value of `observedAt`. */
  observedAt: number;
  /**
   * The applicable sandbox inactivity bound, from
   * `resolveControlPlaneTimers(env).sandbox.idleMs`.
   */
  inactivityTimeoutMs: number;
};

export function projectAllocationStatusSnapshot(
  input: AllocationStatusSnapshotInput
): SandboxStatusSnapshot {
  const { allocation, observedAt, inactivityTimeoutMs } = input;
  const base = {
    provider: getSandboxProviderLabel(allocation?.provider),
    observedAt,
    inactivityTimeoutMs,
    estimatedSleepAt: null,
  };
  if (allocation === null) {
    return { ...base, status: 'unknown', detailCode: 'insufficient_evidence' };
  }
  switch (allocation.kind) {
    case 'stopped':
      return { ...base, status: 'sleeping', detailCode: 'sandbox_stopped' };
    case 'creating':
    case 'starting':
      return { ...base, status: 'starting', detailCode: 'sandbox_starting' };
    case 'stopping':
      return { ...base, status: 'stopping', detailCode: 'sandbox_stopping' };
    case 'disconnected':
      return { ...base, status: 'unreachable', detailCode: 'connection_unavailable' };
    case 'connected': {
      // The V2 idle anchor is the last wrapper-informed activity; the sleep
      // estimate is honest only when it is still in the future.
      const sleepAt =
        allocation.lastActivityAt === null ? null : allocation.lastActivityAt + inactivityTimeoutMs;
      return {
        ...base,
        status: 'active',
        detailCode: 'sandbox_ready',
        estimatedSleepAt: sleepAt !== null && sleepAt > observedAt ? sleepAt : null,
      };
    }
  }
}
