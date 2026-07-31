export type NewSessionFlowMode = 'pending' | 'single' | 'steps';

/**
 * Pure: given the instances query settle state, count, and share-staged
 * flag, return the new-session screen's flow mode. The route latches the
 * first non-`pending` result and never re-evaluates.
 *
 * - `pending`  — instances query has not yet settled.
 * - `steps`    — settled, at least one CLI instance, not share-staged.
 * - `single`   — settled, no CLI instances / query error / share-staged.
 */
export function resolveNewSessionFlowMode(input: {
  instancesSettled: boolean;
  instanceCount: number;
  isShareStaged: boolean;
}): NewSessionFlowMode {
  if (!input.instancesSettled) {
    return 'pending';
  }
  if (input.instanceCount > 0 && !input.isShareStaged) {
    return 'steps';
  }
  return 'single';
}
