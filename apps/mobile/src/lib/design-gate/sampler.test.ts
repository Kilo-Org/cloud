import { describe, expect, it, vi } from 'vitest';

import { createSampler } from './sampler';
import { type PaintState } from './paint-state';

/** A dump whose serialized size is roughly `fill` characters. */
function dump(route: string, fill: number): PaintState {
  return {
    env: { route, screen: route },
    nodes: [{ rect: [0, 0, 100, 100], tag: 'View', text: 'x'.repeat(fill) }],
  };
}

/** A snapshot function whose route changes on every call. */
function changing(fill: number): () => PaintState {
  let index = 0;
  return () => {
    index += 1;
    return dump(`/route-${index}`, fill);
  };
}

describe('design gate sampler', () => {
  it('collapses consecutive identical states into one sample with a repeat count', () => {
    const sampler = createSampler(() => dump('/same', 10));
    sampler.start(10_000, 10_000);
    const samples = sampler.stop();
    expect(samples).toHaveLength(1);
    expect(samples[0]?.repeat).toBe(1);
  });

  it('retains the newest states and reports truncation instead of growing without bound', () => {
    vi.useFakeTimers();
    try {
      // Each dump is large relative to the budget, so the weight bound, not the
      // count, is what must evict: an unbounded capture is what stopped the dev
      // client on an out-of-memory error.
      const sampler = createSampler(changing(1_000_000));
      sampler.start(10, 60_000);
      for (let tick = 0; tick < 12; tick += 1) {
        vi.advanceTimersByTime(10);
      }
      const samples = sampler.stop();
      expect(samples.length).toBeLessThan(12);
      expect(sampler.truncated()).toBe(true);
      // The newest state survives the eviction of the older ones.
      expect(samples.at(-1)?.dump.env.route).toBe('/route-13');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps every sample when the capture stays small', () => {
    vi.useFakeTimers();
    try {
      const sampler = createSampler(changing(10));
      sampler.start(10, 60_000);
      for (let tick = 0; tick < 5; tick += 1) {
        vi.advanceTimersByTime(10);
      }
      const samples = sampler.stop();
      expect(samples).toHaveLength(6);
      expect(sampler.truncated()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the retained dumps when the capture stops', () => {
    vi.useFakeTimers();
    try {
      const sampler = createSampler(changing(10));
      sampler.start(10, 60_000);
      vi.advanceTimersByTime(50);
      expect(sampler.stop().length).toBeGreaterThan(0);
      // A stop clears the buffer, so a second stop hands back nothing.
      expect(sampler.stop()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
