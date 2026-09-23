import type { AllocationRecord } from '../model/allocation.js';
import type { PhysicalState } from '../../shared/sandbox-status.js';

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
