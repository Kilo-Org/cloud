import { describe, expect, it, mock, spyOn } from 'bun:test';
import {
  sessionOperationExpiresAt,
  type SessionOperationAck,
  type SessionOperationDelivery,
} from '../../../src/shared/sandbox-control-protocol';
import { acknowledgeOperation, operationAuthorization } from './control-test-fixtures';
import { createOperationResultDelivery } from './operation-result-delivery';
import { ControlDeliveryError } from './sandbox-control-client';

function result(): SessionOperationDelivery {
  return {
    version: 2,
    authorization: operationAuthorization(),
    completedAt: Date.now(),
    result: { ok: true, result: {} },
    outcome: { messageId: 'msg_1', status: 'completed' },
    events: [],
    preparing: [],
  };
}

describe('sealed operation result delivery', () => {
  it('seals producer data and starts delivery once without exposing mutable result state', async () => {
    const original = result();
    const expected = structuredClone(original);
    const send = mock(async (payload: SessionOperationDelivery) => acknowledgeOperation(payload));
    const delivery = createOperationResultDelivery(original, Date.now() + 1_000, send);
    original.outcome = { messageId: 'msg_1', status: 'failed', reason: 'caller mutation' };
    original.events.push({
      type: 'status',
      properties: { messageId: 'msg_1', message: 'caller mutation' },
    });
    const first = delivery.start();
    expect(delivery.start()).toBe(first);
    await delivery.drain();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual(expected);
    const snapshot = delivery.snapshot();
    snapshot.payload.outcome = { messageId: 'msg_1', status: 'cancelled' };
    expect(delivery.result()).toEqual(expected);
    expect(delivery.status().state).toBe('acknowledged');
  });

  it('retains an exact acknowledgement when cancelled transport waiting later rejects', async () => {
    const held = Promise.withResolvers<SessionOperationAck>();
    const sending = Promise.withResolvers<AbortSignal>();
    const payload = result();
    const delivery = createOperationResultDelivery(
      payload,
      Date.now() + 1_000,
      (_payload, signal) => {
        sending.resolve(signal);
        return held.promise;
      }
    );
    void delivery.start();
    const signal = await sending.promise;
    const ack = await acknowledgeOperation(payload);
    try {
      expect(await delivery.acknowledge({ ...ack, resultHash: '0'.repeat(64) }, () => true)).toBe(
        false
      );
      expect(await delivery.acknowledge(ack, () => true)).toBe(true);
      expect(signal.aborted).toBe(true);
      held.reject(new Error('Transport completed late'));
      await delivery.drain();
      expect(delivery.snapshot().acknowledgement).toEqual(ack);
      expect(delivery.status().state).toBe('acknowledged');
      expect(delivery.result()).toEqual(payload);
    } finally {
      held.resolve(ack);
      await delivery.drain();
    }
  });

  it('rechecks current identity and authorization expiry after hashing an explicit acknowledgement', async () => {
    const payload = result();
    const delivery = createOperationResultDelivery(payload, Date.now() + 1_000);
    const ack = await acknowledgeOperation(payload);
    let current = true;
    const superseded = delivery.acknowledge(ack, () => current);
    current = false;
    expect(await superseded).toBe(false);
    const clock = spyOn(Date, 'now');
    try {
      const expired = delivery.acknowledge(ack, () => true);
      clock.mockReturnValue(sessionOperationExpiresAt(payload.authorization));
      expect(await expired).toBe(false);
      expect(delivery.status().state).toBe('pending');
      expect(delivery.result()).toEqual(payload);
    } finally {
      clock.mockRestore();
    }
  });

  it('stops retrying after a permanent rejection but retains the unacknowledged result', async () => {
    let attempts = 0;
    const payload = result();
    const deadlineAt = Date.now() + 500;
    const delivery = createOperationResultDelivery(payload, deadlineAt, async () => {
      attempts++;
      throw new ControlDeliveryError('Control delivery was not acknowledged', false);
    });
    void delivery.start();
    await delivery.drain();
    expect(attempts).toBe(1);
    expect(delivery.status().state).toBe('exhausted');
    expect(delivery.result()).toEqual(payload);
  });

  it('retries transient failures but stops at the attempt limit', async () => {
    let attempts = 0;
    const payload = result();
    const deadlineAt = Date.now() + 4_500;
    const delivery = createOperationResultDelivery(payload, deadlineAt, async () => {
      attempts++;
      throw new ControlDeliveryError('Control transport unavailable', true);
    });
    void delivery.start();
    await delivery.drain();
    expect(attempts).toBe(3);
    expect(delivery.status().state).toBe('exhausted');
    expect(delivery.result()).toEqual(payload);
  });

  it('exhausts the original delivery deadline without replaying after a late valid acknowledgement', async () => {
    const payload = result();
    const now = Date.now();
    const deadlineAt = now + 1_000;
    const clock = spyOn(Date, 'now').mockReturnValue(now);
    const held = Promise.withResolvers<SessionOperationAck>();
    const sending = Promise.withResolvers<void>();
    const send = mock(() => {
      sending.resolve();
      return held.promise;
    });
    const delivery = createOperationResultDelivery(payload, deadlineAt, send);
    try {
      void delivery.start();
      await sending.promise;
      const ack = await acknowledgeOperation(payload);
      clock.mockReturnValue(deadlineAt);
      held.resolve(ack);
      await delivery.drain();
      await delivery.start();
      expect(delivery.status()).toEqual({ state: 'exhausted', deadlineAt });
      expect(send).toHaveBeenCalledTimes(1);
      expect(delivery.result()).toEqual(payload);
    } finally {
      held.resolve(await acknowledgeOperation(payload));
      await delivery.drain();
      clock.mockRestore();
    }
  });
});
