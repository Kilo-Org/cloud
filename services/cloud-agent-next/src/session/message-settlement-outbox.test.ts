import { describe, expect, it } from 'vitest';
import type { CallbackJob } from '../callbacks/types.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import {
  createMessageSettlementOutbox,
  type MessageSettlementOutboxStorage,
} from './message-settlement-outbox.js';
import {
  getSessionMessageState,
  putSessionMessageState,
  type SessionMessageState,
} from './session-message-state.js';

type MemoryStorage = MessageSettlementOutboxStorage & {
  store: Map<string, unknown>;
};

type PersistedMessageEvent = {
  sessionId: string;
  streamEventType: string;
  payload: string;
  timestamp: number;
};

function createMemoryStorage(): MemoryStorage {
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
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        store.delete(key);
      }
    },
    async list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>> {
      const entries = new Map<string, T>();
      for (const [key, value] of store.entries()) {
        if (key.startsWith(options.prefix)) {
          entries.set(key, value as T);
        }
      }
      return entries;
    },
  };
}

const metadata = {
  metadataSchemaVersion: 2,
  identity: {
    sessionId: 'agent_outbox',
    userId: 'user_outbox',
  },
  auth: {
    kiloSessionId: 'ses_outbox',
  },
  lifecycle: {
    version: 1,
    timestamp: 1,
  },
} satisfies SessionMetadata;

const firstMessageId = 'msg_0123456789abAAAAAAAAAAAAAA';
const secondMessageId = 'msg_0123456789abBBBBBBBBBBBBBB';

function acceptedMessageState(
  messageId: string,
  callbackTarget?: SessionMessageState['callbackTarget']
): SessionMessageState {
  return {
    messageId,
    status: 'accepted',
    prompt: 'prompt',
    createdAt: 1_000,
    acceptedAt: 2_000,
    wrapperRunId: 'wr_outbox',
    callbackRequired: callbackTarget !== undefined,
    callbackTarget,
  };
}

function createHarness(options?: {
  sendCallback?: (job: CallbackJob) => Promise<void>;
  hasObservedWrapperIdle?: boolean;
}) {
  const storage = createMemoryStorage();
  const events: PersistedMessageEvent[] = [];
  const callbackJobs: CallbackJob[] = [];
  const alarmDeadlines: number[] = [];
  const sendCallback =
    options?.sendCallback ??
    (async (job: CallbackJob) => {
      callbackJobs.push(job);
    });

  return {
    storage,
    events,
    callbackJobs,
    alarmDeadlines,
    outbox: createMessageSettlementOutbox({
      storage,
      getMetadata: async () => metadata,
      requireSessionId: async () => metadata.identity.sessionId,
      resolveCallbackSessionId: async currentMetadata => currentMetadata?.identity.sessionId ?? '',
      getCallbackQueue: () => ({ send: sendCallback }),
      getAssistantMessageForUserMessage: () => null,
      insertAndBroadcastMessageEvent: event => {
        events.push(event);
      },
      hasObservedWrapperIdle: async () => options?.hasObservedWrapperIdle ?? true,
      requestAlarmAtOrBefore: async deadline => {
        alarmDeadlines.push(deadline);
      },
      getSessionIdForLogs: () => metadata.identity.sessionId,
    }),
  };
}

describe('MessageSettlementOutbox', () => {
  it('terminalizes once and emits one terminal lifecycle event', async () => {
    const harness = createHarness();
    await putSessionMessageState(harness.storage, acceptedMessageState(firstMessageId));

    const firstResult = await harness.outbox.terminalizeSessionMessageOnce(firstMessageId, {
      kind: 'completed',
      assistantMessageId: 'assistant_one',
      completionSource: 'assistant_message_event',
    });
    const duplicateResult = await harness.outbox.terminalizeSessionMessageOnce(firstMessageId, {
      kind: 'failed',
      reason: 'duplicate',
      completionSource: 'wrapper_failure',
    });

    expect(firstResult.changed).toBe(true);
    expect(duplicateResult.changed).toBe(false);
    expect(harness.events).toHaveLength(1);
    expect(harness.events[0].streamEventType).toBe('cloud.message.completed');
    expect(JSON.parse(harness.events[0].payload)).toMatchObject({
      messageId: firstMessageId,
      status: 'completed',
      delivery: 'sent',
      assistantMessageId: 'assistant_one',
      completionSource: 'assistant_message_event',
    });
  });

  it('enqueues only the last callback-relevant terminal message in an idle batch', async () => {
    const harness = createHarness();
    await putSessionMessageState(
      harness.storage,
      acceptedMessageState(firstMessageId, { url: 'https://example.com/first' })
    );
    await putSessionMessageState(
      harness.storage,
      acceptedMessageState(secondMessageId, { url: 'https://example.com/second' })
    );

    await harness.outbox.terminalizeSessionMessageOnce(firstMessageId, {
      kind: 'completed',
      completionSource: 'assistant_message_event',
    });
    expect(harness.callbackJobs).toHaveLength(0);

    await harness.outbox.terminalizeSessionMessageOnce(secondMessageId, {
      kind: 'failed',
      reason: 'assistant_error',
      error: 'provider failed',
      completionSource: 'assistant_message_event',
    });

    expect(harness.callbackJobs).toHaveLength(1);
    expect(harness.callbackJobs[0].target.url).toBe('https://example.com/second');
    expect(harness.callbackJobs[0].payload).toMatchObject({
      executionId: secondMessageId,
      messageId: secondMessageId,
      idempotencyKey: secondMessageId,
      status: 'failed',
      errorMessage: 'provider failed',
    });
  });

  it('persists enqueue retry state and exposes the next callback deadline', async () => {
    const harness = createHarness({
      sendCallback: async () => {
        throw new Error('queue down');
      },
    });
    await putSessionMessageState(
      harness.storage,
      acceptedMessageState(firstMessageId, { url: 'https://example.com/retry' })
    );

    await harness.outbox.terminalizeSessionMessageOnce(firstMessageId, {
      kind: 'completed',
      completionSource: 'assistant_message_event',
    });

    const persisted = await getSessionMessageState(harness.storage, firstMessageId);
    const deadline = await harness.outbox.nextCallbackDeadline();
    expect(persisted?.callbackLastError).toBe('queue down');
    expect(persisted?.callbackAttempts).toBe(1);
    expect(persisted?.callbackRetryAt).toBe(deadline);
    expect(harness.alarmDeadlines).toEqual([deadline]);
  });
});
