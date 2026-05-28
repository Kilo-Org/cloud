import { describe, expect, it } from 'vitest';
import type { CallbackJob } from '../callbacks/types.js';
import type {
  SendCloudAgentSessionNotificationParams,
  SendCloudAgentSessionNotificationResult,
} from '../notifications-binding.js';
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
import type { LatestAssistantMessage } from './types.js';

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

const pushMetadata = {
  ...metadata,
  identity: {
    ...metadata.identity,
    createdOnPlatform: 'cloud-agent-web',
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
  sendPush?: (
    params: SendCloudAgentSessionNotificationParams
  ) => Promise<SendCloudAgentSessionNotificationResult>;
  callbackQueueAvailable?: boolean;
  hasConnectedStreamClients?: boolean;
  hasObservedWrapperIdle?: boolean;
  metadata?: SessionMetadata;
  assistantMessage?: LatestAssistantMessage;
  failTerminalEventOnce?: boolean;
}) {
  const storage = createMemoryStorage();
  const events: PersistedMessageEvent[] = [];
  const terminalEventIds = new Set<string>();
  let failTerminalEvent = options?.failTerminalEventOnce ?? false;
  const callbackJobs: CallbackJob[] = [];
  const pushJobs: SendCloudAgentSessionNotificationParams[] = [];
  const reportedTerminalStates: SessionMessageState[] = [];
  const alarmDeadlines: number[] = [];
  const currentMetadata = options?.metadata ?? metadata;
  const sendCallback =
    options?.sendCallback ??
    (async (job: CallbackJob) => {
      callbackJobs.push(job);
    });
  const sendPush =
    options?.sendPush ??
    (async (params: SendCloudAgentSessionNotificationParams) => {
      pushJobs.push(params);
      return { dispatched: true };
    });

  return {
    storage,
    events,
    callbackJobs,
    pushJobs,
    reportedTerminalStates,
    alarmDeadlines,
    outbox: createMessageSettlementOutbox({
      storage,
      getMetadata: async () => currentMetadata,
      requireSessionId: async () => currentMetadata.identity.sessionId,
      resolveCallbackSessionId: async currentMetadata => currentMetadata?.identity.sessionId ?? '',
      getCallbackQueue: () =>
        options?.callbackQueueAvailable === false ? undefined : { send: sendCallback },
      sendPushNotification: sendPush,
      hasConnectedStreamClients: () => options?.hasConnectedStreamClients ?? false,
      reportTerminalState: reportState => {
        reportedTerminalStates.push(reportState);
      },
      getAssistantMessageForUserMessage: () => options?.assistantMessage ?? null,
      ensureTerminalMessageEvent: event => {
        if (failTerminalEvent) {
          failTerminalEvent = false;
          throw new Error('terminal event insert failed');
        }
        if (terminalEventIds.has(event.entityId)) return;
        terminalEventIds.add(event.entityId);
        events.push(event);
      },
      hasObservedWrapperIdle: async () => options?.hasObservedWrapperIdle ?? true,
      requestAlarmAtOrBefore: async deadline => {
        alarmDeadlines.push(deadline);
      },
      getSessionIdForLogs: () => currentMetadata.identity.sessionId,
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
    expect(harness.reportedTerminalStates).toHaveLength(1);
    expect(harness.reportedTerminalStates[0]).toMatchObject({ status: 'completed' });
    expect(harness.events[0].streamEventType).toBe('cloud.message.completed');
    expect(JSON.parse(harness.events[0].payload)).toMatchObject({
      messageId: firstMessageId,
      status: 'completed',
      delivery: 'sent',
      assistantMessageId: 'assistant_one',
      completionSource: 'assistant_message_event',
    });
  });

  it('dispatches one web-session push using message identity and assistant text', async () => {
    const harness = createHarness({
      metadata: pushMetadata,
      assistantMessage: {
        eventId: 1 as LatestAssistantMessage['eventId'],
        timestamp: 1,
        info: { id: 'assistant_push', role: 'assistant' },
        parts: [{ id: 'part_push', messageID: 'assistant_push', type: 'text', text: 'Done now' }],
      },
    });
    await putSessionMessageState(harness.storage, acceptedMessageState(firstMessageId));

    await harness.outbox.terminalizeSessionMessageOnce(firstMessageId, {
      kind: 'completed',
      completionSource: 'assistant_message_event',
    });
    await harness.outbox.terminalizeSessionMessageOnce(firstMessageId, {
      kind: 'completed',
      completionSource: 'assistant_message_event',
    });

    expect(harness.pushJobs).toEqual([
      {
        userId: 'user_outbox',
        cliSessionId: 'ses_outbox',
        executionId: firstMessageId,
        status: 'completed',
        body: 'Done now',
      },
    ]);
    const persisted = await getSessionMessageState(harness.storage, firstMessageId);
    expect(persisted?.terminalEffects?.push?.disposition).toBe('accounted');
  });

  it('repairs a push effect after a transient dispatch failure', async () => {
    let attempts = 0;
    const harness = createHarness({
      metadata: pushMetadata,
      sendPush: async () => {
        attempts += 1;
        return attempts === 1
          ? { dispatched: false, reason: 'dispatch_failed' }
          : { dispatched: true };
      },
    });
    await putSessionMessageState(harness.storage, acceptedMessageState(firstMessageId));

    await harness.outbox.terminalizeSessionMessageOnce(firstMessageId, {
      kind: 'failed',
      reason: 'wrapper_failure',
      error: 'failed',
      completionSource: 'wrapper_failure',
    });
    const pending = await getSessionMessageState(harness.storage, firstMessageId);
    expect(pending?.terminalEffects?.push?.disposition).toBe('pending');
    expect(harness.alarmDeadlines).toHaveLength(1);

    await harness.outbox.repairTerminalEffects();

    const repaired = await getSessionMessageState(harness.storage, firstMessageId);
    expect(repaired?.terminalEffects?.push?.disposition).toBe('accounted');
    expect(attempts).toBe(2);
  });

  it('suppresses pushes while a stream client is connected', async () => {
    const harness = createHarness({ metadata: pushMetadata, hasConnectedStreamClients: true });
    await putSessionMessageState(harness.storage, acceptedMessageState(firstMessageId));

    await harness.outbox.terminalizeSessionMessageOnce(firstMessageId, {
      kind: 'completed',
      completionSource: 'assistant_message_event',
    });

    expect(harness.pushJobs).toEqual([]);
    const persisted = await getSessionMessageState(harness.storage, firstMessageId);
    expect(persisted?.terminalEffects?.push?.disposition).toBe('suppressed');
  });

  it('keeps terminal persistence successful when report scheduling throws', async () => {
    const storage = createMemoryStorage();
    await putSessionMessageState(storage, acceptedMessageState(firstMessageId));
    const outbox = createMessageSettlementOutbox({
      storage,
      getMetadata: async () => metadata,
      requireSessionId: async () => metadata.identity.sessionId,
      resolveCallbackSessionId: async () => metadata.identity.sessionId,
      getCallbackQueue: () => undefined,
      sendPushNotification: async () => ({ dispatched: true }),
      hasConnectedStreamClients: () => false,
      reportTerminalState: () => {
        throw new Error('report unavailable');
      },
      getAssistantMessageForUserMessage: () => null,
      ensureTerminalMessageEvent: () => undefined,
      hasObservedWrapperIdle: async () => true,
      requestAlarmAtOrBefore: async () => undefined,
      getSessionIdForLogs: () => metadata.identity.sessionId,
    });

    await expect(
      outbox.terminalizeSessionMessageOnce(firstMessageId, {
        kind: 'failed',
        reason: 'wrapper_failure',
        completionSource: 'wrapper_failure',
        failureStage: 'post_dispatch_no_activity',
        failureCode: 'wrapper_error_before_activity',
      })
    ).resolves.toMatchObject({ changed: true, state: { status: 'failed' } });
    await expect(getSessionMessageState(storage, firstMessageId)).resolves.toMatchObject({
      status: 'failed',
      failureCode: 'wrapper_error_before_activity',
    });
  });

  it('repairs a persisted terminal state after terminal event insertion fails once', async () => {
    const harness = createHarness({ failTerminalEventOnce: true });
    await putSessionMessageState(harness.storage, acceptedMessageState(firstMessageId));

    await expect(
      harness.outbox.terminalizeSessionMessageOnce(firstMessageId, {
        kind: 'completed',
        completionSource: 'assistant_message_event',
      })
    ).rejects.toThrow('terminal event insert failed');
    const afterFailure = await getSessionMessageState(harness.storage, firstMessageId);
    expect(afterFailure?.status).toBe('completed');
    expect(afterFailure?.terminalEffects?.event).toBe('pending');
    expect(harness.alarmDeadlines).toHaveLength(1);

    await harness.outbox.repairTerminalEffects();
    await harness.outbox.repairTerminalEffects();

    const repaired = await getSessionMessageState(harness.storage, firstMessageId);
    expect(repaired?.terminalEffects?.event).toBe('accounted');
    expect(harness.events).toHaveLength(1);
  });

  it('does not replay a terminal event for predecessor terminal state without effect markers', async () => {
    const harness = createHarness();
    await putSessionMessageState(harness.storage, {
      ...acceptedMessageState(firstMessageId, { url: 'https://example.com/predecessor' }),
      status: 'completed',
      terminalAt: 10,
      completionSource: 'assistant_message_event',
    });

    await harness.outbox.repairTerminalEffects();

    expect(harness.events).toHaveLength(0);
    expect(harness.callbackJobs).toHaveLength(1);
  });

  it('repairs terminal callback association after persisted terminal state was left incomplete', async () => {
    const harness = createHarness();
    await putSessionMessageState(harness.storage, {
      ...acceptedMessageState(firstMessageId, { url: 'https://example.com/repair' }),
      status: 'completed',
      terminalAt: 10,
      completionSource: 'assistant_message_event',
      terminalEffects: {
        event: 'accounted',
        callback: { disposition: 'pending', allowWithoutObservedIdle: true },
      },
    });

    await harness.outbox.repairTerminalEffects();

    const repaired = await getSessionMessageState(harness.storage, firstMessageId);
    expect(repaired?.terminalEffects?.callback.disposition).toBe('accounted');
    expect(harness.callbackJobs).toHaveLength(1);
  });

  it('repairs callback candidates in terminal order even when scanned in reverse order', async () => {
    const harness = createHarness();
    await putSessionMessageState(harness.storage, {
      ...acceptedMessageState(firstMessageId, { url: 'https://example.com/first' }),
      status: 'completed',
      terminalAt: 10,
      completionSource: 'assistant_message_event',
      terminalEffects: {
        event: 'accounted',
        callback: { disposition: 'pending', allowWithoutObservedIdle: true },
      },
    });
    await putSessionMessageState(harness.storage, {
      ...acceptedMessageState(secondMessageId, { url: 'https://example.com/second' }),
      status: 'failed',
      terminalAt: 20,
      completionSource: 'wrapper_failure',
      failureReason: 'assistant_error',
      terminalEffects: {
        event: 'accounted',
        callback: { disposition: 'pending', allowWithoutObservedIdle: true },
      },
    });

    await harness.outbox.repairTerminalEffects();

    expect(harness.callbackJobs).toHaveLength(1);
    expect(harness.callbackJobs[0].target.url).toBe('https://example.com/second');
  });

  it('keeps a repaired gate-waiting terminal callback blocked until gate wait is released', async () => {
    const harness = createHarness({
      metadata: { ...metadata, finalization: { gateThreshold: 'warning' } },
    });
    await putSessionMessageState(harness.storage, {
      ...acceptedMessageState(firstMessageId, { url: 'https://example.com/gate-repair' }),
      status: 'completed',
      terminalAt: 10,
      completionSource: 'assistant_message_event',
      terminalEffects: {
        event: 'accounted',
        callback: { disposition: 'pending', allowWithoutObservedIdle: true },
      },
    });

    await harness.outbox.repairTerminalEffects();
    expect(harness.callbackJobs).toHaveLength(0);

    await harness.outbox.releaseWrapperTerminalWaitForIdleBatch();
    await harness.outbox.repairTerminalEffects();
    expect(harness.callbackJobs).toHaveLength(1);
    expect(harness.callbackJobs[0].payload.gateResult).toBeUndefined();
  });

  it('preserves allow-without-idle while repairing interrupt callback effects', async () => {
    const harness = createHarness({ hasObservedWrapperIdle: false });
    await putSessionMessageState(harness.storage, {
      ...acceptedMessageState(firstMessageId, { url: 'https://example.com/interrupt-repair' }),
      status: 'interrupted',
      terminalAt: 10,
      completionSource: 'interrupt',
      terminalEffects: {
        event: 'accounted',
        callback: { disposition: 'pending', allowWithoutObservedIdle: true },
      },
    });

    await harness.outbox.repairTerminalEffects();

    expect(harness.callbackJobs).toHaveLength(1);
    expect(harness.callbackJobs[0].payload.status).toBe('interrupted');
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

  it('includes a persisted completed message gate result in callback jobs', async () => {
    const harness = createHarness();
    await putSessionMessageState(
      harness.storage,
      acceptedMessageState(firstMessageId, { url: 'https://example.com/gate-result' })
    );

    await harness.outbox.terminalizeSessionMessageOnce(firstMessageId, {
      kind: 'completed',
      completionSource: 'assistant_message_event',
      gateResult: 'pass',
    });

    const persisted = await getSessionMessageState(harness.storage, firstMessageId);
    expect(persisted?.gateResult).toBe('pass');
    expect(harness.callbackJobs).toHaveLength(1);
    expect(harness.callbackJobs[0].payload).toMatchObject({
      messageId: firstMessageId,
      status: 'completed',
      gateResult: 'pass',
    });
  });

  it('reports a late wrapper gate result once without allowing replay to replace it', async () => {
    const harness = createHarness({
      metadata: { ...metadata, finalization: { gateThreshold: 'warning' } },
    });
    await putSessionMessageState(
      harness.storage,
      acceptedMessageState(firstMessageId, { url: 'https://example.com/late-gate-result' })
    );

    await harness.outbox.terminalizeSessionMessageOnce(firstMessageId, {
      kind: 'completed',
      completionSource: 'assistant_message_event',
    });
    await harness.outbox.observeWrapperTerminalForIdleBatch('pass');
    await harness.outbox.observeWrapperTerminalForIdleBatch('fail');

    const persisted = await getSessionMessageState(harness.storage, firstMessageId);
    expect(persisted?.gateResult).toBe('pass');
    expect(harness.reportedTerminalStates).toHaveLength(2);
    expect(harness.reportedTerminalStates[0].gateResult).toBeUndefined();
    expect(harness.reportedTerminalStates[1]).toMatchObject({
      messageId: firstMessageId,
      status: 'completed',
      gateResult: 'pass',
    });
  });

  it('releases a gate-waiting idle callback without inventing a wrapper gate result', async () => {
    const harness = createHarness({
      metadata: {
        ...metadata,
        finalization: { gateThreshold: 'warning' },
      },
    });
    await putSessionMessageState(
      harness.storage,
      acceptedMessageState(firstMessageId, { url: 'https://example.com/gate-wait' })
    );

    await harness.outbox.terminalizeSessionMessageOnce(firstMessageId, {
      kind: 'completed',
      completionSource: 'assistant_message_event',
    });
    await harness.outbox.finalizeIdleBatchCallbackIfReady({
      allowWithoutObservedIdle: true,
    });

    expect(harness.callbackJobs).toHaveLength(0);

    await harness.outbox.releaseWrapperTerminalWaitForIdleBatch();
    await harness.outbox.finalizeIdleBatchCallbackIfReady({
      allowWithoutObservedIdle: true,
    });

    const persisted = await getSessionMessageState(harness.storage, firstMessageId);
    expect(persisted?.gateResult).toBeUndefined();
    expect(harness.callbackJobs).toHaveLength(1);
    expect(harness.callbackJobs[0].payload).toMatchObject({
      messageId: firstMessageId,
      status: 'completed',
    });
    expect(harness.callbackJobs[0].payload.gateResult).toBeUndefined();
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

  it('persists enqueue retry state when the callback queue is unavailable', async () => {
    const harness = createHarness({ callbackQueueAvailable: false });
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
    expect(persisted?.callbackLastError).toBe('Callback queue not available');
    expect(persisted?.callbackAttempts).toBe(1);
    expect(persisted?.callbackRetryAt).toBe(deadline);
    expect(harness.alarmDeadlines).toEqual([deadline]);
  });

  it('persists enqueue retry state when the callback target is missing', async () => {
    const harness = createHarness();
    await putSessionMessageState(harness.storage, {
      ...acceptedMessageState(firstMessageId),
      callbackRequired: true,
    });

    await harness.outbox.terminalizeSessionMessageOnce(firstMessageId, {
      kind: 'completed',
      completionSource: 'assistant_message_event',
    });

    const persisted = await getSessionMessageState(harness.storage, firstMessageId);
    const deadline = await harness.outbox.nextCallbackDeadline();
    expect(persisted?.callbackLastError).toBe('Missing callback target');
    expect(persisted?.callbackAttempts).toBe(1);
    expect(persisted?.callbackRetryAt).toBe(deadline);
    expect(harness.alarmDeadlines).toEqual([deadline]);
  });
});
