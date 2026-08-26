import type { PhysicalState } from './physical-lifecycle.js';

export function planReconciliation(state: PhysicalState): 'observe' | 'none' {
  return state === 'failed' || state === 'unknown' ? 'observe' : 'none';
}

export function shouldRearmReconciliation(state: PhysicalState): boolean {
  return state === 'failed' || state === 'unknown';
}
