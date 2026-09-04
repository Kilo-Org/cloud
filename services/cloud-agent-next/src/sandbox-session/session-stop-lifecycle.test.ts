import { describe, expect, it, vi } from 'vitest';
import type { ControlStopRequest } from '../shared/control-plane-session.js';
import { SANDBOX_CONTROL_OPERATION_LIMIT } from '../shared/sandbox-control-protocol.js';
import type { SessionMessageRecord } from './session-message-queue.js';
import { createSessionStopLifecycle } from './session-stop-lifecycle.js';
import type { PersistedSessionStop } from './session-stop.js';

const RUNTIME_A = '11111111-1111-4111-8111-111111111111';

function request(index: number, deadlineAt = 11_000): ControlStopRequest {
  return {
    version: 1,
    operationId: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
    scope: { sandboxId: 'sandbox-a', wrapperInstanceId: RUNTIME_A },
    targets: [
      {
        messageId: `message-${index}`,
        wrapperInstanceId: RUNTIME_A,
        executionDeadlineAt: 3_601_000,
      },
    ],
    cleanupDeadlineAt: deadlineAt,
  };
}

function message(index: number): SessionMessageRecord {
  return {
    messageId: `message-${index}`,
    state: 'accepted',
    wrapperInstanceId: RUNTIME_A,
    executionDeadlineAt: 3_601_000,
  };
}

function lifecycleStore() {
  const values = new Map<string, unknown>();
  let legacy: unknown;
  return {
    values,
    setLegacy(value: unknown) {
      legacy = value;
    },
    lifecycle: createSessionStopLifecycle({
      list: () => [...values.entries()],
      readLegacy: () => legacy,
      put: (key, value) => values.set(key, structuredClone(value)),
      delete: key => {
        values.delete(key);
      },
      deleteLegacy: () => {
        legacy = undefined;
      },
      transaction: callback => callback(),
    }),
  };
}

describe('Session Stop lifecycle persistence', () => {
  it('keeps an admitted receipt absent when the paired message transaction fails', () => {
    const store = lifecycleStore();
    const messages = [message(1)];

    expect(() =>
      store.lifecycle.admit({
        messages,
        request: request(1),
        currentSandboxId: 'sandbox-a',
        currentWrapperInstanceId: RUNTIME_A,
        now: 1_000,
        commit: () => false,
      })
    ).toThrow('Stop intent persistence failed');

    expect(messages).toEqual([message(1)]);
    expect(store.lifecycle.receipt(request(1).operationId)).toBeNull();
  });

  it('retains all unexpired receipts and rejects admission at capacity', () => {
    const store = lifecycleStore();
    for (let index = 0; index < SANDBOX_CONTROL_OPERATION_LIMIT; index++) {
      const receipt = store.lifecycle.admit({
        messages: [message(index)],
        request: request(index),
        currentSandboxId: 'sandbox-a',
        currentWrapperInstanceId: RUNTIME_A,
        now: 1_000,
        commit: (_messages, stop) => {
          store.lifecycle.persist(stop);
          return true;
        },
      });
      expect(receipt.state).toBe('accepted');
    }

    const blocked = store.lifecycle.admit({
      messages: [message(SANDBOX_CONTROL_OPERATION_LIMIT)],
      request: request(SANDBOX_CONTROL_OPERATION_LIMIT),
      currentSandboxId: 'sandbox-a',
      currentWrapperInstanceId: RUNTIME_A,
      now: 1_000,
      commit: () => true,
    });

    expect(blocked).toMatchObject({
      state: 'rejected',
      message: 'Stop receipt capacity is unavailable',
    });
    expect(store.lifecycle.pending()).toHaveLength(SANDBOX_CONTROL_OPERATION_LIMIT);
  });

  it('migrates a retained legacy receipt and prunes it only after its cleanup bound expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const store = lifecycleStore();
      const pending = store.lifecycle.admit({
        messages: [message(1)],
        request: request(1, 2_000),
        currentSandboxId: 'sandbox-a',
        currentWrapperInstanceId: RUNTIME_A,
        now: 1_000,
        commit: (_messages, stop) => {
          store.lifecycle.persist(stop);
          return true;
        },
      });
      const persisted = store.values.values().next().value as PersistedSessionStop;
      store.values.clear();
      store.setLegacy({ [pending.operationId]: { ...persisted, state: 'unconfirmed' } });

      expect(store.lifecycle.receipt(pending.operationId)).toMatchObject({ state: 'unconfirmed' });
      vi.setSystemTime(2_000);
      expect(store.lifecycle.get(pending.operationId)).toBeUndefined();
      expect(store.values).toEqual(new Map());
    } finally {
      vi.useRealTimers();
    }
  });
});
