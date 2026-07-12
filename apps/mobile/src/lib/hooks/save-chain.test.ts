import { describe, expect, it } from 'vitest';

import { chainSave, inFlightSaveCount } from '@/lib/hooks/save-chain';

// chainSave's internal chaining adds a few microtask hops per link (the
// nested IIFE + awaitSettled). Flushing a generous, fixed number of
// microtask turns is deterministic (no timers) and cheap enough to over-do.
async function flushMicrotasks(turns = 10): Promise<void> {
  if (turns <= 0) {
    return;
  }
  await Promise.resolve();
  await flushMicrotasks(turns - 1);
}

describe('chainSave', () => {
  it('runs the second save only after the first settles; last write wins', async () => {
    const key = 'fifo-order';
    const order: string[] = [];
    const firstGate = Promise.withResolvers<string>();

    const p1 = chainSave(key, async () => {
      order.push('first-start');
      const value = await firstGate.promise;
      order.push('first-end');
      return value;
    });

    // eslint-disable-next-line typescript-eslint/require-await -- no await needed; return value is the whole point
    const p2 = chainSave(key, async () => {
      order.push('second-start');
      return 'second-result';
    });

    // Flush pending microtasks — the second save must not have started yet,
    // since it's waiting on the first to settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first-start']);

    firstGate.resolve('first-result');
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    expect(r1).toBe('first-result');
    expect(r2).toBe('second-result');
  });

  it('keeps the chain running after a rejected save; the next save still runs', async () => {
    const key = 'reject-survives';
    const order: string[] = [];

    // eslint-disable-next-line typescript-eslint/require-await -- no await needed; return value is the whole point
    const p1 = chainSave(key, async () => {
      order.push('first');
      return 'ok';
    });
    // eslint-disable-next-line typescript-eslint/require-await -- no await needed; throw is the whole point
    const p2 = chainSave(key, async () => {
      order.push('second');
      throw new Error('boom');
    });
    // eslint-disable-next-line typescript-eslint/require-await -- no await needed; return value is the whole point
    const p3 = chainSave(key, async () => {
      order.push('third');
      return 'ok-again';
    });

    await expect(p1).resolves.toBe('ok');
    await expect(p2).rejects.toThrow('boom');
    await expect(p3).resolves.toBe('ok-again');
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('surfaces the rejection to the caller without an unhandled rejection', async () => {
    const key = 'no-unhandled-rejection';
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      // eslint-disable-next-line typescript-eslint/require-await -- no await needed; throw is the whole point
      const pending = chainSave(key, async () => {
        throw new Error('rejected');
      });

      await expect(pending).rejects.toThrow('rejected');
      // Give the runtime a turn to flag an unhandled rejection if chainSave
      // ever leaves the internal sequencing promise's rejection unhandled.
      await new Promise(resolve => {
        setImmediate(resolve);
      });

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('serializes three queued saves for the same key (regression: tail must be registered before any await)', async () => {
    const key = 'three-way-queueing';
    const order: string[] = [];
    const gateA = Promise.withResolvers<null>();
    const gateB = Promise.withResolvers<null>();

    const pA = chainSave(key, async () => {
      order.push('A-start');
      await gateA.promise;
      order.push('A-end');
      return 'a';
    });
    const pB = chainSave(key, async () => {
      order.push('B-start');
      await gateB.promise;
      order.push('B-end');
      return 'b';
    });
    // eslint-disable-next-line typescript-eslint/require-await -- no await needed; return value is the whole point
    const pC = chainSave(key, async () => {
      order.push('C-start');
      return 'c';
    });

    // A is in flight; B and C are enqueued behind it. Neither should have
    // started yet.
    await flushMicrotasks();
    expect(order).toEqual(['A-start']);

    gateA.resolve(null);
    // Let A finish and B start, but B is still gated on gateB (unresolved),
    // so no amount of microtask flushing lets it finish — C must not start.
    await flushMicrotasks();
    expect(order).toEqual(['A-start', 'A-end', 'B-start']);

    gateB.resolve(null);
    await Promise.all([pA, pB, pC]);

    expect(order).toEqual(['A-start', 'A-end', 'B-start', 'B-end', 'C-start']);
  });

  it('does not serialize saves for distinct keys', async () => {
    const order: string[] = [];
    const gate = Promise.withResolvers<null>();

    const p1 = chainSave('key-one', async () => {
      order.push('one-start');
      await gate.promise;
      order.push('one-end');
      return 'one';
    });
    // eslint-disable-next-line typescript-eslint/require-await -- no await needed; return value is the whole point
    const p2 = chainSave('key-two', async () => {
      order.push('two-start');
      return 'two';
    });

    // key-two has no predecessor, so it must run immediately even though
    // key-one is still gated.
    await flushMicrotasks();
    expect(order).toEqual(['one-start', 'two-start']);

    gate.resolve(null);
    await Promise.all([p1, p2]);
    expect(order).toEqual(['one-start', 'two-start', 'one-end']);
  });

  it('releases the key from the in-flight map once its chain settles (regression: unbounded map leak)', async () => {
    const key = 'cleanup-key';
    const baseline = inFlightSaveCount();

    // eslint-disable-next-line typescript-eslint/require-await -- no await needed; return value is the whole point
    await chainSave(key, async () => 'done');

    // The `.finally` cleanup runs as a continuation of the settled tail
    // promise; give the microtask queue several turns to run it.
    await flushMicrotasks();

    expect(inFlightSaveCount()).toBe(baseline);
  });
});
