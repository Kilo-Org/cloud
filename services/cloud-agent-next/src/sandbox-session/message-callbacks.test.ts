import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallbackJob } from '../callbacks/types.js';
import { logger } from '../logger.js';
import { parseSessionMetadata, type SessionMetadata } from '../persistence/session-metadata.js';
import type { LatestAssistantMessage } from '../session/types.js';
import {
  CALLBACK_ENQUEUE_MAX_ATTEMPTS,
  CALLBACK_ENQUEUE_RETRY_MS,
  callbackOutboxKey,
  createMessageCallbacks,
  parseCallbackOutboxValue,
} from './message-callbacks.js';
import type { MessageState } from '../sandbox-state/model/session.js';
import type { SessionMessage } from './session-message-queue.js';

const SESSION_ID = 'workspace_callback_test';
const KILO_SESSION_ID = 'kilo_callback_test';
const MESSAGE_ID = 'message_callback_test';

afterEach(() => {
  vi.restoreAllMocks();
});

type MemoryKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
  list<T>(options?: { prefix?: string }): Iterable<[string, T]>;
};

function memoryKv(): MemoryKv {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: <T>(key: string, value: T) => values.set(key, structuredClone(value)),
    delete: key => values.delete(key),
    list: <T>(options?: { prefix?: string }) =>
      [...values.entries()]
        .filter(([key]) => options?.prefix === undefined || key.startsWith(options.prefix))
        .map(([key, value]) => [key, structuredClone(value) as T] as [string, T]),
  };
}

function metadataWithCallback(callbackUrl = 'https://example.com/callback'): SessionMetadata {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: { sessionId: SESSION_ID, userId: 'user_callback_test' },
    auth: { kiloSessionId: KILO_SESSION_ID },
    repository: { type: 'git', url: 'https://example.com/repository.git', upstreamBranch: 'main' },
    callback: { target: { url: callbackUrl, headers: { 'x-test': 'value' } } },
    workspace: { workspacePath: '/workspace/callback', branchName: 'feature/callback' },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

type TerminalKind = 'queued' | 'completed' | 'failed' | 'cancelled';

function stateFor(kind: TerminalKind, overrides: Record<string, unknown> = {}): MessageState {
  if (kind === 'queued') {
    return {
      kind,
      intent: null,
      legacyInvalidIntent: true,
      deliveryStep: 'waiting',
      deadlineAt: null,
      attachFailures: 0,
      promptFailures: 0,
      ...overrides,
    } as MessageState;
  }
  return {
    kind,
    intent: null,
    legacyInvalidIntent: true,
    at: 1,
    source: 'coordinator',
    ...overrides,
  } as MessageState;
}

function message(
  kind: TerminalKind,
  overrides: { messageId?: string; state?: Record<string, unknown> } = {}
): SessionMessage {
  const { messageId = MESSAGE_ID, state = {} } = overrides;
  return { messageId, state: stateFor(kind, state) };
}

function assistantMessage(text: string): LatestAssistantMessage {
  return {
    eventId: 1 as LatestAssistantMessage['eventId'],
    timestamp: 1,
    info: { id: 'assistant_1', role: 'assistant' },
    parts: [
      { id: 'part_1', messageID: 'assistant_1', type: 'text', text },
      { id: 'part_2', messageID: 'assistant_1', type: 'reasoning', text: 'ignored' },
    ],
  };
}

function createHarness(
  options: { queue?: Pick<Queue<CallbackJob>, 'send'>; callbackUrl?: string } = {}
) {
  const kv = memoryKv();
  let metadata = metadataWithCallback(options.callbackUrl);
  const callbacks = createMessageCallbacks({
    storage: { kv } as DurableObjectStorage,
    getMetadata: () => metadata,
    getCallbackQueue: () => options.queue,
    getAssistantMessageForUserMessage: () => assistantMessage('the final answer'),
  });
  return {
    kv,
    callbacks,
    setMetadata: (next: SessionMetadata) => {
      metadata = next;
    },
  };
}

describe('createMessageCallbacks', () => {
  it('stores one immutable fitted snapshot for a completed message', () => {
    const harness = createHarness();

    expect(harness.callbacks.persistTerminalCallback(message('completed'))).toBe(true);
    expect(harness.callbacks.persistTerminalCallback(message('completed'))).toBe(false);

    const stored = harness.kv.get<unknown>(callbackOutboxKey(MESSAGE_ID));
    expect(parseCallbackOutboxValue(stored)).toMatchObject({
      attempts: 0,
      job: {
        target: { url: 'https://example.com/callback', headers: { 'x-test': 'value' } },
        payload: {
          sessionId: SESSION_ID,
          cloudAgentSessionId: SESSION_ID,
          executionId: MESSAGE_ID,
          messageId: MESSAGE_ID,
          status: 'completed',
          lastSeenBranch: 'main',
          kiloSessionId: KILO_SESSION_ID,
          lastAssistantMessageText: 'the final answer',
          idempotencyKey: MESSAGE_ID,
        },
      },
    });

    const changedMetadata = metadataWithCallback();
    changedMetadata.callback!.target!.url = 'https://example.com/changed';
    harness.setMetadata(changedMetadata);
    expect(harness.kv.get<unknown>(callbackOutboxKey(MESSAGE_ID))).toMatchObject({
      job: { target: { url: 'https://example.com/callback' } },
    });
  });

  it('carries a gate result into the callback payload when the record has one', () => {
    const harness = createHarness();

    expect(
      harness.callbacks.persistTerminalCallback(
        message('completed', { state: { gateResult: 'pass' } })
      )
    ).toBe(true);

    const stored = harness.kv.get<unknown>(callbackOutboxKey(MESSAGE_ID));
    expect(parseCallbackOutboxValue(stored)?.job.payload).toMatchObject({ gateResult: 'pass' });
  });

  it('omits the gate result key from the callback payload when the record has none', () => {
    const harness = createHarness();

    expect(harness.callbacks.persistTerminalCallback(message('completed'))).toBe(true);

    const stored = harness.kv.get<unknown>(callbackOutboxKey(MESSAGE_ID));
    const payload = parseCallbackOutboxValue(stored)?.job.payload;
    expect(payload).toBeDefined();
    expect(payload && 'gateResult' in payload).toBe(false);
  });

  it.each([
    ['failed', 'provider rejected the request', 'provider rejected the request'],
    ['cancelled', undefined, 'The message was interrupted'],
  ] as const)('projects %s terminal details into the callback', (state, detail, errorMessage) => {
    const harness = createHarness();
    const record = message(state, {
      state: {
        ...(detail ? { detail } : {}),
        reason: 'runtime_unhealthy',
      },
    });

    expect(harness.callbacks.persistTerminalCallback(record)).toBe(true);
    expect(harness.kv.get<unknown>(callbackOutboxKey(MESSAGE_ID))).toMatchObject({
      job: {
        payload: {
          status: state === 'cancelled' ? 'interrupted' : state,
          errorMessage,
          clientError: { message: errorMessage },
        },
      },
    });
  });

  it('retries missing callback bindings five times and abandons the pending job', async () => {
    const harness = createHarness();
    expect(harness.callbacks.persistTerminalCallback(message('failed'))).toBe(true);
    const initialNow = Date.now();

    for (let attempt = 1; attempt <= CALLBACK_ENQUEUE_MAX_ATTEMPTS; attempt++) {
      const now = initialNow + (attempt - 1) * CALLBACK_ENQUEUE_RETRY_MS;
      await harness.callbacks.repair(now);
      if (attempt < CALLBACK_ENQUEUE_MAX_ATTEMPTS) {
        expect(harness.callbacks.nextCallbackDueAt()).toBe(now + CALLBACK_ENQUEUE_RETRY_MS);
        expect(harness.callbacks.pendingCallbackCount()).toBe(1);
      }
    }

    expect(harness.callbacks.pendingCallbackCount()).toBe(0);
  });

  it('logs only the callback origin when a missing binding abandons a secret-bearing target', async () => {
    const userInfoSecret = 'callback-userinfo-secret';
    const pathSecret = 'callback-path-secret';
    const querySecret = 'callback-query-secret';
    const callbackUrl = `https://webhook-user:${userInfoSecret}@callback.example/hooks/${pathSecret}?token=${querySecret}`;
    const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
    const harness = createHarness({ callbackUrl });
    expect(harness.callbacks.persistTerminalCallback(message('failed'))).toBe(true);
    const initialNow = Date.now();

    for (let attempt = 1; attempt <= CALLBACK_ENQUEUE_MAX_ATTEMPTS; attempt += 1) {
      await harness.callbacks.repair(initialNow + (attempt - 1) * CALLBACK_ENQUEUE_RETRY_MS);
    }

    const serializedFields = JSON.stringify(fields.mock.calls);
    expect(serializedFields).not.toContain(userInfoSecret);
    expect(serializedFields).not.toContain(pathSecret);
    expect(serializedFields).not.toContain(querySecret);
    expect(fields).toHaveBeenCalledWith(
      expect.objectContaining({ callbackTarget: 'https://callback.example' })
    );
    expect(harness.callbacks.pendingCallbackCount()).toBe(0);
  });

  it('logs only the callback origin when rejected sends abandon a secret-bearing target', async () => {
    const userInfoSecret = 'rejected-userinfo-secret';
    const pathSecret = 'rejected-path-secret';
    const querySecret = 'rejected-query-secret';
    const callbackUrl = `https://webhook-user:${userInfoSecret}@callback.example/hooks/${pathSecret}?token=${querySecret}`;
    const send = vi.fn(async (_job: CallbackJob) => {
      throw new Error('callback queue rejected');
    });
    const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
    const harness = createHarness({ callbackUrl, queue: { send } });
    expect(harness.callbacks.persistTerminalCallback(message('failed'))).toBe(true);
    const initialNow = Date.now();

    for (let attempt = 1; attempt <= CALLBACK_ENQUEUE_MAX_ATTEMPTS; attempt += 1) {
      await harness.callbacks.repair(initialNow + (attempt - 1) * CALLBACK_ENQUEUE_RETRY_MS);
    }

    const serializedFields = JSON.stringify(fields.mock.calls);
    expect(serializedFields).not.toContain(userInfoSecret);
    expect(serializedFields).not.toContain(pathSecret);
    expect(serializedFields).not.toContain(querySecret);
    expect(fields).toHaveBeenCalledWith(
      expect.objectContaining({ callbackTarget: 'https://callback.example' })
    );
    expect(send).toHaveBeenCalledTimes(CALLBACK_ENQUEUE_MAX_ATTEMPTS);
    expect(harness.callbacks.pendingCallbackCount()).toBe(0);
  });

  it('deletes a pending snapshot only after a successful queue send', async () => {
    const send = vi.fn(async (_job: CallbackJob) => ({}) as QueueSendResponse);
    const harness = createHarness({ queue: { send } });
    expect(harness.callbacks.persistTerminalCallback(message('completed'))).toBe(true);

    await harness.callbacks.repair(Date.now());

    expect(send).toHaveBeenCalledOnce();
    expect(harness.callbacks.pendingCallbackCount()).toBe(0);
  });

  describe('persistDrainedBatchCallback', () => {
    it('persists one job for the last admitted terminal message of a drained batch', async () => {
      const send = vi.fn(async (_job: CallbackJob) => ({}) as QueueSendResponse);
      const harness = createHarness({ queue: { send } });
      const messages = [
        message('completed', { messageId: 'a' }),
        message('completed', { messageId: 'b' }),
        message('completed', { messageId: 'c' }),
      ];

      expect(
        harness.callbacks.persistDrainedBatchCallback(messages, new Set(['a', 'b', 'c']))
      ).toBe(true);

      expect(harness.callbacks.pendingCallbackCount()).toBe(1);
      expect(
        parseCallbackOutboxValue(harness.kv.get(callbackOutboxKey('c')))?.job.payload
      ).toMatchObject({
        messageId: 'c',
        executionId: 'c',
        idempotencyKey: 'c',
        status: 'completed',
        lastAssistantMessageText: 'the final answer',
      });
      expect(harness.kv.get(callbackOutboxKey('a'))).toBeUndefined();
      expect(harness.kv.get(callbackOutboxKey('b'))).toBeUndefined();

      await harness.callbacks.repair(Date.now());
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[0].payload.messageId).toBe('c');
    });

    it('persists nothing while the post-write batch still has queued work', () => {
      const harness = createHarness();
      const messages = [
        message('completed', { messageId: 'a' }),
        message('completed', { messageId: 'b' }),
        message('queued', { messageId: 'c' }),
      ];

      expect(harness.callbacks.persistDrainedBatchCallback(messages, new Set(['a', 'b']))).toBe(
        false
      );
      expect(harness.callbacks.pendingCallbackCount()).toBe(0);
    });

    it('coalesces sequential drain checks to the last admitted terminal message', () => {
      const harness = createHarness();

      expect(
        harness.callbacks.persistDrainedBatchCallback(
          [
            message('completed', { messageId: 'a' }),
            message('queued', { messageId: 'b' }),
            message('queued', { messageId: 'c' }),
          ],
          new Set(['a'])
        )
      ).toBe(false);
      expect(
        harness.callbacks.persistDrainedBatchCallback(
          [
            message('completed', { messageId: 'a' }),
            message('completed', { messageId: 'b' }),
            message('queued', { messageId: 'c' }),
          ],
          new Set(['b'])
        )
      ).toBe(false);
      expect(
        harness.callbacks.persistDrainedBatchCallback(
          [
            message('completed', { messageId: 'a' }),
            message('completed', { messageId: 'b' }),
            message('completed', { messageId: 'c' }),
          ],
          new Set(['c'])
        )
      ).toBe(true);

      expect(harness.callbacks.pendingCallbackCount()).toBe(1);
      expect(
        parseCallbackOutboxValue(harness.kv.get(callbackOutboxKey('c')))?.job.payload.messageId
      ).toBe('c');
    });

    it('does not persist for a drained write that terminalized nothing', () => {
      const harness = createHarness();

      expect(
        harness.callbacks.persistDrainedBatchCallback(
          [message('completed', { messageId: 'a' })],
          new Set()
        )
      ).toBe(false);
      expect(harness.callbacks.pendingCallbackCount()).toBe(0);
    });

    it('persists the last admitted payload when a mixed batch drains on a failure', () => {
      const harness = createHarness();

      expect(
        harness.callbacks.persistDrainedBatchCallback(
          [
            message('completed', { messageId: 'a' }),
            message('failed', {
              messageId: 'b',
              state: { detail: 'provider rejected the request' },
            }),
          ],
          new Set(['a', 'b'])
        )
      ).toBe(true);

      expect(
        parseCallbackOutboxValue(harness.kv.get(callbackOutboxKey('b')))?.job.payload
      ).toMatchObject({
        messageId: 'b',
        status: 'failed',
        errorMessage: 'provider rejected the request',
      });
    });

    it('projects a single drained cancellation as an interrupted callback', () => {
      const harness = createHarness();

      expect(
        harness.callbacks.persistDrainedBatchCallback(
          [message('cancelled', { messageId: 'a' })],
          new Set(['a'])
        )
      ).toBe(true);

      expect(
        parseCallbackOutboxValue(harness.kv.get(callbackOutboxKey('a')))?.job.payload.status
      ).toBe('interrupted');
    });

    it('persists a second drained batch after the first job was sent', async () => {
      const send = vi.fn(async (_job: CallbackJob) => ({}) as QueueSendResponse);
      const harness = createHarness({ queue: { send } });

      expect(
        harness.callbacks.persistDrainedBatchCallback(
          [message('completed', { messageId: 'a' }), message('completed', { messageId: 'b' })],
          new Set(['a', 'b'])
        )
      ).toBe(true);
      await harness.callbacks.repair(Date.now());
      expect(send).toHaveBeenCalledOnce();
      expect(harness.callbacks.pendingCallbackCount()).toBe(0);

      expect(
        harness.callbacks.persistDrainedBatchCallback(
          [
            message('completed', { messageId: 'a' }),
            message('completed', { messageId: 'b' }),
            message('completed', { messageId: 'c' }),
            message('completed', { messageId: 'd' }),
          ],
          new Set(['c', 'd'])
        )
      ).toBe(true);
      await harness.callbacks.repair(Date.now());
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]?.[0].payload.messageId).toBe('d');
    });
  });
});
