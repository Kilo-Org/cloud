import type { AllocationRecord } from '../model/allocation.js';
import type { PhysicalState } from '../../shared/sandbox-status.js';

/**
 * A terminal launch failure is the canonical allocation's own vocabulary: the
 * record is `unknown` because the confirmed launch failed (`LAUNCH_FAILED`)
 * rather than because its environment state is merely unresolved. Consumers
 * that need to act on it read this projection, never the raw reason.
 */
export function isTerminalLaunchFailure(record: AllocationRecord): boolean {
  const state = record.state;
  return state.kind === 'unknown' && state.reason === 'launch_failed';
}

/** Legacy flat allocation label for a canonical record. Public status only. */
export function legacyPhysicalState(record: AllocationRecord): PhysicalState {
  const state = record.state;
  switch (state.kind) {
    case 'stopped':
      return 'stopped';
    case 'creating':
      return 'creating';
    case 'allocated':
      return 'running';
    case 'stopping':
      return 'stopping';
    case 'unknown':
      return state.reason === 'legacy_failed'
        ? 'failed'
        : state.reason === 'legacy_unknown' || state.stopIntent !== null
          ? 'unknown'
          : 'failed';
  }
}
