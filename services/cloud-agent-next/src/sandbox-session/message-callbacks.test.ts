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
import type { SessionMessageRecord } from './session-message-queue.js';

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

function message(
  state: SessionMessageRecord['state'],
  fields: Record<string, unknown> = {}
): SessionMessageRecord {
  return { messageId: MESSAGE_ID, state, ...fields } as SessionMessageRecord;
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

  it.each([
    ['failed', 'provider rejected the request', 'provider rejected the request'],
    ['cancelled', undefined, 'The message was interrupted'],
  ] as const)('projects %s terminal details into the callback', (state, detail, errorMessage) => {
    const harness = createHarness();
    const record = message(state, {
      ...(detail ? { failedDetail: detail } : {}),
      failedReason: 'runtime_unhealthy',
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
});
