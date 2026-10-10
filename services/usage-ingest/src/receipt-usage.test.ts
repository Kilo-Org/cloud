import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import { usage } from './usage.test-fixture';

function message(body: unknown, id = 'queue-message-1') {
  return {
    id,
    timestamp: new Date('2026-08-05T10:11:13.945Z'),
    attempts: 2,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  } satisfies Message<unknown>;
}

function batch(messages: Message<unknown>[]) {
  return {
    queue: 'usage-ingest-processing',
    messages,
    metadata: { metrics: { backlogCount: messages.length, backlogBytes: 1 } },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } satisfies MessageBatch<unknown>;
}

afterEach(() => vi.restoreAllMocks());

describe('shadow usage receipts', () => {
  it('logs only safe receipt fields before acknowledging each message once', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-05T10:11:14.945Z'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const messages = [
      message(usage),
      message(
        { ...usage, core: { ...usage.core, id: '4f2504e0-4f89-11d3-9a0c-0305e82c3302' } },
        'queue-message-2'
      ),
    ];
    const receipts = batch(messages);
    worker.queue(receipts);
    messages.forEach((msg, index) => {
      expect(JSON.parse(log.mock.calls[index][0])).toEqual({
        event: 'usage_ingest_receipt',
        outcome: 'received',
        queue_message_id: msg.id,
        delivery_attempts: 2,
        usage_id: index === 0 ? usage.core.id : '4f2504e0-4f89-11d3-9a0c-0305e82c3302',
        event_age_ms: 2000,
      });
      expect(msg.ack).toHaveBeenCalledExactlyOnceWith();
      expect(log.mock.invocationCallOrder[index]).toBeLessThan(
        vi.mocked(msg.ack).mock.invocationCallOrder[0]
      );
      expect(msg.retry).not.toHaveBeenCalled();
    });
    expect(receipts.ackAll).not.toHaveBeenCalled();
    expect(receipts.retryAll).not.toHaveBeenCalled();
  });

  it('clamps clock skew to zero event age', () => {
    vi.spyOn(Date, 'now').mockReturnValue(0);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    worker.queue(batch([message(usage)]));
    expect(JSON.parse(log.mock.calls[0][0]).event_age_ms).toBe(0);
  });

  it('continues through an invalid body in a mixed successful batch', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const messages = [message(usage, 'first'), message(null, 'invalid'), message(usage, 'last')];
    worker.queue(batch(messages));
    expect(log.mock.calls.map(([value]) => JSON.parse(value).outcome)).toEqual([
      'received',
      'invalid',
      'received',
    ]);
    for (const [index, msg] of messages.entries()) {
      expect(msg.ack).toHaveBeenCalledExactlyOnceWith();
      expect(log.mock.invocationCallOrder[index]).toBeLessThan(msg.ack.mock.invocationCallOrder[0]);
      expect(msg.retry).not.toHaveBeenCalled();
    }
  });

  it.each([
    null,
    'sensitive body',
    { ...usage, core: { ...usage.core, id: 'sensitive invalid id' } },
  ])('logs a categorical invalid receipt and discards malformed messages without leakage', body => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const msg = message(body);
    worker.queue(batch([msg]));
    expect(log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        event: 'usage_ingest_receipt',
        outcome: 'invalid',
        queue_message_id: msg.id,
        delivery_attempts: 2,
      })
    );
    expect(msg.ack).toHaveBeenCalledExactlyOnceWith();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it.each([usage, null])(
    'throws on logging failure without acknowledging failed or later messages',
    body => {
      const log = vi
        .spyOn(console, 'log')
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {
          throw new Error('synthetic logging failure');
        });
      const messages = [message(usage), message(body, 'failed'), message(usage, 'later')];
      expect(() => worker.queue(batch(messages))).toThrow('synthetic logging failure');
      expect(log).toHaveBeenCalledTimes(2);
      expect(messages[0].ack).toHaveBeenCalledExactlyOnceWith();
      expect(messages[1].ack).not.toHaveBeenCalled();
      expect(messages[2].ack).not.toHaveBeenCalled();
    }
  );
});
