import { describe, expect, it } from 'vitest';
import {
  createPendingSessionMessage,
  storePendingSessionMessage,
  type SessionQueueStorage,
} from './pending-messages.js';
import { resolveSessionMessageResult } from './message-result.js';
import {
  putSessionMessageState,
  type SessionMessageState,
  type SessionMessageStorage,
} from './session-message-state.js';

type FakeStorage = SessionMessageStorage &
  SessionQueueStorage & {
    store: Map<string, unknown>;
  };

function createFakeStorage(): FakeStorage {
  const store = new Map<string, unknown>();
  return {
    store,
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    async delete(keys: string | string[]): Promise<void> {
      for (const key of typeof keys === 'string' ? [keys] : keys) store.delete(key);
    },
    async list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>> {
      const entries = new Map<string, T>();
      for (const [key, value] of store.entries()) {
        if (key.startsWith(options.prefix)) entries.set(key, value as T);
      }
      return entries;
    },
  };
}

const messageA = 'msg_0123456789abAAAAAAAAAAAAAA';

function lifecycleState(
  messageId: string,
  overrides: Partial<SessionMessageState> = {}
): SessionMessageState {
  return {
    messageId,
    status: 'queued',
    prompt: 'secret prompt',
    createdAt: 1,
    queuedAt: 1,
    ...overrides,
  };
}

async function storePending(
  storage: FakeStorage,
  messageId: string,
  createdAt: number,
  overrides: Parameters<typeof createPendingSessionMessage>[0] extends infer Params
    ? Partial<Params>
    : never = {}
): Promise<void> {
  await storePendingSessionMessage(
    storage,
    createPendingSessionMessage({
      messageId,
      role: 'user',
      content: 'secret pending prompt',
      createdAt,
      ...overrides,
    })
  );
}

describe('resolveSessionMessageResult', () => {
  it('returns an allowlisted exact lifecycle projection and maps accepted to running', async () => {
    const storage = createFakeStorage();
    await putSessionMessageState(
      storage,
      lifecycleState(messageA, {
        status: 'accepted',
        acceptedAt: 2,
        admissionSnapshot: {
          turn: { type: 'prompt', messageId: messageA, prompt: 'private admission prompt' },
          agent: { mode: 'code', model: 'private-model' },
        },
        callbackTarget: { url: 'https://example.com', headers: { Authorization: 'secret' } },
        error: 'private raw error',
        failureReason: 'private failure reason',
      })
    );

    await expect(resolveSessionMessageResult(storage, messageA)).resolves.toEqual({
      type: 'found',
      result: {
        messageId: messageA,
        status: 'running',
        createdAt: 1,
        queuedAt: 1,
        acceptedAt: 2,
      },
    });
  });

  it('returns a queued recovery projection for exact pending-only rows', async () => {
    const storage = createFakeStorage();
    await storePending(storage, messageA, 3, {
      lastFlushError: 'private flush error',
      callbackSnapshot: {
        required: true,
        target: { url: 'https://example.com', headers: { Authorization: 'secret' } },
      },
    });

    await expect(resolveSessionMessageResult(storage, messageA)).resolves.toEqual({
      type: 'found',
      result: {
        messageId: messageA,
        status: 'queued',
        createdAt: 3,
        queuedAt: 3,
      },
    });
  });

  it('returns undefined for an unknown exact message', async () => {
    const storage = createFakeStorage();
    await expect(resolveSessionMessageResult(storage, messageA)).resolves.toBeUndefined();
  });

  it('prefers lifecycle state over a duplicate pending row', async () => {
    const storage = createFakeStorage();
    await storePending(storage, messageA, 20);
    await putSessionMessageState(
      storage,
      lifecycleState(messageA, { status: 'completed', createdAt: 10, terminalAt: 30 })
    );

    await expect(resolveSessionMessageResult(storage, messageA)).resolves.toMatchObject({
      result: { messageId: messageA, status: 'completed', createdAt: 10 },
    });
  });

  it('returns an exact assistant lookup for completed lifecycle rows with assistant identity', async () => {
    const storage = createFakeStorage();
    await putSessionMessageState(
      storage,
      lifecycleState(messageA, {
        status: 'completed',
        assistantMessageId: 'assistant_exact',
        terminalAt: 4,
      })
    );

    await expect(resolveSessionMessageResult(storage, messageA)).resolves.toMatchObject({
      assistantLookup: {
        type: 'message-id',
        messageId: 'assistant_exact',
        parentMessageId: messageA,
      },
    });
  });

  it('omits assistant lookup for completed lifecycle rows without assistant identity', async () => {
    const storage = createFakeStorage();
    await putSessionMessageState(
      storage,
      lifecycleState(messageA, { status: 'completed', terminalAt: 4 })
    );

    await expect(resolveSessionMessageResult(storage, messageA)).resolves.toEqual({
      type: 'found',
      result: {
        messageId: messageA,
        status: 'completed',
        createdAt: 1,
        queuedAt: 1,
        terminalAt: 4,
      },
    });
  });

  it('projects only safe structured terminal fields without assistant lookup for failures', async () => {
    const storage = createFakeStorage();
    await putSessionMessageState(
      storage,
      lifecycleState(messageA, {
        status: 'failed',
        terminalAt: 4,
        completionSource: 'wrapper_failure',
        failureStage: 'agent_activity',
        failureCode: 'assistant_error',
        attempts: 2,
        error: 'private raw error',
        failureReason: 'private reason',
        terminalEffects: {
          event: 'pending',
          callback: { disposition: 'pending', allowWithoutObservedIdle: false },
        },
      })
    );

    await expect(resolveSessionMessageResult(storage, messageA)).resolves.toEqual({
      type: 'found',
      result: {
        messageId: messageA,
        status: 'failed',
        createdAt: 1,
        queuedAt: 1,
        terminalAt: 4,
        completionSource: 'wrapper_failure',
        failure: { stage: 'agent_activity', code: 'assistant_error', attempts: 2 },
      },
    });
  });
});
