import { describe, expect, it } from '@jest/globals';
import {
  createEnkryptCallLimiter,
  ENKRYPT_MAX_CONCURRENT_CALLS,
  type EnkryptCallLimiter,
  type EnkryptCallSlot,
} from './call-limiter';
import type { EnkryptScanKind } from './report';

const signal = new AbortController().signal;

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
}

/** Acquires a slot and records, under `label`, the order in which slots were granted. */
function track(
  limiter: EnkryptCallLimiter,
  granted: string[],
  label: string,
  priority: EnkryptScanKind,
  acquireSignal: AbortSignal = signal
): Promise<EnkryptCallSlot | null> {
  return limiter.acquire(priority, acquireSignal).then(slot => {
    if (slot) granted.push(label);
    return slot;
  });
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

describe('createEnkryptCallLimiter', () => {
  it('allows four concurrent calls by default', async () => {
    expect(ENKRYPT_MAX_CONCURRENT_CALLS).toBe(4);
    const limiter = createEnkryptCallLimiter();
    const granted: string[] = [];

    const slots = [0, 1, 2, 3, 4].map(index => track(limiter, granted, String(index), 'blocking'));
    await flush();

    expect(granted).toEqual(['0', '1', '2', '3']);
    required(await slots[0])();
    await flush();
    expect(granted).toEqual(['0', '1', '2', '3', '4']);
  });

  it('never grants more slots than the cap', async () => {
    const limiter = createEnkryptCallLimiter(2);
    const granted: string[] = [];

    const first = track(limiter, granted, 'first', 'blocking');
    const second = track(limiter, granted, 'second', 'log_only');
    void track(limiter, granted, 'third', 'blocking');
    void track(limiter, granted, 'fourth', 'log_only');
    await flush();

    expect(granted).toEqual(['first', 'second']);
    required(await second)();
    await flush();
    expect(granted).toEqual(['first', 'second', 'third']);
    required(await first)();
    await flush();
    expect(granted).toEqual(['first', 'second', 'third', 'fourth']);
  });

  it('grants a blocking call before a log-only call that queued earlier', async () => {
    const limiter = createEnkryptCallLimiter(1);
    const granted: string[] = [];

    const holder = track(limiter, granted, 'holder', 'log_only');
    const logOnly = track(limiter, granted, 'log-only', 'log_only');
    const blocking = track(limiter, granted, 'blocking', 'blocking');
    await flush();
    expect(granted).toEqual(['holder']);

    required(await holder)();
    await flush();
    expect(granted).toEqual(['holder', 'blocking']);
    required(await blocking)();
    await flush();
    expect(granted).toEqual(['holder', 'blocking', 'log-only']);
    required(await logOnly)();
  });

  it('grants calls of the same priority in the order they asked', async () => {
    const limiter = createEnkryptCallLimiter(1);
    const granted: string[] = [];

    const holder = required(await track(limiter, granted, 'holder', 'blocking'));
    const waiting = new Map<string, Promise<EnkryptCallSlot | null>>(
      (
        [
          ['log-only 1', 'log_only'],
          ['blocking 1', 'blocking'],
          ['log-only 2', 'log_only'],
          ['blocking 2', 'blocking'],
        ] as const
      ).map(([label, priority]) => [label, track(limiter, granted, label, priority)])
    );
    holder();
    // Releasing each newly granted slot lets the next waiter through, one at a time.
    for (let index = 1; index <= waiting.size; index++) {
      await flush();
      expect(granted).toHaveLength(index + 1);
      required(await waiting.get(required(granted[index])))();
    }

    expect(granted).toEqual(['holder', 'blocking 1', 'blocking 2', 'log-only 1', 'log-only 2']);
  });

  it('removes a waiter whose signal aborts, without consuming a slot', async () => {
    const limiter = createEnkryptCallLimiter(1);
    const granted: string[] = [];
    const controller = new AbortController();

    const holder = required(await track(limiter, granted, 'holder', 'blocking'));
    const aborted = track(limiter, granted, 'aborted', 'blocking', controller.signal);
    const next = track(limiter, granted, 'next', 'log_only');
    controller.abort();

    expect(await aborted).toBeNull();
    holder();
    await flush();
    expect(granted).toEqual(['holder', 'next']);

    // The aborted waiter never took the slot, so releasing `next` frees the only one.
    required(await next)();
    expect(await track(limiter, granted, 'last', 'log_only')).not.toBeNull();
  });

  it('resolves null immediately for a signal that already aborted', async () => {
    const limiter = createEnkryptCallLimiter(1);
    const controller = new AbortController();
    controller.abort();

    expect(await limiter.acquire('blocking', controller.signal)).toBeNull();
    // No slot was taken.
    expect(await limiter.acquire('blocking', signal)).not.toBeNull();
  });

  it('ignores a second release of the same slot', async () => {
    const limiter = createEnkryptCallLimiter(2);
    const granted: string[] = [];

    const first = required(await track(limiter, granted, 'first', 'blocking'));
    void track(limiter, granted, 'second', 'blocking');
    void track(limiter, granted, 'third', 'blocking');
    void track(limiter, granted, 'fourth', 'blocking');
    await flush();
    expect(granted).toEqual(['first', 'second']);

    first();
    first();
    await flush();
    expect(granted).toEqual(['first', 'second', 'third']);
  });
});
