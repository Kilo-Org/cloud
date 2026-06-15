import { describe, expect, it } from 'vitest';
import {
  CALLBACK_QUEUE_MAX_SERIALIZED_BYTES,
  serializedCallbackJobByteLength,
} from '../callbacks/queue-payload.js';
import type { CallbackJob } from '../callbacks/types.js';
import type {
  SendCloudAgentSessionNotificationParams,
  SendCloudAgentSessionNotificationResult,
} from '../notifications-binding.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import {
  buildCloudMessageFailedPayload,
  createMessageSettlementOutbox,
  type MessageSettlementOutboxStorage,
} from './message-settlement-outbox.js';
import { createPendingSessionMessage, storePendingSessionMessage } from './pending-messages.js';
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

  it('persists manual compact terminalization and emits one completion event', async () => {
    const harness = createHarness();
    await putSessionMessageState(harness.storage, acceptedMessageState(firstMessageId));

    const result = await harness.outbox.terminalizeSessionMessageOnce(firstMessageId, {
      kind: 'completed',
      completionSource: 'manual_compact_summarize',
    });

    expect(result.changed).toBe(true);
    expect(await getSessionMessageState(harness.storage, firstMessageId)).toMatchObject({
      status: 'completed',
      completionSource: 'manual_compact_summarize',
    });
    expect(harness.events).toHaveLength(1);
    expect(JSON.parse(harness.events[0].payload)).toMatchObject({
      messageId: firstMessageId,
      status: 'completed',
      completionSource: 'manual_compact_summarize',
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

  it('omits raw terminal text from live events and reconnect callback repair', async () => {
    const rawError = 'provider response Bearer secret-provider-token';
    const rawReason = 'internal failure reason secret-reason';
    const harness = createHarness();
    await putSessionMessageState(harness.storage, {
      ...acceptedMessageState(firstMessageId, { url: 'https://example.com/safe-failure' }),
      status: 'failed',
      terminalAt: 10,
      completionSource: 'wrapper_failure',
      failureStage: 'agent_activity',
      failureCode: 'assistant_error',
      safeFailureMessage: 'Assistant request timed out',
      error: rawError,
      failureReason: rawReason,
      terminalEffects: {
        event: 'pending',
        callback: { disposition: 'pending', allowWithoutObservedIdle: true },
        push: { disposition: 'not-required' },
      },
    });

    await harness.outbox.repairTerminalEffects();

    const eventPayload = JSON.parse(harness.events[0].payload);
    expect(eventPayload).toMatchObject({
      reason: 'The message failed',
      error: 'Assistant request timed out',
      failure: {
        code: 'assistant_error',
        message: 'Assistant request timed out',
      },
    });
    expect(harness.callbackJobs[0].payload).toMatchObject({
      errorMessage: 'Assistant request timed out',
      failure: {
        code: 'assistant_error',
        message: 'Assistant request timed out',
      },
    });
    expect(JSON.stringify({ eventPayload, callback: harness.callbackJobs[0] })).not.toContain(
      'secret-'
    );
  });

  it('sends model diagnostics privately in callbacks while keeping failure text generic', async () => {
    const harness = createHarness();
    const diagnostics = {
      requestedModel: 'kilo/retired-model',
      availableModelCount: 3,
      availableModels: ['vendor/alpha', 'vendor/beta', 'vendor/gamma'],
      suggestedModels: ['vendor/alpha', 'vendor/beta'],
      suggestionSource: 'fuzzy' as const,
    };
    await putSessionMessageState(
      harness.storage,
      acceptedMessageState(firstMessageId, { url: 'https://example.com/model-diagnostics' })
    );

    await harness.outbox.terminalizeSessionMessageOnce(firstMessageId, {
      kind: 'failed',
      reason: 'assistant_error',
      error: 'Model not found: kilo/retired-model',
      completionSource: 'wrapper_failure',
      failureStage: 'agent_activity',
      failureCode: 'assistant_error',
      safeFailureMessage: 'Assistant request failed: model not found',
      modelNotFoundRuntimeDiagnostics: diagnostics,
    });

    expect(harness.events).toHaveLength(1);
    expect(JSON.parse(harness.events[0].payload)).toMatchObject({
      error: 'Assistant request failed: model not found',
      failure: {
        code: 'assistant_error',
        message: 'Assistant request failed: model not found',
      },
    });
    expect(harness.events[0].payload).not.toContain('vendor/alpha');
    expect(harness.callbackJobs).toHaveLength(1);
    expect(harness.callbackJobs[0].payload).toMatchObject({
      errorMessage:
        'Model not found: kilo/retired-model. Available runtime models: 3. Closest matches: vendor/alpha, vendor/beta.',
      modelNotFoundRuntimeDiagnostics: diagnostics,
      failure: {
        code: 'assistant_error',
        message: 'Assistant request failed: model not found',
      },
    });
  });

  it('preserves allowlisted legacy reasons and replaces arbitrary reasons with status text', () => {
    const state = {
      ...acceptedMessageState(firstMessageId),
      status: 'failed' as const,
      failureReason: 'wrapper_protocol_error',
      failureCode: 'wrapper_error_after_activity' as const,
    };

    expect(buildCloudMessageFailedPayload(state)).toMatchObject({
      reason: 'wrapper_protocol_error',
      error: 'Agent wrapper failed while processing the message',
      failure: { code: 'wrapper_error_after_activity' },
    });
    expect(
      buildCloudMessageFailedPayload({
        ...state,
        failureReason: 'private reason token=secret',
      })
    ).toMatchObject({
      reason: 'The message failed',
      error: 'Agent wrapper failed while processing the message',
      failure: { code: 'wrapper_error_after_activity' },
    });
  });

  it('uses only safe projected failure text in failed pushes', async () => {
    const harness = createHarness({ metadata: pushMetadata });
    await putSessionMessageState(harness.storage, {
      ...acceptedMessageState(firstMessageId),
      status: 'failed',
      terminalAt: 10,
      completionSource: 'wrapper_failure',
      failureReason: 'assistant_error',
      failureStage: 'agent_activity',
      failureCode: 'assistant_error',
      safeFailureMessage: 'Assistant request timed out',
      error: 'provider response Bearer push-secret',
      terminalEffects: {
        event: 'accounted',
        callback: { disposition: 'not-required' },
        push: { disposition: 'pending' },
      },
    });

    await harness.outbox.repairTerminalEffects();

    expect(harness.pushJobs).toEqual([
      {
        userId: 'user_outbox',
        cliSessionId: 'ses_outbox',
        executionId: firstMessageId,
        status: 'failed',
        body: 'Failed: Assistant request timed out',
      },
    ]);
    expect(JSON.stringify(harness.pushJobs)).not.toContain('push-secret');
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
      reason: 'workspace setup failed internally',
      error: 'raw clone output token=secret',
      completionSource: 'assistant_message_event',
      failureStage: 'pre_dispatch',
      failureCode: 'workspace_setup_failed',
      failureSubtype: 'git_clone_timeout',
      safeFailureMessage: 'Clone exceeded the safe deadline',
      attempts: 2,
    });

    expect(harness.callbackJobs).toHaveLength(1);
    expect(harness.callbackJobs[0].target.url).toBe('https://example.com/second');
    expect(harness.callbackJobs[0].payload).toMatchObject({
      executionId: secondMessageId,
      messageId: secondMessageId,
      idempotencyKey: secondMessageId,
      status: 'failed',
      errorMessage: 'Repository clone timed out: Clone exceeded the safe deadline',
      failure: {
        stage: 'pre_dispatch',
        code: 'workspace_setup_failed',
        subtype: 'git_clone_timeout',
        attempts: 2,
        message: 'Repository clone timed out: Clone exceeded the safe deadline',
      },
      failureStage: 'pre_dispatch',
      clientError: {
        code: 'WORKSPACE_SETUP_FAILED',
        message: 'Repository clone timed out: Clone exceeded the safe deadline',
        retryable: true,
      },
    });
    expect(JSON.stringify(harness.callbackJobs[0])).not.toContain('token=secret');
  });

  it('omits clientError from completed callback jobs', async () => {
    const harness = createHarness();
    await putSessionMessageState(
      harness.storage,
      acceptedMessageState(firstMessageId, { url: 'https://example.com/completed' })
    );

    await harness.outbox.terminalizeSessionMessageOnce(firstMessageId, {
      kind: 'completed',
      completionSource: 'assistant_message_event',
    });

    expect(harness.callbackJobs).toHaveLength(1);
    expect(harness.callbackJobs[0].payload.clientError).toBeUndefined();
    expect(harness.callbackJobs[0].payload.failureStage).toBeUndefined();
  });

  it('finalizes a terminal wrapper-run callback while the next run remains pending', async () => {
    const harness = createHarness();
    await putSessionMessageState(
      harness.storage,
      acceptedMessageState(firstMessageId, { url: 'https://example.com/sealed-batch' })
    );
    await storePendingSessionMessage(
      harness.storage,
      createPendingSessionMessage({
        messageId: secondMessageId,
        role: 'user',
        content: 'next prompt',
        createdAt: 3_000,
      })
    );

    await harness.outbox.terminalizeSessionMessageOnce(firstMessageId, {
      kind: 'completed',
      completionSource: 'idle_reconciliation',
    });
    expect(harness.callbackJobs).toHaveLength(0);

    await harness.outbox.finalizeTerminalWrapperRunCallbackIfReady('wr_outbox');

    expect(harness.callbackJobs).toHaveLength(1);
    expect(harness.callbackJobs[0].payload.messageId).toBe(firstMessageId);
  });

  it('keeps a wrapper-run callback blocked while that run has a nonterminal accepted message', async () => {
    const harness = createHarness();
    await putSessionMessageState(
      harness.storage,
      acceptedMessageState(firstMessageId, { url: 'https://example.com/sealed-batch' })
    );
    await putSessionMessageState(harness.storage, acceptedMessageState(secondMessageId));

    await harness.outbox.terminalizeSessionMessageOnce(firstMessageId, {
      kind: 'completed',
      completionSource: 'idle_reconciliation',
    });
    await harness.outbox.finalizeTerminalWrapperRunCallbackIfReady('wr_outbox');

    expect(harness.callbackJobs).toHaveLength(0);
  });

  it('preserves gate-result waits when finalizing a terminal wrapper-run callback', async () => {
    const harness = createHarness({
      metadata: { ...metadata, finalization: { gateThreshold: 'warning' } },
    });
    await putSessionMessageState(
      harness.storage,
      acceptedMessageState(firstMessageId, { url: 'https://example.com/sealed-batch-gate' })
    );
    await storePendingSessionMessage(
      harness.storage,
      createPendingSessionMessage({
        messageId: secondMessageId,
        role: 'user',
        content: 'next prompt',
        createdAt: 3_000,
      })
    );

    await harness.outbox.terminalizeSessionMessageOnce(firstMessageId, {
      kind: 'completed',
      completionSource: 'idle_reconciliation',
    });
    await harness.outbox.finalizeTerminalWrapperRunCallbackIfReady('wr_outbox');
    expect(harness.callbackJobs).toHaveLength(0);

    await harness.outbox.observeWrapperTerminalForIdleBatch('pass');
    await harness.outbox.finalizeTerminalWrapperRunCallbackIfReady('wr_outbox');

    expect(harness.callbackJobs).toHaveLength(1);
    expect(harness.callbackJobs[0].payload.gateResult).toBe('pass');
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

  it('omits oversized assistant output before enqueueing the callback job', async () => {
    const assistantText = '😀"\\\n'.repeat(CALLBACK_QUEUE_MAX_SERIALIZED_BYTES);
    const harness = createHarness({
      assistantMessage: {
        eventId: 1 as LatestAssistantMessage['eventId'],
        timestamp: 1,
        info: { id: 'assistant_large', role: 'assistant' },
        parts: [
          {
            id: 'part_large',
            messageID: 'assistant_large',
            type: 'text',
            text: assistantText,
          },
        ],
      },
    });
    await putSessionMessageState(
      harness.storage,
      acceptedMessageState(firstMessageId, { url: 'https://example.com/large-callback' })
    );

    await harness.outbox.terminalizeSessionMessageOnce(firstMessageId, {
      kind: 'completed',
      completionSource: 'assistant_message_event',
    });

    expect(harness.callbackJobs).toHaveLength(1);
    expect(serializedCallbackJobByteLength(harness.callbackJobs[0])).toBeLessThanOrEqual(
      CALLBACK_QUEUE_MAX_SERIALIZED_BYTES
    );
    expect(harness.callbackJobs[0].payload.lastAssistantMessageText).toBeUndefined();
    expect(harness.callbackJobs[0].payload.lastAssistantMessageTextTruncation).toEqual({
      originalUtf8ByteLength: new TextEncoder().encode(assistantText.trim()).byteLength,
      retainedUtf8ByteLength: 0,
    });
    const persisted = await getSessionMessageState(harness.storage, firstMessageId);
    expect(persisted?.callbackEnqueuedAt).toBeDefined();
    expect(persisted?.callbackRetryAt).toBeUndefined();
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

  it('abandons a callback whose fixed fields cannot fit instead of retrying forever', async () => {
    const harness = createHarness();
    await putSessionMessageState(
      harness.storage,
      acceptedMessageState(firstMessageId, {
        url: 'https://example.com/oversized-fixed-fields',
        headers: {
          'x-callback-context': 'x'.repeat(CALLBACK_QUEUE_MAX_SERIALIZED_BYTES * 2),
        },
      })
    );

    await harness.outbox.terminalizeSessionMessageOnce(firstMessageId, {
      kind: 'completed',
      completionSource: 'assistant_message_event',
    });

    const persisted = await getSessionMessageState(harness.storage, firstMessageId);
    expect(harness.callbackJobs).toHaveLength(0);
    expect(persisted).toMatchObject({
      callbackAttempts: 1,
      callbackAbandonedAt: expect.any(Number),
      callbackEnqueuedAt: expect.any(Number),
    });
    expect(persisted?.callbackEnqueuedAt).toBe(persisted?.callbackAbandonedAt);
    expect(persisted?.callbackLastError).toContain('maximum is');
    expect(persisted?.callbackRetryAt).toBeUndefined();
    await expect(harness.outbox.nextCallbackDeadline()).resolves.toBeUndefined();

    await harness.outbox.repairTerminalMessageEffects(firstMessageId);
    await harness.outbox.repairTerminalEffects();
    await harness.outbox.retryPendingCallbacks(Date.now() + 60_000);

    const afterRetry = await getSessionMessageState(harness.storage, firstMessageId);
    expect(afterRetry).toMatchObject({ callbackAttempts: 1 });
    expect(harness.callbackJobs).toHaveLength(0);
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
