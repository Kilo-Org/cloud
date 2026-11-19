import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamSlots } from './stream-slots.js';

const limits = { capacity: 2, maxWaiters: 2, waitMs: 1_000 };

afterEach(() => {
  vi.useRealTimers();
});

describe('StreamSlots', () => {
  it('admits up to the capacity at once', async () => {
    const slots = new StreamSlots(() => limits);
    expect(await slots.acquire()).toBe(true);
    expect(await slots.acquire()).toBe(true);
    expect(slots.inUse).toBe(2);
  });

  it('gives a released slot to the first waiting request', async () => {
    const slots = new StreamSlots(() => limits);
    await slots.acquire();
    await slots.acquire();
    const order: string[] = [];
    const first = slots.acquire().then(ok => order.push(`first:${ok}`));
    const second = slots.acquire().then(ok => order.push(`second:${ok}`));
    expect(slots.waiting).toBe(2);
    slots.release();
    await first;
    expect(order).toEqual(['first:true']);
    expect(slots.inUse).toBe(2);
    slots.release();
    await second;
    expect(order).toEqual(['first:true', 'second:true']);
  });

  it('refuses a request over the waiter bound at once', async () => {
    const slots = new StreamSlots(() => limits);
    await slots.acquire();
    await slots.acquire();
    void slots.acquire();
    void slots.acquire();
    expect(await slots.acquire()).toBe(false);
    expect(slots.waiting).toBe(2);
  });

  it('ends a wait after the bound and forgets the waiter', async () => {
    vi.useFakeTimers();
    const slots = new StreamSlots(() => limits);
    await slots.acquire();
    await slots.acquire();
    const waiting = slots.acquire();
    vi.advanceTimersByTime(limits.waitMs);
    expect(await waiting).toBe(false);
    expect(slots.waiting).toBe(0);
    slots.release();
    expect(slots.inUse).toBe(1);
  });

  it('counts restored streams and never goes below zero', async () => {
    const slots = new StreamSlots(() => limits);
    slots.restore(2);
    let admitted = false;
    void slots.acquire().then(ok => {
      admitted = ok;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);
    slots.release();
    await Promise.resolve();
    expect(admitted).toBe(true);
    slots.release();
    slots.release();
    slots.release();
    expect(slots.inUse).toBe(0);
  });
});
