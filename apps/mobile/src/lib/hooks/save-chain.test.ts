import { describe, expect, it } from 'vitest';

import { chainSave } from '@/lib/hooks/save-chain';

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
});
