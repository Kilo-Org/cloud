import { describe, expect, it } from 'vitest';
import { nextEnsureReadyStep } from '../ensure-ready.js';
import { planReconciliation, shouldRearmReconciliation } from '../reconciliation.js';

describe('reconciliation deadline', () => {
  it('observes only and never creates', () => {
    expect(planReconciliation('failed')).toBe('observe');
    expect(planReconciliation('unknown')).toBe('observe');
    expect(planReconciliation('running')).toBe('none');
    expect(planReconciliation('stopped')).toBe('none');

    expect(nextEnsureReadyStep('failed', false)).toBe('release-failed');
    expect(nextEnsureReadyStep('unknown', false)).toBe('observe-unknown');
    expect(nextEnsureReadyStep('stopped', false)).toBe('return');

    expect(shouldRearmReconciliation('failed')).toBe(true);
    expect(shouldRearmReconciliation('unknown')).toBe(true);
    expect(shouldRearmReconciliation('stopped')).toBe(false);
    expect(shouldRearmReconciliation('running')).toBe(false);
  });
});
