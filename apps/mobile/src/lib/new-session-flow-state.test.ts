import { describe, expect, it } from 'vitest';

import { resolveNewSessionFlowMode } from './new-session-flow-state';

describe('resolveNewSessionFlowMode', () => {
  it('returns "pending" when the instances query has not yet settled', () => {
    expect(
      resolveNewSessionFlowMode({
        instancesSettled: false,
        instanceCount: 0,
        isShareStaged: false,
      })
    ).toBe('pending');

    // Even with instances, still pending if not settled.
    expect(
      resolveNewSessionFlowMode({
        instancesSettled: false,
        instanceCount: 3,
        isShareStaged: false,
      })
    ).toBe('pending');

    // Share-staged doesn't matter before settle.
    expect(
      resolveNewSessionFlowMode({
        instancesSettled: false,
        instanceCount: 3,
        isShareStaged: true,
      })
    ).toBe('pending');
  });

  it('returns "steps" when settled, at least one CLI, and not share-staged', () => {
    expect(
      resolveNewSessionFlowMode({
        instancesSettled: true,
        instanceCount: 1,
        isShareStaged: false,
      })
    ).toBe('steps');

    expect(
      resolveNewSessionFlowMode({
        instancesSettled: true,
        instanceCount: 5,
        isShareStaged: false,
      })
    ).toBe('steps');
  });

  it('returns "single" when settled with zero instances', () => {
    expect(
      resolveNewSessionFlowMode({
        instancesSettled: true,
        instanceCount: 0,
        isShareStaged: false,
      })
    ).toBe('single');
  });

  it('returns "single" when share-staged, even with instances', () => {
    expect(
      resolveNewSessionFlowMode({
        instancesSettled: true,
        instanceCount: 3,
        isShareStaged: true,
      })
    ).toBe('single');
  });

  it('returns "single" when share-staged with zero instances', () => {
    expect(
      resolveNewSessionFlowMode({
        instancesSettled: true,
        instanceCount: 0,
        isShareStaged: true,
      })
    ).toBe('single');
  });
});
