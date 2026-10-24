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
  ),
  getIdentity: () => typeof identity | null = () => identity
) {
  const work: Promise<void>[] = [];
  const diagnostic = vi.fn();
  const outbox = createNativeEventOutbox({
    identity: getIdentity,
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
      else {
        outbox.enqueue(event('\u00e9'.repeat(20_000)));
        outbox.enqueue(event('\u00e9'.repeat(20_000)));
      }
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

  it.each([70, 128, 240])(
    'delivers a singleton %s KiB event and admits subsequent events after flush',
    async kib => {
      const { outbox, send, work } = fixture();
      const large = event('\u00e9'.repeat((kib * 1024) / 2));
      outbox.enqueue(large);
      expect(outbox.snapshot()).toMatchObject({
        count: 1,
        bytes: new TextEncoder().encode(JSON.stringify(large.event)).byteLength,
      });
      await vi.runAllTimersAsync();
      expect(send).toHaveBeenCalledExactlyOnceWith(
        { ...identity, kind: 'events', generation: 1, firstSequence: 1, events: [large] },
        expect.any(Number)
      );
      const [batch, deadlineAt] = send.mock.calls[0] ?? [];
      expect(
        new TextEncoder().encode(JSON.stringify({ ...batch, deadlineAt })).byteLength
      ).toBeLessThanOrEqual(NATIVE_DELIVERY_LIMITS.batchBytes);
      expect(outbox.refresh('first', 1)).toBe(true);
      outbox.enqueue(event('after large'));
      await vi.runAllTimersAsync();
      await Promise.all(work);
      expect(send.mock.calls[1]?.[0]).toMatchObject({
        firstSequence: 2,
        events: [event('after large')],
      });
      expect(outbox.snapshot()).toMatchObject({ count: 0, bytes: 0 });
    }
  );

  it.each(['queued', 'inflight'])(
    'signals overflow above the 320 KiB payload bound including %s retention',
    async phase => {
      const pending = Promise.withResolvers<void>();
      const { outbox, send, work } = fixture(
        vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined)
      );
      outbox.enqueue(event('x'.repeat(128 * 1024)));
      if (phase === 'inflight')
        await vi.advanceTimersByTimeAsync(NATIVE_DELIVERY_LIMITS.coalesceMs);
      outbox.enqueue(event('y'.repeat(240 * 1024)));
      expect(outbox.refresh('first', 1)).toBe(false);
      pending.resolve();
      await vi.runAllTimersAsync();
      await Promise.all(work);
      expect(send.mock.calls.map(([batch]) => batch.kind)).toEqual(
        phase === 'inflight' ? ['events', 'loss'] : ['loss']
      );
      expect(outbox.snapshot()).toMatchObject({ count: 0, bytes: 0 });
    }
  );

  it.each([70, 128, 240])(
    'coalesces small metadata, a %s KiB event, and small completion in producer order',
    async kib => {
      const { outbox, send, work } = fixture();
      const events = [
        event('metadata'),
        event('\u00e9'.repeat((kib * 1024) / 2)),
        event('completion'),
      ];
      for (const value of events) outbox.enqueue(value);
      expect(outbox.snapshot().count).toBe(3);
      expect(outbox.snapshot().bytes).toBeLessThanOrEqual(NATIVE_DELIVERY_LIMITS.retainedBytes);
      await vi.runAllTimersAsync();
      await Promise.all(work);
      expect(send).toHaveBeenCalledExactlyOnceWith(
        { ...identity, kind: 'events', generation: 1, firstSequence: 1, events },
        expect.any(Number)
      );
      expect(outbox.refresh('first', 1)).toBe(true);
      expect(outbox.snapshot()).toMatchObject({ count: 0, bytes: 0 });
    }
  );

  it('retains small metadata behind an in-flight large event and delivers it strictly afterward', async () => {
    const pending = Promise.withResolvers<void>();
    const { outbox, send, work } = fixture(
      vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined)
    );
    outbox.enqueue(event('x'.repeat(128 * 1024)));
    await vi.advanceTimersByTimeAsync(NATIVE_DELIVERY_LIMITS.coalesceMs);
    outbox.enqueue(event('completion'));
    expect(outbox.snapshot().count).toBe(2);
    expect(outbox.refresh('first', 1)).toBe(true);
    pending.resolve();
    await vi.runAllTimersAsync();
    await Promise.all(work);
    expect(send.mock.calls.map(([batch]) => batch.kind)).toEqual(['events', 'events']);
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      firstSequence: 2,
      events: [event('completion')],
    });
  });

  it('allows multiple large events only within the aggregate 320 KiB payload budget', async () => {
    const { outbox, send, work } = fixture();
    const events = [
      event('metadata'),
      event('x'.repeat(128 * 1024)),
      event('y'.repeat(128 * 1024)),
      event('completion'),
    ];
    for (const value of events) outbox.enqueue(value);
    expect(outbox.snapshot().bytes).toBeLessThanOrEqual(NATIVE_DELIVERY_LIMITS.retainedBytes);
    await vi.runAllTimersAsync();
    await Promise.all(work);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ kind: 'events', events });
    expect(outbox.refresh('first', 1)).toBe(true);
  });

  it('signals a per-event maximum violation explicitly without truncating or delivering it', async () => {
    const { outbox, send, diagnostic, work } = fixture();
    outbox.enqueue(event('x'.repeat(NATIVE_DELIVERY_LIMITS.eventBytes)));
    await vi.runAllTimersAsync();
    await Promise.all(work);
    expect(diagnostic).toHaveBeenCalledWith('oversized');
    expect(send.mock.calls.map(([batch]) => batch.kind)).toEqual(['loss']);
    expect(outbox.refresh('first', 1)).toBe(false);
    expect(outbox.snapshot()).toMatchObject({ count: 0, bytes: 0 });
  });

  it.each(['events', 'loss'])(
    'quiesces queued %s when identity disappears without retaining timers or rejected work',
    async kind => {
      let currentIdentity: typeof identity | null = identity;
      const { outbox, send, work, diagnostic } = fixture(undefined, () => currentIdentity);
      outbox.enqueue(
        event(kind === 'loss' ? 'x'.repeat(NATIVE_DELIVERY_LIMITS.eventBytes) : 'pending')
      );
      currentIdentity = null;
      await vi.runAllTimersAsync();
      await expect(Promise.all(work)).resolves.toEqual([undefined]);
      expect(send).not.toHaveBeenCalled();
      expect(diagnostic).toHaveBeenCalledWith('identity_unavailable');
      expect(outbox.refresh('first', 1)).toBe(false);
      expect(outbox.snapshot()).toMatchObject({ count: 0, bytes: 0 });
      expect(vi.getTimerCount()).toBe(0);
      outbox.enqueue(event('suppressed'));
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('quiesces events and loss markers behind an in-flight failure after identity disappears', async () => {
    let currentIdentity: typeof identity | null = identity;
    const pending = Promise.withResolvers<void>();
    const { outbox, send, work } = fixture(
      vi.fn().mockReturnValueOnce(pending.promise),
      () => currentIdentity
    );
    outbox.enqueue(event('first'));
    await vi.advanceTimersByTimeAsync(NATIVE_DELIVERY_LIMITS.coalesceMs);
    outbox.enqueue(event('queued'));
    outbox.enqueue(event('x'.repeat(NATIVE_DELIVERY_LIMITS.eventBytes)));
    outbox.subscribe('second');
    outbox.enqueue(event('queued after loss'));
    currentIdentity = null;
    pending.reject(new Error('deleted during delivery'));
    await vi.runAllTimersAsync();
    await expect(Promise.all(work)).resolves.toEqual([undefined]);
    expect(send).toHaveBeenCalledOnce();
    expect(outbox.snapshot()).toMatchObject({ count: 0, bytes: 0 });
    expect(outbox.refresh('second', 1)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles an unexpected flush exception once and stops scheduling while refresh reports loss', async () => {
    const { outbox, send, work, diagnostic } = fixture(undefined, () => {
      throw new Error('unexpected');
    });
    outbox.enqueue(event('pending'));
    await vi.runAllTimersAsync();
    await expect(Promise.all(work)).resolves.toEqual([undefined]);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith('unexpected_flush_error');
    expect(outbox.refresh('first', 1)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(outbox.snapshot()).toMatchObject({ count: 0, bytes: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('quiesces a completed in-flight batch when its identity is gone even without more queued work', async () => {
    let currentIdentity: typeof identity | null = identity;
    const pending = Promise.withResolvers<void>();
    const { outbox, work, diagnostic } = fixture(
      vi.fn().mockReturnValue(pending.promise),
      () => currentIdentity
    );
    outbox.enqueue(event('inflight'));
    await vi.advanceTimersByTimeAsync(NATIVE_DELIVERY_LIMITS.coalesceMs);
    currentIdentity = null;
    pending.resolve();
    await Promise.all(work);
    expect(outbox.refresh('first', 1)).toBe(false);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith('identity_unavailable');
    expect(outbox.snapshot()).toMatchObject({ count: 0, bytes: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts exactly the serialized per-event maximum including JSON escaping and envelope overhead', async () => {
    const { outbox, send, work } = fixture();
    const maximum = event('');
    const overhead = new TextEncoder().encode(JSON.stringify(maximum.event)).byteLength;
    maximum.event.properties.value = '\n'.repeat(
      Math.floor((NATIVE_DELIVERY_LIMITS.eventBytes - overhead) / 2)
    );
    const remaining =
      NATIVE_DELIVERY_LIMITS.eventBytes -
      new TextEncoder().encode(JSON.stringify(maximum.event)).byteLength;
    maximum.event.properties.value += 'x'.repeat(remaining);
    outbox.enqueue(maximum);
    expect(outbox.snapshot().bytes).toBe(NATIVE_DELIVERY_LIMITS.eventBytes);
    await vi.runAllTimersAsync();
    await Promise.all(work);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ kind: 'events', events: [maximum] });
    expect(outbox.refresh('first', 1)).toBe(true);
  });

  it.each(['events', 'loss'])(
    'cancels queued %s teardown work immediately and permits a fresh subscription fixture',
    async kind => {
      const { outbox, send, work } = fixture();
      outbox.enqueue(
        event(kind === 'loss' ? 'x'.repeat(NATIVE_DELIVERY_LIMITS.eventBytes) : 'deleted')
      );
      outbox.close();
      expect(vi.getTimerCount()).toBe(0);
      await expect(Promise.all(work)).resolves.toEqual([undefined]);
      expect(send).not.toHaveBeenCalled();
      expect(outbox.snapshot()).toMatchObject({ count: 0, bytes: 0, subscriptions: 0 });
      outbox.subscribe('fresh');
      outbox.enqueue(event('fresh'));
      await vi.runAllTimersAsync();
      expect(send).toHaveBeenCalledOnce();
      expect(outbox.refresh('fresh', 1)).toBe(true);
    }
  );

  it('does not invalidate fresh subscribers when a deleted in-flight batch fails', async () => {
    const pending = Promise.withResolvers<void>();
    const { outbox, send, work } = fixture(
      vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined)
    );
    outbox.enqueue(event('inflight'));
    await vi.advanceTimersByTimeAsync(NATIVE_DELIVERY_LIMITS.coalesceMs);
    outbox.enqueue(event('queued'));
    outbox.close();
    expect(outbox.snapshot()).toMatchObject({ count: 0, bytes: 0, subscriptions: 0 });
    outbox.subscribe('first');
    outbox.enqueue(event('fresh'));
    pending.reject(new Error('old delivery failed'));
    await vi.runAllTimersAsync();
    await Promise.all(work);
    expect(send.mock.calls.map(([batch]) => batch.kind)).toEqual(['events', 'events']);
    expect(outbox.refresh('first', 1)).toBe(true);
    expect(outbox.snapshot()).toMatchObject({ count: 0, bytes: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
