import { describe, expect, it } from 'vitest';
import { resolveNextReconcileAction } from './reconcile-queue-utils';

describe('reconcile-queue-utils', () => {
  it('prefers queued action while a reconcile loop is active', () => {
    expect(
      resolveNextReconcileAction({
        queuedAction: 'disable',
        desiredEnabled: true,
        observedEnabled: true,
      })
    ).toBe('disable');
  });

  it('requests follow-up reconcile when observed diverges from desired', () => {
    expect(
      resolveNextReconcileAction({
        queuedAction: null,
        desiredEnabled: false,
        observedEnabled: true,
      })
    ).toBe('disable');
  });

  it('returns null when state is already converged', () => {
    expect(
      resolveNextReconcileAction({
        queuedAction: null,
        desiredEnabled: true,
        observedEnabled: true,
      })
    ).toBeNull();
  });
});
