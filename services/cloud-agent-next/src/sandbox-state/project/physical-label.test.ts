import { describe, expect, it } from 'vitest';
import { isTerminalLaunchFailure } from './physical-label.js';
import type { AllocationRecord } from '../model/allocation.js';
import { allocationFixture } from '../model/allocation-fixtures.js';

function unknownRecord(reason: string): AllocationRecord {
  const fixture = allocationFixture({
    state: 'unknown',
    providerRef: 'ref',
    createIntent: { intentId: 'intent_1', createdAt: 1_000 },
  });
  if (!fixture || fixture.state.kind !== 'unknown') throw new Error('expected an unknown fixture');
  return { ...fixture, state: { ...fixture.state, reason } };
}

describe('isTerminalLaunchFailure', () => {
  it('is true only for an unknown allocation whose reason is launch_failed', () => {
    expect(isTerminalLaunchFailure(unknownRecord('launch_failed'))).toBe(true);
    expect(isTerminalLaunchFailure(unknownRecord('create_deadline'))).toBe(false);
    expect(isTerminalLaunchFailure(unknownRecord('create_unknown'))).toBe(false);
    expect(isTerminalLaunchFailure(unknownRecord('legacy_failed'))).toBe(false);
  });

  it('is false for an allocated allocation', () => {
    const allocated = allocationFixture({
      state: 'running',
      providerRef: 'ref',
      createIntent: { intentId: 'intent_1', createdAt: 1_000 },
    });
    if (!allocated) throw new Error('expected an allocated fixture');
    expect(isTerminalLaunchFailure(allocated)).toBe(false);
  });
});
