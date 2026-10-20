import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeEventOutbox } from './native-outbox.js';
import {
  NATIVE_DELIVERY_LIMITS,
  createNativeAttachmentRegistry,
  type NativeEventBatch,
} from '../../kilo-facade/native-event-source.js';
import { DEFAULT_DO_RETRY_CONFIG } from '@kilocode/worker-utils';
import { withDORetry } from '../../utils/do-retry.js';

const identity = {
  kiloUserId: 'owner',
  cloudAgentSessionId: 'workspace_root',
  kiloSessionId: 'ses_root',
};
const event = (value: string) => ({
  eventId: 2,
  materialized: true,
  event: { type: 'message.part.updated', properties: { sessionID: identity.kiloSessionId, value } },
});

function fixture(
  send = vi.fn<(batch: NativeEventBatch, deadlineAt: number) => Promise<void>>(
    async () => undefined
  )
) {
  const work: Promise<void>[] = [];
  const diagnostic = vi.fn();
  const outbox = createNativeEventOutbox({
    identity: () => identity,
    generation: () => 1,
    send,
    waitUntil: promise => work.push(promise),
    diagnostic,
  });
  outbox.subscribe('first');
  return { outbox, send, work, diagnostic };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('native ordered batch outbox', () => {
  it('coalesces a burst into one RPC without losing same-row mutable updates', async () => {
    const { outbox, send, work } = fixture();
    for (let index = 0; index < 100; index++) outbox.enqueue(event(String(index)));
    expect(send).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    await Promise.all(work);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      kind: 'events',
      firstSequence: 1,
      events: Array.from({ length: 100 }, (_, index) => event(String(index))),
    });
    expect(outbox.snapshot()).toMatchObject({ count: 0, bytes: 0, sequence: 100 });
  });

  it('retains one in-flight batch and sends subsequent updates strictly afterward', async () => {
    const pending = Promise.withResolvers<void>();
    const { outbox, send } = fixture(
      vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined)
    );
    outbox.enqueue(event('first'));
    await vi.advanceTimersByTimeAsync(10);
    outbox.enqueue(event('second'));
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledOnce();
    expect(outbox.snapshot().count).toBe(2);
    pending.resolve();
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toMatchObject({ firstSequence: 2, events: [event('second')] });
  });

  it.each(['count', 'bytes'] as const)(
    'marks all affected attachments lost at the %s bound before further delivery',
    async bound => {
      const { outbox, send } = fixture();
      outbox.subscribe('second');
      if (bound === 'count')
        for (let index = 0; index <= NATIVE_DELIVERY_LIMITS.count; index++)
          outbox.enqueue(event(''));
      else outbox.enqueue(event('\u00e9'.repeat(NATIVE_DELIVERY_LIMITS.bytes)));
      expect(outbox.refresh('first', 1)).toBe(false);
      outbox.enqueue(event('must not deliver'));
      await vi.runAllTimersAsync();
      expect(send).toHaveBeenCalledExactlyOnceWith(
        { ...identity, kind: 'loss', generation: 1, attachmentIds: ['first', 'second'] },
        expect.any(Number)
      );
      expect(outbox.snapshot()).toMatchObject({ count: 0, bytes: 0 });
    }
  );

  it('accounts for in-flight bytes during overflow and protects a newly attached snapshot', async () => {
    const pending = Promise.withResolvers<void>();
    const { outbox, send } = fixture(
      vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined)
    );
    outbox.enqueue(event('x'.repeat(40_000)));
    await vi.advanceTimersByTimeAsync(10);
    outbox.enqueue(event('y'.repeat(40_000)));
    expect(outbox.refresh('first', 1)).toBe(false);
    const cutover = outbox.subscribe('new');
    outbox.enqueue(event('after cutover'));
    pending.resolve();
    await vi.runAllTimersAsync();
    expect(send.mock.calls.map(([batch]) => batch.kind)).toEqual(['events', 'loss', 'events']);
    expect(send.mock.calls[1]?.[0]).toMatchObject({ attachmentIds: ['first'] });
    expect(send.mock.calls[2]?.[0]).toMatchObject({ firstSequence: cutover.sequence + 1 });
  });

  it('signals failed delivery and makes failed loss signaling detectable by refresh', async () => {
    const { outbox, send } = fixture(vi.fn().mockRejectedValue(new Error('unavailable')));
    outbox.enqueue(event('failed'));
    await vi.runAllTimersAsync();
    expect(send.mock.calls.map(([batch]) => batch.kind)).toEqual(['events', 'loss']);
    expect(outbox.refresh('first', 1)).toBe(false);
    outbox.enqueue(event('suppressed'));
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('expires queued events while a prior batch is in flight', async () => {
    const pending = Promise.withResolvers<void>();
    const { outbox, send } = fixture(
      vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined)
    );
    outbox.enqueue(event('first'));
    await vi.advanceTimersByTimeAsync(10);
    outbox.enqueue(event('expired'));
    await vi.advanceTimersByTimeAsync(NATIVE_DELIVERY_LIMITS.ageMs);
    pending.resolve();
    await vi.runAllTimersAsync();
    expect(send.mock.calls.map(([batch]) => batch.kind)).toEqual(['events', 'loss']);
  });

  it('retries an ambiguous applied batch using the same sequence, with exactly one receiver application', async () => {
    const lost = vi.fn();
    const registry = createNativeAttachmentRegistry(lost);
    registry.begin(identity.cloudAgentSessionId, identity.kiloSessionId, 'first');
    registry.bind('first', { generation: 1, sequence: 0 });
    registry.complete('first', 100);
    const received = vi.fn();
    registry.subscribe('first', received);
    let attempt = 0;
    const rpc = vi.fn(async (batch: NativeEventBatch) => {
      registry.deliverBatch(batch, ['first']);
      if (attempt++ === 0) throw Object.assign(new Error('ambiguous'), { retryable: true });
    });
    const { outbox } = fixture(
      vi.fn((batch, deadlineAt) =>
        withDORetry(
          () => ({ rpc }),
          stub => stub.rpc(batch),
          'native-test',
          { ...DEFAULT_DO_RETRY_CONFIG, baseBackoffMs: 0, scope: { deadlineAt } }
        )
      )
    );
    outbox.enqueue(event('a'));
    outbox.enqueue(event('b'));
    await vi.runAllTimersAsync();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]?.[0]).toEqual(rpc.mock.calls[1]?.[0]);
    expect(received.mock.calls.map(([event]) => event.properties.value)).toEqual(['a', 'b']);
    expect(lost).not.toHaveBeenCalled();
  });

  it('drops pending work and lost markers when all subscribers release', async () => {
    const { outbox, send } = fixture();
    outbox.enqueue(event('discard'));
    outbox.release('first');
    await vi.runAllTimersAsync();
    expect(send).not.toHaveBeenCalled();
    expect(outbox.snapshot()).toMatchObject({ count: 0, bytes: 0, subscriptions: 0 });
    expect(outbox.refresh('first', 1)).toBe(false);
  });
});
