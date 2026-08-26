import type { PhysicalState } from './physical-lifecycle.js';

export type EnsureReadyStep = 'release-failed' | 'observe-unknown' | 'create' | 'return';

export function nextEnsureReadyStep(state: PhysicalState, allowCreate: boolean): EnsureReadyStep {
  if (state === 'failed') return 'release-failed';
  if (state === 'unknown') return 'observe-unknown';
  if (state === 'stopped' && allowCreate) return 'create';
  return 'return';
}
