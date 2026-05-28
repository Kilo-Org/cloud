import { describe, expect, it } from 'vitest';
import {
  createPendingSessionMessage,
  createPendingSessionMessageFromIntent,
  resolvePendingSessionMessageExecutionOptions,
  resolvePendingSessionMessageIntent,
  storePendingSessionMessage,
  listPendingSessionMessages,
  countPendingSessionMessages,
  checkPendingSessionMessageCapacity,
  shouldSkipPendingFlush,
  recordPendingFlushFailure,
  deletePendingSessionMessageByMessageId,
  findPendingSessionMessageByMessageId,
  findPendingSessionMessageByClientRequestId,
  clearPendingSessionMessages,
  PENDING_SESSION_MESSAGE_LIMIT,
  type SessionQueueStorage,
  type PendingSessionMessage,
  type LegacyPendingSessionMessage,
} from './pending-messages.js';
import type { SessionMessageIntent } from '../execution/types.js';

type MemoryQueueStorage = SessionQueueStorage & { store: Map<string, unknown> };

function createMemoryStorage(initialEntries?: Array<[string, unknown]>): MemoryQueueStorage {
  const store = new Map(initialEntries ?? []);
  return {
    store,
    async get<T = unknown>(key: string) {
      return store.get(key) as T | undefined;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        store.delete(key);
      }
    },
    async list<T = unknown>({ prefix }: { prefix: string }) {
      return new Map(
        Array.from(store.entries()).filter(([key]) => key.startsWith(prefix)) as Array<[string, T]>
      );
    },
  };
}

const BASE_MSG_ID = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';

function makeMessage(overrides: Partial<LegacyPendingSessionMessage> = {}): PendingSessionMessage {
  return createPendingSessionMessage({
    messageId: BASE_MSG_ID,
    role: 'user',
    content: 'hello',
    createdAt: 1,
    ...overrides,
  });
}

describe('createPendingSessionMessage', () => {
  it('creates a valid message with required fields', () => {
    const message = makeMessage();
    expect(message.messageId).toBe(BASE_MSG_ID);
    expect(message.content).toBe('hello');
    expect(message.createdAt).toBe(1);
  });

  it('includes optional fields when provided', () => {
    const message = makeMessage({
      clientRequestId: 'client-1',
      callbackUrl: 'https://example.com/cb',
      callbackMetadata: { key: 'value' },
      executionOptions: { mode: 'code', model: 'gpt-4' },
    });
    expect(message.clientRequestId).toBe('client-1');
    expect(message.legacy?.callbackUrl).toBe('https://example.com/cb');
    expect(message.legacy?.callbackMetadata).toEqual({ key: 'value' });
    expect(message.legacy?.executionOptions).toEqual({ mode: 'code', model: 'gpt-4' });
  });

  it('omits empty executionOptions', () => {
    const message = makeMessage({ executionOptions: {} });
    expect(message.legacy?.executionOptions).toBeUndefined();
  });

  it('omits executionOptions with only undefined values', () => {
    const message = makeMessage({
      executionOptions: { mode: undefined, model: undefined },
    });
    expect(message.legacy?.executionOptions).toBeUndefined();
  });
});

describe('createPendingSessionMessageFromIntent', () => {
  it('writes one nested V2 intent record without legacy flat compatibility fields', async () => {
    const storage = createMemoryStorage();
    const intent: SessionMessageIntent = {
      turn: {
        type: 'prompt',
        messageId: 'msg_018f1e2d3c4bNestedAbCdEfGh',
        prompt: 'nested intent',
      },
      agent: { mode: 'code', model: 'claude' },
      finalization: { autoCommit: true },
    };

    await storePendingSessionMessage(storage, createPendingSessionMessageFromIntent(intent, 42));
    const entries = await storage.list<unknown>({ prefix: 'pending_message:' });
    const [stored] = entries.values();

    expect(stored).toEqual({
      version: 2,
      intent,
      delivery: { queuedAt: 42 },
    });
    expect(stored).not.toHaveProperty('content');
    expect(stored).not.toHaveProperty('executionOptions');
    expect(stored).not.toHaveProperty('executionId');
    expect(stored).not.toHaveProperty('clientRequestId');
    expect(stored).not.toHaveProperty('callbackUrl');
  });

  it('creates a canonical document message from a session message intent', () => {
    const intent: SessionMessageIntent = {
      turn: {
        type: 'prompt',
        messageId: 'msg_018f1e2d3c4bIntentAbCdEfGh',
        prompt: 'write tests',
        attachments: {
          path: '123e4567-e89b-12d3-a456-426614174000',
          files: ['123e4567-e89b-12d3-a456-426614174001.pdf'],
        },
      },
      agent: { mode: 'plan', model: 'claude', variant: 'thinking' },
      finalization: { autoCommit: true, condenseOnComplete: false },
    };

    const message = createPendingSessionMessageFromIntent(intent, 42);

    expect(message).toMatchObject({
      version: 2,
      messageId: 'msg_018f1e2d3c4bIntentAbCdEfGh',
      content: 'write tests',
      createdAt: 42,
      intent,
    });
  });

  it('does not decode stored V2 intents containing legacy images', async () => {
    const storage = createMemoryStorage([
      [
        `pending_message:0000000000000001:${BASE_MSG_ID}`,
        {
          version: 2,
          intent: {
            turn: {
              type: 'prompt',
              messageId: BASE_MSG_ID,
              prompt: 'old image record',
              images: {
                path: '123e4567-e89b-12d3-a456-426614174000',
                files: ['123e4567-e89b-12d3-a456-426614174001.png'],
              },
            },
            agent: { mode: 'code', model: 'claude' },
          },
          delivery: { queuedAt: 1 },
        },
      ],
    ]);

    expect(await listPendingSessionMessages(storage)).toEqual([]);
  });
});

describe('resolvePendingSessionMessageExecutionOptions', () => {
  it('merges message options over defaults', () => {
    const message = makeMessage({
      executionOptions: { mode: 'plan', model: 'gpt-4' },
    });
    const resolved = resolvePendingSessionMessageExecutionOptions(message, {
      mode: 'code',
      model: 'default-model',
      variant: 'alpha',
      autoCommit: false,
      condenseOnComplete: false,
    });
    expect(resolved.mode).toBe('plan');
    expect(resolved.model).toBe('gpt-4');
    expect(resolved.variant).toBe('alpha');
    expect(resolved.autoCommit).toBe(false);
  });

  it('falls back to defaults when message has no options', () => {
    const message = makeMessage();
    const resolved = resolvePendingSessionMessageExecutionOptions(message, {
      mode: 'code',
      model: 'default-model',
    });
    expect(resolved.mode).toBe('code');
    expect(resolved.model).toBe('default-model');
  });
});

describe('resolvePendingSessionMessageIntent', () => {
  it('restores an accepted turn plus resolved delivery semantics from flat pending storage', () => {
    const message = makeMessage({
      executionOptions: {
        mode: 'plan',
        model: 'queued-model',
        variant: 'thinking',
        autoCommit: true,
        condenseOnComplete: false,
        githubTokenOverride: 'github-override',
        gitTokenOverride: 'git-override',
      },
    });

    const intent = resolvePendingSessionMessageIntent(message, {
      mode: 'code',
      model: 'default-model',
    });

    expect(intent).toEqual({
      turn: {
        type: 'prompt',
        messageId: BASE_MSG_ID,
        prompt: 'hello',
      },
      agent: { mode: 'plan', model: 'queued-model', variant: 'thinking' },
      finalization: { autoCommit: true, condenseOnComplete: false },
    });
  });
});

describe('storePendingSessionMessage', () => {
  it('round-trips through listPendingSessionMessages', async () => {
    const storage = createMemoryStorage();
    const message = makeMessage();
    await storePendingSessionMessage(storage, message);

    const listed = await listPendingSessionMessages(storage);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject(message);
  });
});

describe('listPendingSessionMessages', () => {
  it('returns messages in FIFO order by createdAt', async () => {
    const storage = createMemoryStorage();
    await storePendingSessionMessage(
      storage,
      makeMessage({ messageId: 'msg_018f1e2d3c4bAAAAAAAAAAAAAA', createdAt: 10 })
    );
    await storePendingSessionMessage(
      storage,
      makeMessage({ messageId: 'msg_018f1e2d3c4bBBBBBBBBBBBBBB', createdAt: 20 })
    );
    await storePendingSessionMessage(
      storage,
      makeMessage({ messageId: 'msg_018f1e2d3c4bCCCCCCCCCCCCCC', createdAt: 30 })
    );

    const listed = await listPendingSessionMessages(storage);
    expect(listed.map(m => m.messageId)).toEqual([
      'msg_018f1e2d3c4bAAAAAAAAAAAAAA',
      'msg_018f1e2d3c4bBBBBBBBBBBBBBB',
      'msg_018f1e2d3c4bCCCCCCCCCCCCCC',
    ]);
  });

  it('skips invalid stored entries', async () => {
    const storage = createMemoryStorage();
    await storage.put('pending_message:0000000000000001:invalid', {
      messageId: 'bad',
      role: 'user',
      content: 'bad',
      createdAt: 1,
    });
    await storePendingSessionMessage(
      storage,
      makeMessage({ messageId: 'msg_018f1e2d3c4bValidMsgAbCdEf', createdAt: 2 })
    );

    const listed = await listPendingSessionMessages(storage);
    expect(listed.map(m => m.messageId)).toEqual(['msg_018f1e2d3c4bValidMsgAbCdEf']);
  });
});

describe('countPendingSessionMessages', () => {
  it('returns correct count', async () => {
    const storage = createMemoryStorage();
    expect(await countPendingSessionMessages(storage)).toBe(0);

    await storePendingSessionMessage(
      storage,
      makeMessage({ messageId: 'msg_018f1e2d3c4bAAAAAAAAAAAAAA', createdAt: 1 })
    );
    expect(await countPendingSessionMessages(storage)).toBe(1);

    await storePendingSessionMessage(
      storage,
      makeMessage({ messageId: 'msg_018f1e2d3c4bBBBBBBBBBBBBBB', createdAt: 2 })
    );
    expect(await countPendingSessionMessages(storage)).toBe(2);
  });
});

describe('checkPendingSessionMessageCapacity', () => {
  it('reports available when under limit', async () => {
    const storage = createMemoryStorage();
    const capacity = await checkPendingSessionMessageCapacity(storage);
    expect(capacity.available).toBe(true);
    expect(capacity.count).toBe(0);
    expect(capacity.limit).toBe(PENDING_SESSION_MESSAGE_LIMIT);
  });

  it('reports unavailable at limit', async () => {
    const storage = createMemoryStorage();
    for (let i = 0; i < PENDING_SESSION_MESSAGE_LIMIT; i++) {
      await storePendingSessionMessage(
        storage,
        makeMessage({ messageId: `msg_018f1e2d3c4b${String(i).padStart(14, 'A')}`, createdAt: i })
      );
    }
    const capacity = await checkPendingSessionMessageCapacity(storage);
    expect(capacity.available).toBe(false);
    expect(capacity.count).toBe(PENDING_SESSION_MESSAGE_LIMIT);
    expect(capacity.message).toContain('full');
  });
});

describe('shouldSkipPendingFlush', () => {
  it('skips when nextFlushAttemptAt is in the future', () => {
    const message = makeMessage({ nextFlushAttemptAt: 100 });
    expect(shouldSkipPendingFlush(message, 50)).toBe(true);
  });

  it('does not skip when nextFlushAttemptAt is in the past', () => {
    const message = makeMessage({ nextFlushAttemptAt: 50 });
    expect(shouldSkipPendingFlush(message, 100)).toBe(false);
  });

  it('does not skip when nextFlushAttemptAt is undefined', () => {
    const message = makeMessage();
    expect(shouldSkipPendingFlush(message, 100)).toBe(false);
  });
});

describe('recordPendingFlushFailure', () => {
  it('schedules only one warm-followup retry', async () => {
    const storage = createMemoryStorage();
    let message = makeMessage();
    await storePendingSessionMessage(storage, message);

    const delays: (number | undefined)[] = [];
    const now = 100_000;

    for (let i = 0; i < 2; i++) {
      const result = await recordPendingFlushFailure(storage, message, 'error', now, {
        policy: 'warm-followup',
        code: 'WORKSPACE_SETUP_FAILED',
      });
      delays.push(
        result.nextFlushAttemptAt !== undefined ? result.nextFlushAttemptAt - now : undefined
      );
      message = result.message;
    }

    expect(delays).toEqual([2_000, undefined]);
  });

  it('schedules only one cold-init retry', async () => {
    const storage = createMemoryStorage();
    let message = makeMessage();
    await storePendingSessionMessage(storage, message);

    const delays: (number | undefined)[] = [];
    const now = 100_000;

    for (let i = 0; i < 2; i++) {
      const result = await recordPendingFlushFailure(storage, message, 'error', now, {
        policy: 'cold-init',
        code: 'SANDBOX_CONNECT_FAILED',
      });
      delays.push(
        result.nextFlushAttemptAt !== undefined ? result.nextFlushAttemptAt - now : undefined
      );
      message = result.message;
    }

    expect(delays).toEqual([2_000, undefined]);
  });

  it('exhausts immediately for non-retryable codes', async () => {
    const storage = createMemoryStorage();
    const message = makeMessage();
    await storePendingSessionMessage(storage, message);

    const result = await recordPendingFlushFailure(storage, message, 'bad', 100_000, {
      policy: 'warm-followup',
      code: 'BAD_REQUEST',
    });

    expect(result.exhausted).toBe(true);
    expect(result.nextFlushAttemptAt).toBeUndefined();
  });

  it('keeps exhausted messages in storage for caller terminalization', async () => {
    const storage = createMemoryStorage();
    const message = makeMessage();
    await storePendingSessionMessage(storage, message);

    await recordPendingFlushFailure(storage, message, 'bad', 100_000, {
      policy: 'warm-followup',
      code: 'BAD_REQUEST',
    });

    const listed = await listPendingSessionMessages(storage);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      messageId: message.messageId,
      flushAttempts: 1,
      lastFlushError: 'bad',
      nextFlushAttemptAt: undefined,
      deliveryDisposition: 'terminalization-pending',
    });
  });

  it('persists terminalization-pending disposition only once retry budget is exhausted', async () => {
    const storage = createMemoryStorage();
    let message = makeMessage();
    await storePendingSessionMessage(storage, message);

    const retry = await recordPendingFlushFailure(storage, message, 'retry', 100_000, {
      policy: 'warm-followup',
      code: 'WORKSPACE_SETUP_FAILED',
    });
    message = retry.message;
    expect(message.deliveryDisposition).toBeUndefined();

    const exhausted = await recordPendingFlushFailure(storage, message, 'bad', 100_000, {
      policy: 'warm-followup',
      code: 'BAD_REQUEST',
    });
    expect(exhausted.message.deliveryDisposition).toBe('terminalization-pending');
  });

  it('keeps the message in storage when not exhausted', async () => {
    const storage = createMemoryStorage();
    const message = makeMessage();
    await storePendingSessionMessage(storage, message);

    await recordPendingFlushFailure(storage, message, 'transient', 100_000, {
      policy: 'warm-followup',
      code: 'WORKSPACE_SETUP_FAILED',
    });

    const listed = await listPendingSessionMessages(storage);
    expect(listed).toHaveLength(1);
    expect(listed[0].flushAttempts).toBe(1);
    expect(listed[0].lastFlushError).toBe('transient');
  });

  it('retains canonical attachments when re-storing a retryable current pending message', async () => {
    const storage = createMemoryStorage();
    const attachments = {
      path: '123e4567-e89b-12d3-a456-426614174000',
      files: ['123e4567-e89b-12d3-a456-426614174001.md'],
    };
    const message = createPendingSessionMessageFromIntent({
      turn: { type: 'prompt', messageId: BASE_MSG_ID, prompt: 'read markdown', attachments },
      agent: { mode: 'code', model: 'test-model' },
    });
    await storePendingSessionMessage(storage, message);

    await recordPendingFlushFailure(storage, message, 'transient', 100_000, {
      policy: 'warm-followup',
      code: 'WORKSPACE_SETUP_FAILED',
    });

    const listed = await listPendingSessionMessages(storage);
    expect(listed[0]?.intent?.turn).toMatchObject({ attachments });
    const [stored] = storage.store.values();
    expect(stored).not.toHaveProperty('images');
  });

  it('preserves the original pending intent when retry replacement write fails', async () => {
    const storage = createMemoryStorage();
    const message = createPendingSessionMessageFromIntent(
      {
        turn: { type: 'prompt', messageId: BASE_MSG_ID, prompt: 'durable original' },
        agent: { mode: 'code', model: 'test-model' },
      },
      1
    );
    await storePendingSessionMessage(storage, message);
    const original = Array.from(storage.store.values())[0];
    storage.put = async () => {
      throw new Error('replacement write failed');
    };

    await expect(
      recordPendingFlushFailure(storage, message, 'transient', 100_000, {
        policy: 'warm-followup',
        code: 'WORKSPACE_SETUP_FAILED',
      })
    ).rejects.toThrow('replacement write failed');

    expect(Array.from(storage.store.values())).toEqual([original]);
  });

  it('retains a rewritten durable copy when duplicate cleanup fails', async () => {
    const storage = createMemoryStorage();
    const message = createPendingSessionMessageFromIntent(
      {
        turn: { type: 'prompt', messageId: BASE_MSG_ID, prompt: 'durable original' },
        agent: { mode: 'code', model: 'test-model' },
      },
      1
    );
    await storePendingSessionMessage(storage, message);
    await storage.put('pending_message:0000000000000002:duplicate', {
      version: 2,
      intent: message.intent,
      delivery: { queuedAt: 2 },
    });
    storage.delete = async () => {
      throw new Error('duplicate cleanup failed');
    };

    const result = await recordPendingFlushFailure(storage, message, 'transient', 100_000, {
      policy: 'warm-followup',
      code: 'WORKSPACE_SETUP_FAILED',
    });

    expect(result.attempts).toBe(1);
    expect((await listPendingSessionMessages(storage)).length).toBeGreaterThanOrEqual(1);
    const firstStored = Array.from(storage.store.values())[0] as {
      delivery?: { flushAttempts?: number };
    };
    expect(firstStored.delivery?.flushAttempts).toBe(1);
  });

  it('treats undefined code as retryable', async () => {
    const storage = createMemoryStorage();
    const message = makeMessage();
    await storePendingSessionMessage(storage, message);

    const result = await recordPendingFlushFailure(storage, message, 'unknown', 100_000, {
      policy: 'warm-followup',
    });

    expect(result.exhausted).toBe(false);
    expect(result.attempts).toBe(1);
  });
});

describe('deletePendingSessionMessageByMessageId', () => {
  it('deletes all messages with matching messageId', async () => {
    const storage = createMemoryStorage();
    await storePendingSessionMessage(
      storage,
      makeMessage({ messageId: 'msg_018f1e2d3c4bDDDDDDDDDDDDDD', createdAt: 1 })
    );
    await storePendingSessionMessage(
      storage,
      makeMessage({ messageId: 'msg_018f1e2d3c4bDDDDDDDDDDDDDD', createdAt: 2 })
    );
    await storePendingSessionMessage(
      storage,
      makeMessage({ messageId: 'msg_018f1e2d3c4bEEEEEEEEEEEEEE', createdAt: 3 })
    );

    const deleted = await deletePendingSessionMessageByMessageId(
      storage,
      'msg_018f1e2d3c4bDDDDDDDDDDDDDD'
    );
    const remaining = await listPendingSessionMessages(storage);

    expect(deleted).toBe(true);
    expect(remaining.map(m => m.messageId)).toEqual(['msg_018f1e2d3c4bEEEEEEEEEEEEEE']);
  });

  it('returns false when no message matches', async () => {
    const storage = createMemoryStorage();
    const deleted = await deletePendingSessionMessageByMessageId(storage, 'missing');
    expect(deleted).toBe(false);
  });
});

describe('findPendingSessionMessageByMessageId', () => {
  it('finds the message by messageId', async () => {
    const storage = createMemoryStorage();
    await storePendingSessionMessage(
      storage,
      makeMessage({ messageId: 'msg_018f1e2d3c4bFindMsgAbCdEfG', createdAt: 1 })
    );

    const found = await findPendingSessionMessageByMessageId(
      storage,
      'msg_018f1e2d3c4bFindMsgAbCdEfG'
    );
    expect(found?.messageId).toBe('msg_018f1e2d3c4bFindMsgAbCdEfG');
  });

  it('returns undefined when not found', async () => {
    const storage = createMemoryStorage();
    const found = await findPendingSessionMessageByMessageId(storage, 'missing');
    expect(found).toBeUndefined();
  });
});

describe('findPendingSessionMessageByClientRequestId', () => {
  it('finds the message by clientRequestId', async () => {
    const storage = createMemoryStorage();
    await storePendingSessionMessage(
      storage,
      makeMessage({
        messageId: 'msg_018f1e2d3c4bAAAAAAAAAAAAAA',
        clientRequestId: 'client-1',
        createdAt: 1,
      })
    );

    const found = await findPendingSessionMessageByClientRequestId(storage, 'client-1');
    expect(found?.messageId).toBe('msg_018f1e2d3c4bAAAAAAAAAAAAAA');
  });

  it('returns undefined when not found', async () => {
    const storage = createMemoryStorage();
    const found = await findPendingSessionMessageByClientRequestId(storage, 'missing');
    expect(found).toBeUndefined();
  });
});

describe('clearPendingSessionMessages', () => {
  it('clears all messages and returns them', async () => {
    const storage = createMemoryStorage();
    await storePendingSessionMessage(
      storage,
      makeMessage({ messageId: 'msg_018f1e2d3c4bAAAAAAAAAAAAAA', createdAt: 1 })
    );
    await storePendingSessionMessage(
      storage,
      makeMessage({ messageId: 'msg_018f1e2d3c4bBBBBBBBBBBBBBB', createdAt: 2 })
    );

    const cleared = await clearPendingSessionMessages(storage);
    const remaining = await listPendingSessionMessages(storage);

    expect(cleared.map(m => m.messageId)).toEqual([
      'msg_018f1e2d3c4bAAAAAAAAAAAAAA',
      'msg_018f1e2d3c4bBBBBBBBBBBBBBB',
    ]);
    expect(remaining).toHaveLength(0);
  });

  it('returns empty array when no messages exist', async () => {
    const storage = createMemoryStorage();
    const cleared = await clearPendingSessionMessages(storage);
    expect(cleared).toEqual([]);
  });
});
