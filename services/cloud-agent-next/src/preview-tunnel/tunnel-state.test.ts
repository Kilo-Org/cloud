import { afterEach, describe, expect, it, vi } from 'vitest';
import { AckWait, PREVIEW_TUNNEL_RECENT_IDS, RecentIds } from './tunnel-state.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('RecentIds', () => {
  it('keeps at most its bound and forgets the oldest id first', () => {
    const recent = new RecentIds(PREVIEW_TUNNEL_RECENT_IDS);
    for (let id = 1; id <= PREVIEW_TUNNEL_RECENT_IDS + 10; id += 1) recent.add(id);
    expect(recent.size).toBe(PREVIEW_TUNNEL_RECENT_IDS);
    expect(recent.has(10)).toBe(false);
    expect(recent.has(11)).toBe(true);
    expect(recent.has(PREVIEW_TUNNEL_RECENT_IDS + 10)).toBe(true);
  });

  it('does not count an id twice', () => {
    const recent = new RecentIds(2);
    recent.add(1);
    recent.add(1);
    recent.add(2);
    expect(recent.has(1)).toBe(true);
    expect(recent.size).toBe(2);
  });
});

describe('AckWait', () => {
  it('returns an earlier ack at once', async () => {
    const ack = new AckWait();
    ack.ack();
    ack.fail();
    expect(await ack.wait(1_000)).toBe('acked');
  });

  it('wakes on a failure', async () => {
    const ack = new AckWait();
    const waiting = ack.wait(1_000);
    ack.fail();
    expect(await waiting).toBe('failed');
  });

  it('times out without a frame', async () => {
    vi.useFakeTimers();
    const ack = new AckWait();
    const waiting = ack.wait(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await waiting).toBe('timeout');
  });
});
