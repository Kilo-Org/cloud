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
    vi.useFakeTimers();
    try {
      const sampler = createSampler(() => dump('/same', 10));
      sampler.start(250, 60_000);
      for (let tick = 0; tick < 3; tick += 1) {
        vi.advanceTimersByTime(250);
      }
      const samples = sampler.stop();
      expect(samples).toHaveLength(1);
      // Four ticks saw the same state, so the retained sample carries them all.
      expect(samples[0]?.repeat).toBe(4);
      expect(sampler.truncated()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains the newest states and reports truncation instead of growing without bound', () => {
    vi.useFakeTimers();
    try {
      // Each dump is large relative to the budget, so the weight bound, not the
      // count, is what must evict: an unbounded capture is what stopped the dev
      // client on an out-of-memory error.
      const sampler = createSampler(changing(1_000_000));
      sampler.start(250, 60_000);
      for (let tick = 0; tick < 12; tick += 1) {
        vi.advanceTimersByTime(250);
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
      sampler.start(250, 60_000);
      for (let tick = 0; tick < 5; tick += 1) {
        vi.advanceTimersByTime(250);
      }
      const samples = sampler.stop();
      expect(samples).toHaveLength(6);
      expect(sampler.truncated()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never samples faster than the device floor, whatever the runner asks for', () => {
    vi.useFakeTimers();
    try {
      // A 120 ms request would ask for more than the JS thread has on a busy
      // screen: the tick walks and serializes the whole document, and the app
      // cannot finish hydrating while the sampler runs (measured: a settled
      // dump costs ~150 ms on the emulator, so 120 ms saturates the thread and
      // the cell then measures a screen stuck on its own loading skeleton).
      const sampler = createSampler(() => dump('/same', 10));
      sampler.start(120, 60_000);
      let ticks = 0;
      // 1 s at the floor of 250 ms is 4 ticks, not the 8 a 120 ms cadence gives.
      for (let tick = 0; tick < 8; tick += 1) {
        vi.advanceTimersByTime(125);
      }
      ticks = 8;
      const samples = sampler.stop();
      // Identical states collapse, so the sample count bounds the tick count.
      expect(samples).toHaveLength(1);
      expect(samples[0]?.repeat).toBeLessThanOrEqual(ticks / 2 + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the retained dumps when the capture stops', () => {
    vi.useFakeTimers();
    try {
      const sampler = createSampler(changing(10));
      sampler.start(250, 60_000);
      vi.advanceTimersByTime(1250);
      expect(sampler.stop().length).toBeGreaterThan(0);
      // A stop clears the buffer, so a second stop hands back nothing.
      expect(sampler.stop()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
