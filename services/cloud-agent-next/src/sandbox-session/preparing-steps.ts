import type { PhysicalState } from '../sandbox-control/physical-lifecycle.js';
import type { ConnectionState } from '../sandbox-control/status-projection.js';
import type { PreparingStep } from '../shared/protocol.js';

export type PreparingHint = { step: PreparingStep; message: string };

export function provisionPreparingStep(
  physical: PhysicalState,
  allowCreate: boolean
): PreparingHint | null {
  if (physical === 'stopped' && allowCreate) {
    return { step: 'sandbox_provision', message: 'Creating sandbox…' };
  }
  return null;
}

export function bootPreparingStep(
  physical: PhysicalState,
  connection: ConnectionState
): PreparingHint | null {
  if (physical === 'creating' || (physical === 'running' && connection !== 'ready')) {
    return { step: 'sandbox_boot', message: 'Starting environment…' };
  }
  return null;
}
