import { describe, expect, it, vi } from 'vitest';
import type {
  ResponseFrame,
  SessionOperationDelivery,
} from '../shared/sandbox-control-protocol.js';
import { persistSessionOperationDelivery } from './session-delivery.js';

const delivery: SessionOperationDelivery = {
  version: 2,
  authorization: {
    operation: 'session.prompt',
    operationId: 'delivery_operation',
    messageId: 'delivery_message',
    session: {
      sessionId: 'workspace_delivery',
      kiloSessionId: 'kilo_delivery',
      directory: '/workspace/delivery',
    },
    wrapperInstanceId: '11111111-1111-4111-8111-111111111111',
    dispatchDeadlineAt: Date.now() + 60_000,
  },
  completedAt: Date.now(),
  result: { ok: true, result: { messageId: 'delivery_message', status: 'accepted' } },
  outcome: { messageId: 'delivery_message', status: 'completed' },
  events: [],
  preparing: [],
};

function response(): ResponseFrame {
  return { type: 'response', requestId: 'ack', ok: true, result: { acknowledged: true } };
}

describe('persistSessionOperationDelivery', () => {
  it('persists before starting the acknowledgement handoff', async () => {
    const request = vi.fn(async () => response());
    const persistResult = vi.fn(async () => ({
      version: 2 as const,
      authorization: delivery.authorization,
      resultHash: 'result',
      disposition: 'applied' as const,
      decision: { state: 'completed' as const, at: delivery.completedAt },
    }));

    await expect(
      persistSessionOperationDelivery(delivery, Date.now() + 60_000, {
        request,
        persistResult,
        assertScope: () => undefined,
        defer: pending => void pending,
      })
    ).resolves.toBe('persisted');
    await Promise.resolve();
    expect(persistResult.mock.invocationCallOrder[0]).toBeLessThan(
      request.mock.invocationCallOrder[0]
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'session.operation.ack' }),
      expect.any(Object)
    );
  });

  it('does not acknowledge an unpersisted result', async () => {
    const request = vi.fn(async () => response());

    await expect(
      persistSessionOperationDelivery(delivery, Date.now() + 60_000, {
        request,
        persistResult: async () => undefined,
        assertScope: () => undefined,
        defer: pending => void pending,
      })
    ).resolves.toBe('unverified');
    expect(request).not.toHaveBeenCalled();
  });
});
