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
      sampler.start(10, 60_000);
      for (let tick = 0; tick < 3; tick += 1) {
        vi.advanceTimersByTime(10);
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

  it('keeps no sampling timer armed while a tick runs', () => {
    vi.useFakeTimers();
    try {
      const armed: number[] = [];
      const sampler = createSampler(() => {
        armed.push(vi.getTimerCount());
        return dump('/same', 10);
      });
      sampler.start(250, 60_000);
      vi.advanceTimersByTime(250);
      sampler.stop();
      // The first tick runs before any timer is armed. A scheduled tick runs with
      // only the maxMs deadline armed, because the next tick is scheduled after it
      // returns; a periodic timer would still be armed there, which is what queues
      // one tick behind an overrunning one.
      expect(armed).toEqual([0, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the screen a slice between ticks when a tick costs more than the interval', async () => {
    // Fake timers cannot make a synchronous tick consume fake time, and moving the
    // fake system clock also shifts the armed timer, which would hide the queueing
    // this asserts. The tick's cost is spent on the real clock instead.
    const tickCostMs = 60;
    const intervalMs = 10;
    const windowMs = 300;
    const starts: number[] = [];
    const sampler = createSampler(() => {
      starts.push(Date.now());
      // One dump walks and serializes the whole document on this thread.
      const until = Date.now() + tickCostMs;
      while (Date.now() < until) {
        // the app's own JS thread is busy here
      }
      return dump(`/route-${starts.length}`, 10);
    });
    sampler.start(intervalMs, 60_000);
    const measured = Promise.withResolvers<undefined>();
    setTimeout(() => {
      measured.resolve(undefined);
    }, windowMs);
    await measured.promise;
    const samples = sampler.stop();
    expect(starts.length).toBeGreaterThan(1);
    // Date.now() has millisecond resolution and a fired timer may land a moment
    // early, so the asserted slice allows a few milliseconds of rounding.
    const roundingMs = 5;
    for (let index = 1; index < starts.length; index += 1) {
      // The next tick starts after the previous one returned *and* after the
      // interval: a fixed period queues the next tick the moment the previous one
      // starts, so a dump that costs 60 ms leaves the app no slice at all.
      expect((starts[index] ?? 0) - (starts[index - 1] ?? 0)).toBeGreaterThanOrEqual(
        tickCostMs + intervalMs - roundingMs
      );
    }
    // Ticks are bounded by the cost of a dump, not by window / interval.
    expect(starts.length).toBeLessThanOrEqual(Math.ceil(windowMs / (tickCostMs + intervalMs)) + 1);
    expect(samples.length).toBeGreaterThan(1);
  });

  it('clears the pending tick when the capture stops', () => {
    vi.useFakeTimers();
    try {
      let snapshots = 0;
      const sampler = createSampler(() => {
        snapshots += 1;
        return dump('/same', 10);
      });
      sampler.start(250, 60_000);
      sampler.stop();
      const afterStop = snapshots;
      vi.advanceTimersByTime(10_000);
      expect(snapshots).toBe(afterStop);
    } finally {
      vi.useRealTimers();
    }
  });
});
