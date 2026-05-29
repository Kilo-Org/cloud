import { describe, expect, it } from 'vitest';
import {
  createQueuedSessionMessageState,
  getSessionMessageState,
  putSessionMessageState,
  markMessageAccepted,
  markMessageCompleted,
  markMessageFailed,
  markMessageInterrupted,
  terminalizeMessageOnce,
  listNonTerminalAcceptedMessages,
  listMessagesWithPendingCallbacks,
  isTerminalMessageState,
  type SessionMessageState,
  type SessionMessageStorage,
} from './session-message-state.js';
import type { SessionMessageIntent } from '../execution/types.js';

function createFakeStorage(): SessionMessageStorage & {
  store: Map<string, unknown>;
} {
  const store = new Map<string, unknown>();
  return {
    store,
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    async list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>> {
      const result = new Map<string, T>();
      for (const [key, value] of store.entries()) {
        if (key.startsWith(options.prefix)) {
          result.set(key, value as T);
        }
      }
      return result;
    },
  };
}

const VALID_MESSAGE_ID = 'msg_0123456789abABCDEFGHIJKLMN';

function createIntent(
  messageId: string,
  prompt: string,
  options?: Pick<SessionMessageIntent, 'agent' | 'finalization'>
): SessionMessageIntent {
  return {
    turn: { type: 'prompt', messageId, prompt },
    agent: options?.agent ?? { mode: 'code', model: 'default-model' },
    finalization: options?.finalization,
  };
}

describe('createQueuedSessionMessageState', () => {
  it('creates a queued message state with required fields', () => {
    const state = createQueuedSessionMessageState(
      createIntent(VALID_MESSAGE_ID, 'hello'),
      undefined,
      1000
    );
    expect(state.messageId).toBe(VALID_MESSAGE_ID);
    expect(state.status).toBe('queued');
    expect(state.prompt).toBe('hello');
    expect(state.createdAt).toBe(1000);
    expect(state.queuedAt).toBe(1000);
    expect(state.callbackRequired).toBe(false);
    expect(state.callbackTarget).toBeUndefined();
    expect(state.admissionSnapshot).toEqual(createIntent(VALID_MESSAGE_ID, 'hello'));
    expect(state).not.toHaveProperty('turn');
    expect(state).not.toHaveProperty('agent');
    expect(state).not.toHaveProperty('finalization');
  });

  it('snapshots callback target when provided', () => {
    const target = { url: 'https://example.com/callback', headers: { 'X-Auth': 'token' } };
    const state = createQueuedSessionMessageState(
      createIntent(VALID_MESSAGE_ID, 'test'),
      { required: true, target },
      1000
    );
    expect(state.callbackRequired).toBe(true);
    expect(state.callbackTarget).toEqual(target);
  });

  it('records immutable admission intent as one named snapshot', () => {
    const state = createQueuedSessionMessageState(
      createIntent(VALID_MESSAGE_ID, 'test', {
        agent: { mode: 'code', model: 'gpt-4', variant: 'fast' },
        finalization: { autoCommit: true, condenseOnComplete: false },
      })
    );
    expect(state.admissionSnapshot).toEqual({
      turn: { type: 'prompt', messageId: VALID_MESSAGE_ID, prompt: 'test' },
      agent: { mode: 'code', model: 'gpt-4', variant: 'fast' },
      finalization: { autoCommit: true, condenseOnComplete: false },
    });
  });
});

describe('getSessionMessageState / putSessionMessageState', () => {
  it('round-trips a message state through storage', async () => {
    const storage = createFakeStorage();
    const state = createQueuedSessionMessageState(
      createIntent(VALID_MESSAGE_ID, 'hello'),
      undefined,
      1000
    );
    await putSessionMessageState(storage, state);
    const loaded = await getSessionMessageState(storage, VALID_MESSAGE_ID);
    expect(loaded).toEqual(state);
  });

  it('normalizes legacy copied immutable fields into partial replay constraints', async () => {
    const storage = createFakeStorage();
    await storage.put(`session_message:${VALID_MESSAGE_ID}`, {
      messageId: VALID_MESSAGE_ID,
      status: 'accepted',
      prompt: 'legacy prompt',
      createdAt: 1000,
      acceptedAt: 2000,
      agent: { mode: 'plan', model: 'legacy-model', variant: 'beta' },
      finalization: { autoCommit: true },
    });

    const loaded = await getSessionMessageState(storage, VALID_MESSAGE_ID);

    expect(loaded?.admissionSnapshot).toBeUndefined();
    expect(loaded?.legacyAdmissionConstraints).toEqual({
      agent: { mode: 'plan', model: 'legacy-model', variant: 'beta' },
      finalization: { autoCommit: true },
    });
    expect(loaded).not.toHaveProperty('agent');
    expect(loaded).not.toHaveProperty('finalization');
  });

  it('round-trips canonical attachments in an admission snapshot', async () => {
    const storage = createFakeStorage();
    const attachments = {
      path: '123e4567-e89b-12d3-a456-426614174000',
      files: ['123e4567-e89b-12d3-a456-426614174001.pdf'],
    };
    const state = createQueuedSessionMessageState({
      turn: { type: 'prompt', messageId: VALID_MESSAGE_ID, prompt: 'document', attachments },
      agent: { mode: 'code', model: 'default-model' },
    });
    await putSessionMessageState(storage, state);

    const loaded = await getSessionMessageState(storage, VALID_MESSAGE_ID);

    expect(loaded?.admissionSnapshot?.turn).toMatchObject({ attachments });
  });

  it('rejects stored admission snapshots containing legacy images', async () => {
    const storage = createFakeStorage();
    await storage.put(`session_message:${VALID_MESSAGE_ID}`, {
      messageId: VALID_MESSAGE_ID,
      status: 'accepted',
      prompt: 'old image snapshot',
      admissionSnapshot: {
        turn: {
          type: 'prompt',
          messageId: VALID_MESSAGE_ID,
          prompt: 'old image snapshot',
          images: {
            path: '123e4567-e89b-12d3-a456-426614174000',
            files: ['123e4567-e89b-12d3-a456-426614174001.png'],
          },
        },
        agent: { mode: 'code', model: 'default-model' },
      },
      createdAt: 1000,
      acceptedAt: 2000,
    });

    expect(await getSessionMessageState(storage, VALID_MESSAGE_ID)).toBeUndefined();
  });

  it('normalizes canonical predecessor turn attachments into replay constraints', async () => {
    const storage = createFakeStorage();
    const attachments = {
      path: '123e4567-e89b-12d3-a456-426614174000',
      files: ['123e4567-e89b-12d3-a456-426614174001.pdf'],
    };
    await storage.put(`session_message:${VALID_MESSAGE_ID}`, {
      messageId: VALID_MESSAGE_ID,
      status: 'accepted',
      prompt: 'stored document',
      turn: {
        type: 'prompt',
        messageId: VALID_MESSAGE_ID,
        prompt: 'stored document',
        attachments,
      },
      createdAt: 1000,
      acceptedAt: 2000,
      agent: { mode: 'plan', model: 'legacy-model' },
    });

    const loaded = await getSessionMessageState(storage, VALID_MESSAGE_ID);

    expect(loaded?.legacyAdmissionConstraints?.turn).toEqual({
      type: 'prompt',
      messageId: VALID_MESSAGE_ID,
      prompt: 'stored document',
      attachments,
    });
  });

  it('prefers a current admission snapshot over conflicting legacy copied fields', async () => {
    const storage = createFakeStorage();
    const current = createIntent(VALID_MESSAGE_ID, 'current prompt');
    await storage.put(`session_message:${VALID_MESSAGE_ID}`, {
      messageId: VALID_MESSAGE_ID,
      status: 'accepted',
      prompt: 'current prompt',
      admissionSnapshot: current,
      agent: { mode: 'plan', model: 'legacy-model' },
      createdAt: 1000,
      acceptedAt: 2000,
    });

    const loaded = await getSessionMessageState(storage, VALID_MESSAGE_ID);

    expect(loaded?.admissionSnapshot).toEqual(current);
    expect(loaded?.legacyAdmissionConstraints).toBeUndefined();
    expect(loaded).not.toHaveProperty('agent');
  });

  it('returns undefined for unknown messageId', async () => {
    const storage = createFakeStorage();
    const loaded = await getSessionMessageState(storage, 'msg_unknown00000000ABCDEFGHIJKLMN');
    expect(loaded).toBeUndefined();
  });
});

describe('markMessageAccepted', () => {
  it('transitions queued to accepted', async () => {
    const storage = createFakeStorage();
    const state = createQueuedSessionMessageState(
      createIntent(VALID_MESSAGE_ID, 'hello'),
      undefined,
      1000
    );
    await putSessionMessageState(storage, state);

    const updated = await markMessageAccepted(storage, VALID_MESSAGE_ID, 'wr_abc123', 2000);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('accepted');
    expect(updated!.acceptedAt).toBe(2000);
    expect(updated!.wrapperRunId).toBe('wr_abc123');
  });

  it('returns null if message not found', async () => {
    const storage = createFakeStorage();
    const result = await markMessageAccepted(storage, VALID_MESSAGE_ID, 'wr_abc123', 2000);
    expect(result).toBeNull();
  });

  it('returns null if message is already accepted', async () => {
    const storage = createFakeStorage();
    const state = createQueuedSessionMessageState(
      createIntent(VALID_MESSAGE_ID, 'hello'),
      undefined,
      1000
    );
    await putSessionMessageState(storage, state);
    await markMessageAccepted(storage, VALID_MESSAGE_ID, 'wr_abc123', 2000);

    const secondAccept = await markMessageAccepted(storage, VALID_MESSAGE_ID, 'wr_def456', 3000);
    expect(secondAccept).toBeNull();
  });
});

describe('markMessageCompleted', () => {
  it('transitions accepted to completed', async () => {
    const storage = createFakeStorage();
    const state = createQueuedSessionMessageState(
      createIntent(VALID_MESSAGE_ID, 'hello'),
      undefined,
      1000
    );
    await putSessionMessageState(storage, state);
    await markMessageAccepted(storage, VALID_MESSAGE_ID, 'wr_abc123', 2000);

    const completed = await markMessageCompleted(
      storage,
      VALID_MESSAGE_ID,
      { assistantMessageId: 'asst_123', completionSource: 'assistant_message_event' },
      3000
    );
    expect(completed).not.toBeNull();
    expect(completed!.status).toBe('completed');
    expect(completed!.assistantMessageId).toBe('asst_123');
    expect(completed!.completionSource).toBe('assistant_message_event');
    expect(completed!.terminalAt).toBe(3000);
  });

  it('returns null for already terminal message', async () => {
    const storage = createFakeStorage();
    const state = createQueuedSessionMessageState(
      createIntent(VALID_MESSAGE_ID, 'hello'),
      undefined,
      1000
    );
    await putSessionMessageState(storage, state);
    await markMessageAccepted(storage, VALID_MESSAGE_ID, 'wr_abc123', 2000);
    await markMessageCompleted(
      storage,
      VALID_MESSAGE_ID,
      { completionSource: 'assistant_message_event' },
      3000
    );

    const secondComplete = await markMessageCompleted(
      storage,
      VALID_MESSAGE_ID,
      { completionSource: 'idle_reconciliation' },
      4000
    );
    expect(secondComplete).toBeNull();
  });
});

describe('markMessageFailed', () => {
  it('transitions accepted to failed', async () => {
    const storage = createFakeStorage();
    const state = createQueuedSessionMessageState(
      createIntent(VALID_MESSAGE_ID, 'hello'),
      undefined,
      1000
    );
    await putSessionMessageState(storage, state);
    await markMessageAccepted(storage, VALID_MESSAGE_ID, 'wr_abc123', 2000);

    const failed = await markMessageFailed(
      storage,
      VALID_MESSAGE_ID,
      {
        reason: 'missing_assistant_reply',
        error: 'No reply found',
        completionSource: 'idle_reconciliation',
      },
      3000
    );
    expect(failed).not.toBeNull();
    expect(failed!.status).toBe('failed');
    expect(failed!.failureReason).toBe('missing_assistant_reply');
    expect(failed!.error).toBe('No reply found');
    expect(failed!.completionSource).toBe('idle_reconciliation');
    expect(failed!.terminalAt).toBe(3000);
  });

  it('returns null for already terminal message', async () => {
    const storage = createFakeStorage();
    const state = createQueuedSessionMessageState(
      createIntent(VALID_MESSAGE_ID, 'hello'),
      undefined,
      1000
    );
    await putSessionMessageState(storage, state);
    await markMessageFailed(
      storage,
      VALID_MESSAGE_ID,
      { reason: 'test', completionSource: 'delivery_failure' },
      2000
    );

    const secondFail = await markMessageFailed(
      storage,
      VALID_MESSAGE_ID,
      { reason: 'another', completionSource: 'wrapper_failure' },
      3000
    );
    expect(secondFail).toBeNull();
  });
});

describe('markMessageInterrupted', () => {
  it('transitions queued to interrupted', async () => {
    const storage = createFakeStorage();
    const state = createQueuedSessionMessageState(
      createIntent(VALID_MESSAGE_ID, 'hello'),
      undefined,
      1000
    );
    await putSessionMessageState(storage, state);

    const interrupted = await markMessageInterrupted(
      storage,
      VALID_MESSAGE_ID,
      { error: 'User interrupted' },
      2000
    );
    expect(interrupted).not.toBeNull();
    expect(interrupted!.status).toBe('interrupted');
    expect(interrupted!.failureReason).toBe('interrupted');
    expect(interrupted!.error).toBe('User interrupted');
    expect(interrupted!.completionSource).toBe('interrupt');
  });
});

describe('terminalizeMessageOnce', () => {
  it('terminalizes a non-terminal message and reports changed=true', async () => {
    const storage = createFakeStorage();
    const state = createQueuedSessionMessageState(
      createIntent(VALID_MESSAGE_ID, 'hello'),
      undefined,
      1000
    );
    await putSessionMessageState(storage, state);

    const result = await terminalizeMessageOnce(
      storage,
      VALID_MESSAGE_ID,
      { kind: 'completed', completionSource: 'assistant_message_event' },
      {},
      3000
    );
    expect(result.changed).toBe(true);
    expect(result.state!.status).toBe('completed');
    expect(result.state!.terminalEffects).toEqual({
      event: 'pending',
      callback: { disposition: 'not-required' },
      push: { disposition: 'pending' },
    });
  });

  it('does not double-terminalize and reports changed=false', async () => {
    const storage = createFakeStorage();
    const state = createQueuedSessionMessageState(
      createIntent(VALID_MESSAGE_ID, 'hello'),
      undefined,
      1000
    );
    await putSessionMessageState(storage, state);

    await terminalizeMessageOnce(
      storage,
      VALID_MESSAGE_ID,
      { kind: 'completed', completionSource: 'assistant_message_event' },
      3000
    );
    const result = await terminalizeMessageOnce(
      storage,
      VALID_MESSAGE_ID,
      { kind: 'failed', reason: 'x', completionSource: 'idle_reconciliation' },
      4000
    );
    expect(result.changed).toBe(false);
  });

  it('preserves the interrupted failure reason on terminalization', async () => {
    const storage = createFakeStorage();
    const state = createQueuedSessionMessageState(
      createIntent(VALID_MESSAGE_ID, 'hello'),
      undefined,
      1000
    );
    await putSessionMessageState(storage, state);

    const result = await terminalizeMessageOnce(
      storage,
      VALID_MESSAGE_ID,
      { kind: 'interrupted', error: 'stopped', completionSource: 'interrupt' },
      2000
    );

    expect(result.changed).toBe(true);
    expect(result.state?.status).toBe('interrupted');
    expect(result.state?.failureReason).toBe('interrupted');
  });

  it('returns changed=false for unknown messageId', async () => {
    const storage = createFakeStorage();
    const result = await terminalizeMessageOnce(
      storage,
      'msg_nonexistent00ABCDEFGHIJKLMN',
      { kind: 'failed', reason: 'x', completionSource: 'delivery_failure' },
      1000
    );
    expect(result.changed).toBe(false);
    expect(result.state).toBeNull();
  });
});

describe('listNonTerminalAcceptedMessages', () => {
  it('lists accepted messages filtered by wrapperRunId', async () => {
    const storage = createFakeStorage();
    const id1 = 'msg_0123456789abAAAAAAAAAAAAAA';
    const id2 = 'msg_0123456789abBBBBBBBBBBBBBB';
    const id3 = 'msg_0123456789abCCCCCCCCCCCCCC';

    const s1 = createQueuedSessionMessageState(createIntent(id1, 'a'), undefined, 1000);
    const s2 = createQueuedSessionMessageState(createIntent(id2, 'b'), undefined, 1000);
    const s3 = createQueuedSessionMessageState(createIntent(id3, 'c'), undefined, 1000);
    await putSessionMessageState(storage, s1);
    await putSessionMessageState(storage, s2);
    await putSessionMessageState(storage, s3);

    await markMessageAccepted(storage, id1, 'wr_run1', 2000);
    await markMessageAccepted(storage, id2, 'wr_run2', 2000);

    const forRun1 = await listNonTerminalAcceptedMessages(storage, 'wr_run1');
    expect(forRun1).toHaveLength(1);
    expect(forRun1[0].messageId).toBe(id1);

    const allAccepted = await listNonTerminalAcceptedMessages(storage);
    expect(allAccepted).toHaveLength(2);
  });

  it('excludes non-accepted messages', async () => {
    const storage = createFakeStorage();
    const id1 = 'msg_0123456789abAAAAAAAAAAAAAA';
    const s1 = createQueuedSessionMessageState(createIntent(id1, 'a'), undefined, 1000);
    await putSessionMessageState(storage, s1);

    const accepted = await listNonTerminalAcceptedMessages(storage);
    expect(accepted).toHaveLength(0);
  });
});

describe('listMessagesWithPendingCallbacks', () => {
  it('lists terminal messages with callbackRequired but no callbackEnqueuedAt', async () => {
    const storage = createFakeStorage();
    const id1 = 'msg_0123456789abAAAAAAAAAAAAAA';
    const id2 = 'msg_0123456789abBBBBBBBBBBBBBB';

    const target = { url: 'https://example.com' };
    const s1 = createQueuedSessionMessageState(
      createIntent(id1, 'a'),
      { required: true, target },
      1000
    );
    const s2 = createQueuedSessionMessageState(
      createIntent(id2, 'b'),
      { required: true, target },
      1000
    );
    await putSessionMessageState(storage, s1);
    await putSessionMessageState(storage, s2);

    await markMessageFailed(
      storage,
      id1,
      { reason: 'test', completionSource: 'delivery_failure' },
      2000
    );
    await markMessageFailed(
      storage,
      id2,
      { reason: 'test', completionSource: 'delivery_failure' },
      2000
    );

    const pending = await listMessagesWithPendingCallbacks(storage);
    expect(pending).toHaveLength(2);
  });

  it('excludes messages without callbackRequired', async () => {
    const storage = createFakeStorage();
    const id1 = 'msg_0123456789abAAAAAAAAAAAAAA';
    const s1 = createQueuedSessionMessageState(createIntent(id1, 'a'), undefined, 1000);
    await putSessionMessageState(storage, s1);
    await markMessageFailed(
      storage,
      id1,
      { reason: 'test', completionSource: 'delivery_failure' },
      2000
    );

    const pending = await listMessagesWithPendingCallbacks(storage);
    expect(pending).toHaveLength(0);
  });

  it('excludes messages already enqueued', async () => {
    const storage = createFakeStorage();
    const id1 = 'msg_0123456789abAAAAAAAAAAAAAA';
    const target = { url: 'https://example.com' };
    const s1 = createQueuedSessionMessageState(
      createIntent(id1, 'a'),
      { required: true, target },
      1000
    );
    await putSessionMessageState(storage, s1);
    await markMessageFailed(
      storage,
      id1,
      { reason: 'test', completionSource: 'delivery_failure' },
      2000
    );

    const state = (await getSessionMessageState(storage, id1))!;
    await putSessionMessageState(storage, { ...state, callbackEnqueuedAt: 3000 });

    const pending = await listMessagesWithPendingCallbacks(storage);
    expect(pending).toHaveLength(0);
  });
});

describe('isTerminalMessageState', () => {
  it.each(['completed', 'failed', 'interrupted'] as const)('returns true for %s', status => {
    const state = { status } as SessionMessageState;
    expect(isTerminalMessageState(state)).toBe(true);
  });

  it.each(['queued', 'accepted'] as const)('returns false for %s', status => {
    const state = { status } as SessionMessageState;
    expect(isTerminalMessageState(state)).toBe(false);
  });
});

describe('idempotency', () => {
  it('replaying the same messageId is idempotent', async () => {
    const storage = createFakeStorage();
    const state1 = createQueuedSessionMessageState(
      createIntent(VALID_MESSAGE_ID, 'hello'),
      undefined,
      1000
    );
    await putSessionMessageState(storage, state1);

    const state2 = createQueuedSessionMessageState(
      createIntent(VALID_MESSAGE_ID, 'hello'),
      undefined,
      2000
    );
    await putSessionMessageState(storage, state2);

    const loaded = await getSessionMessageState(storage, VALID_MESSAGE_ID);
    expect(loaded).toBeDefined();
    expect(loaded!.messageId).toBe(VALID_MESSAGE_ID);
  });

  it('multiple messages can coexist independently', async () => {
    const storage = createFakeStorage();
    const id1 = 'msg_0123456789abAAAAAAAAAAAAAA';
    const id2 = 'msg_0123456789abBBBBBBBBBBBBBB';

    const s1 = createQueuedSessionMessageState(createIntent(id1, 'a'), undefined, 1000);
    const s2 = createQueuedSessionMessageState(createIntent(id2, 'b'), undefined, 1000);
    await putSessionMessageState(storage, s1);
    await putSessionMessageState(storage, s2);

    await markMessageAccepted(storage, id1, 'wr_run1', 2000);
    await markMessageCompleted(storage, id1, { completionSource: 'assistant_message_event' }, 3000);

    const loaded2 = await getSessionMessageState(storage, id2);
    expect(loaded2!.status).toBe('queued');
  });

  it('message state survives storage round-trip (alarm/retry)', async () => {
    const storage = createFakeStorage();
    const target = { url: 'https://example.com/hook', headers: { Authorization: 'Bearer x' } };
    const state = createQueuedSessionMessageState(
      createIntent(VALID_MESSAGE_ID, 'hello', {
        agent: { mode: 'code', model: 'gpt-4' },
      }),
      { required: true, target },
      1000
    );
    await putSessionMessageState(storage, state);

    const loaded = await getSessionMessageState(storage, VALID_MESSAGE_ID);
    expect(loaded).toEqual(state);
    expect(loaded!.callbackRequired).toBe(true);
    expect(loaded!.callbackTarget).toEqual(target);
    expect(loaded!.admissionSnapshot?.agent).toEqual({ mode: 'code', model: 'gpt-4' });
  });
});
