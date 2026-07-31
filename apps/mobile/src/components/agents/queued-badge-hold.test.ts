import { describe, expect, it } from 'vitest';

import { nextHeldQueuedIds } from './queued-badge-hold';

describe('nextHeldQueuedIds', () => {
  it('adds queued ids while streaming', () => {
    const prev = new Set<string>();
    const pending = new Map([['m1', { status: 'queued' }]]);
    const result = nextHeldQueuedIds(prev, pending, true);
    expect(result).toContain('m1');
    expect(result.size).toBe(1);
  });

  it('ignores failed-only entries (defensive contract)', () => {
    const prev = new Set<string>();
    const pending = new Map([['m1', { status: 'failed', error: 'nope', reason: 'exhausted' }]]);
    const result = nextHeldQueuedIds(prev, pending, true);
    expect(result.size).toBe(0);
  });

  it('never shrinks while streaming — dequeued id stays held', () => {
    const prev = new Set(['m1']);
    const pending = new Map(); // empty — m1 was deleted
    const result = nextHeldQueuedIds(prev, pending, true);
    expect(result).toContain('m1');
    expect(result.size).toBe(1);
  });

  it('returns the shared empty set when isStreaming is false', () => {
    const prev = new Set(['m1', 'm2']);
    const pending = new Map([['m3', { status: 'queued' }]]);
    const result = nextHeldQueuedIds(prev, pending, false);
    expect(result.size).toBe(0);
    // Same reference across calls
    const result2 = nextHeldQueuedIds(prev, pending, false);
    expect(result).toBe(result2);
  });

  it('returns the same prev reference when nothing changes', () => {
    const prev = new Set(['m1']);
    const pending = new Map([['m1', { status: 'queued' }]]);
    const result = nextHeldQueuedIds(prev, pending, true);
    expect(result).toBe(prev);
  });

  it('empty prev + streaming + queued ids → exactly those ids', () => {
    const prev = new Set<string>();
    const pending = new Map([
      ['m1', { status: 'queued' }],
      ['m2', { status: 'queued' }],
    ]);
    const result = nextHeldQueuedIds(prev, pending, true);
    expect(result).toContain('m1');
    expect(result).toContain('m2');
    expect(result.size).toBe(2);
  });

  it('empty prev + non-streaming returns shared empty set', () => {
    const prev = new Set<string>();
    const pending = new Map([['m1', { status: 'queued' }]]);
    const result = nextHeldQueuedIds(prev, pending, false);
    expect(result.size).toBe(0);
  });
});
