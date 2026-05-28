import { describe, expect, it, vi } from 'vitest';
import type {
  ExecutionDeliveryContext,
  MessageDeliveryRequest,
  MessageDeliveryResult,
} from '../execution/types.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { SANDBOX_WORKSPACE_PROBE_TIMEOUT_MESSAGE } from '../sandbox-recovery.js';
import type { SessionId, UserId } from '../types/ids.js';
import {
  createSessionMessageQueue,
  flushNextPendingSessionMessage,
  type SessionMessageQueueStorage,
} from './session-message-queue.js';
import {
  createPendingSessionMessage,
  createPendingSessionMessageFromIntent,
  listPendingSessionMessages,
  PENDING_SESSION_MESSAGE_LIMIT,
  recordPendingFlushFailure,
  storePendingSessionMessage,
  type PendingSessionMessage,
} from './pending-messages.js';
import {
  createQueuedSessionMessageState,
  getSessionMessageState,
  putSessionMessageState,
  type TerminalizeParams,
} from './session-message-state.js';

type QueueEvent = {
  sessionId: string;
  streamEventType: string;
  payload: string;
  timestamp: number;
};

type Terminalization = {
  messageId: string;
  params: TerminalizeParams;
  options?: { allowIdleBatchWithoutObservedIdle?: boolean };
};

function createMemoryStorage(
  initialEntries?: Array<[string, unknown]>,
  options?: { failPutPrefix?: string }
): SessionMessageQueueStorage {
  const store = new Map(initialEntries ?? []);
  return {
    async get<T = unknown>(key: string) {
      return store.get(key) as T | undefined;
    },
    async put(key, value) {
      if (options?.failPutPrefix && key.startsWith(options.failPutPrefix)) {
        throw new Error(`failed to put ${options.failPutPrefix}`);
      }
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

function createMetadata(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    metadataSchemaVersion: 2,
    identity: {
      sessionId: 'agent_test',
      userId: 'user_test',
    },
    auth: {
      kiloSessionId: 'kilo_test',
    },
    agent: {
      mode: 'code',
      model: 'default-model',
      variant: 'alpha',
    },
    finalization: {
      autoCommit: false,
      condenseOnComplete: false,
    },
    workspace: {
      workspacePath: '/tmp/workspace',
      sandboxId: 'usr-test',
      sessionHome: '/home/agent_test',
      branchName: 'main',
    },
    lifecycle: {
      version: 1,
      timestamp: 1,
    },
    ...overrides,
  } satisfies SessionMetadata;
}

function createContext(metadata = createMetadata()): ExecutionDeliveryContext {
  return {
    sessionId: metadata.identity.sessionId as SessionId,
    userId: metadata.identity.userId as UserId,
    sandboxId: metadata.workspace?.sandboxId ?? 'usr-test',
    kiloSessionId: metadata.auth.kiloSessionId,
    metadata,
  };
}

function createQueueHarness(options?: {
  metadata?: SessionMetadata | null;
  deliver?: (plan: MessageDeliveryRequest) => Promise<MessageDeliveryResult>;
  storage?: SessionMessageQueueStorage;
  failQueuedEventOnce?: boolean;
  failAlarmOnce?: boolean;
  failTerminalizationOnce?: boolean;
  ensureAcceptedMessageEffects?: (messageId: string) => Promise<void>;
}) {
  const storage = options?.storage ?? createMemoryStorage();
  const events: QueueEvent[] = [];
  const admittedEventMessageIds = new Set<string>();
  const alarmDeadlines: number[] = [];
  const finalizedTerminalCallbacks: Array<{ allowWithoutObservedIdle?: boolean } | undefined> = [];
  let failQueuedEvent = options?.failQueuedEventOnce ?? false;
  let failAlarm = options?.failAlarmOnce ?? false;
  let failTerminalization = options?.failTerminalizationOnce ?? false;
  const terminalizations: Terminalization[] = [];
  const metadata = options?.metadata === undefined ? createMetadata() : options.metadata;
  const deliver = vi.fn(
    options?.deliver ??
      (async (plan: MessageDeliveryRequest): Promise<MessageDeliveryResult> => ({
        success: true,
        outcome: 'accepted',
        messageId: plan.turn.messageId,
        wrapperRunId: 'wr_test',
      }))
  );

  return {
    storage,
    events,
    alarmDeadlines,
    finalizedTerminalCallbacks,
    terminalizations,
    deliver,
    queue: createSessionMessageQueue({
      storage,
      getMetadata: async () => metadata,
      requireSessionId: async () => metadata?.identity.sessionId ?? 'agent_test',
      validateModeAgainstRuntimeAgents: () => null,
      getDeliveryContext: async () => (metadata ? createContext(metadata) : null),
      deliver,
      ensureQueuedMessageEvent: event => {
        if (failQueuedEvent) {
          failQueuedEvent = false;
          throw new Error('failed to persist queued event');
        }
        const payload = JSON.parse(event.payload) as { messageId?: string };
        const messageId = payload.messageId;
        if (messageId && admittedEventMessageIds.has(messageId)) return;
        events.push(event);
        if (messageId) admittedEventMessageIds.add(messageId);
      },
      ensureAcceptedMessageEffects:
        options?.ensureAcceptedMessageEffects ?? (async () => undefined),
      persistTerminalTransition: async (messageId, params, options) => {
        if (failTerminalization) {
          failTerminalization = false;
          throw new Error('terminal transition failed');
        }
        terminalizations.push({ messageId, params, options });
        return { changed: true, state: { status: params.kind } };
      },
      repairTerminalMessageEffects: async () => undefined,
      finalizeTerminalCallbackEffects: async options => {
        finalizedTerminalCallbacks.push(options);
      },
      requestAlarmAtOrBefore: async deadline => {
        if (failAlarm) {
          failAlarm = false;
          throw new Error('failed to schedule prompt drain');
        }
        alarmDeadlines.push(deadline);
      },
      getSessionIdForLogs: () => metadata?.identity.sessionId,
    }),
  };
}

const FIRST_MESSAGE_ID = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';
const SECOND_MESSAGE_ID = 'msg_018f1e2d3c4bBBBBBBBBBBBBBB';

describe('recordPendingFlushFailure backoff progression', () => {
  it('schedules only one warm follow-up retry', async () => {
    const storage = createMemoryStorage();
    let message = createPendingSessionMessage({
      messageId: 'msg_018f1e2d3c4bBackoffAbCdEfG',
      role: 'user',
      content: 'test',
      createdAt: 1,
    });
    await storePendingSessionMessage(storage, message);

    const delays: (number | undefined)[] = [];
    const now = 100_000;

    for (let i = 0; i < 2; i++) {
      const result = await recordPendingFlushFailure(storage, message, 'test error', now, {
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
    let message = createPendingSessionMessage({
      messageId: 'msg_018f1e2d3c4bColdInitAbCdEf',
      role: 'user',
      content: 'test',
      createdAt: 1,
    });
    await storePendingSessionMessage(storage, message);

    const delays: (number | undefined)[] = [];
    const now = 100_000;

    for (let i = 0; i < 2; i++) {
      const result = await recordPendingFlushFailure(storage, message, 'test error', now, {
        policy: 'cold-init',
        code: 'WORKSPACE_SETUP_FAILED',
      });
      delays.push(
        result.nextFlushAttemptAt !== undefined ? result.nextFlushAttemptAt - now : undefined
      );
      message = result.message;
    }

    expect(delays).toEqual([2_000, undefined]);
  });

  it('does not retry non-retryable failure codes', async () => {
    const storage = createMemoryStorage();
    const message = createPendingSessionMessage({
      messageId: 'msg_018f1e2d3c4bBadRequestAbCd',
      role: 'user',
      content: 'test',
      createdAt: 1,
    });
    await storePendingSessionMessage(storage, message);

    const result = await recordPendingFlushFailure(storage, message, 'bad request', 100_000, {
      policy: 'cold-init',
      code: 'BAD_REQUEST',
    });

    expect(result).toMatchObject({ attempts: 1, exhausted: true, nextFlushAttemptAt: undefined });
  });
});

describe('flushNextPendingSessionMessage', () => {
  it('retries a queued flush after a pre-start failure without dropping the message', async () => {
    const storage = createMemoryStorage();
    const message = createPendingSessionMessage({
      messageId: FIRST_MESSAGE_ID,
      role: 'user',
      content: 'queued prompt',
      createdAt: 1,
      executionOptions: {
        mode: 'plan',
        model: 'queued-model',
        variant: 'beta',
        autoCommit: true,
        condenseOnComplete: true,
        githubTokenOverride: 'queued-gh-token',
        gitTokenOverride: 'queued-git-token',
      },
    });
    await storePendingSessionMessage(storage, message);

    const deliver = vi
      .fn<(_plan: MessageDeliveryRequest) => Promise<MessageDeliveryResult>>()
      .mockResolvedValueOnce({
        success: false,
        code: 'WORKSPACE_SETUP_FAILED',
        error: 'workspace restore failed',
      })
      .mockResolvedValueOnce({
        success: true,
        outcome: 'accepted',
        messageId: FIRST_MESSAGE_ID,
        wrapperRunId: 'wr_test',
      });

    const first = await flushNextPendingSessionMessage({
      storage,
      now: 10,
      getDeliveryContext: async () => createContext(),
      validateModeAgainstRuntimeAgents: () => null,
      deliver,
    });

    expect(first.type).toBe('failure');
    if (first.type !== 'failure') return;
    expect(first.message.flushAttempts).toBe(1);
    expect(first.remainingCount).toBe(1);

    const second = await flushNextPendingSessionMessage({
      storage,
      now: first.nextFlushAttemptAt ?? 20,
      getDeliveryContext: async () => createContext(),
      validateModeAgainstRuntimeAgents: () => null,
      deliver,
    });

    expect(second).toEqual({ type: 'delivered', remainingCount: 0 });
    expect(deliver).toHaveBeenCalledTimes(2);
    const secondPlan = deliver.mock.calls[1]?.[0];
    expect(secondPlan).toMatchObject({
      turn: { messageId: FIRST_MESSAGE_ID, prompt: 'queued prompt' },
      agent: { mode: 'plan', model: 'queued-model', variant: 'beta' },
    });
    expect(secondPlan?.workspace).not.toHaveProperty('repositoryAuthOverrides');
    expect((await storage.list({ prefix: 'pending_message:' })).size).toBe(0);
  });

  it('delivers the next current message without execution-runtime blocking', async () => {
    const storage = createMemoryStorage();
    await storePendingSessionMessage(
      storage,
      createPendingSessionMessage({
        messageId: FIRST_MESSAGE_ID,
        role: 'user',
        content: 'send through fenced runtime',
        createdAt: 1,
      })
    );
    const deliver = vi.fn().mockResolvedValue({
      success: true,
      outcome: 'accepted',
      messageId: FIRST_MESSAGE_ID,
      wrapperRunId: 'wr_current',
    });

    const result = await flushNextPendingSessionMessage({
      storage,
      now: 10,
      getDeliveryContext: async () => createContext(),
      validateModeAgainstRuntimeAgents: () => null,
      deliver,
    });

    expect(result).toEqual({ type: 'delivered', remainingCount: 0 });
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('terminalizes a queued flush after a stale sandbox workspace probe timeout', async () => {
    const storage = createMemoryStorage();
    const message = createPendingSessionMessage({
      messageId: 'msg_018f1e2d3c4bProbeTimeoutAb',
      role: 'user',
      content: 'queued prompt',
      createdAt: 1,
    });
    await storePendingSessionMessage(storage, message);

    const deliver = vi
      .fn<(_plan: MessageDeliveryRequest) => Promise<MessageDeliveryResult>>()
      .mockRejectedValue(new Error(`${SANDBOX_WORKSPACE_PROBE_TIMEOUT_MESSAGE} after 30000ms`));

    const result = await flushNextPendingSessionMessage({
      storage,
      now: 10,
      getDeliveryContext: async () => createContext(),
      validateModeAgainstRuntimeAgents: () => null,
      deliver,
    });

    expect(result).toMatchObject({
      type: 'failure',
      exhausted: true,
      remainingCount: 1,
      nextFlushAttemptAt: undefined,
    });
    expect((await storage.list({ prefix: 'pending_message:' })).size).toBe(1);
  });

  it('terminalizes mode validation failures without consuming retry budget', async () => {
    const storage = createMemoryStorage();
    const message = createPendingSessionMessage({
      messageId: 'msg_018f1e2d3c4bAAAAAAAAAAAAAA',
      role: 'user',
      content: 'queued prompt',
      createdAt: 1,
      executionOptions: { mode: 'bad-mode', model: 'queued-model' },
    });
    await storePendingSessionMessage(storage, message);
    const deliver = vi.fn<(_plan: MessageDeliveryRequest) => Promise<MessageDeliveryResult>>();

    const result = await flushNextPendingSessionMessage({
      storage,
      now: 10,
      getDeliveryContext: async () => createContext(),
      validateModeAgainstRuntimeAgents: () => 'Unknown runtime mode bad-mode',
      deliver,
    });

    expect(result).toMatchObject({
      type: 'failure',
      exhausted: true,
      nextFlushAttemptAt: undefined,
      remainingCount: 1,
    });
    if (result.type !== 'failure') return;
    expect(result.attempts).toBe(1);
    expect(result.message.lastFlushError).toBe('Unknown runtime mode bad-mode');
    expect(deliver).not.toHaveBeenCalled();
    expect(await listPendingSessionMessages(storage)).toHaveLength(1);
  });
});

describe('SessionMessageQueue', () => {
  it('reports whether a message identity already has durable admission state', async () => {
    const harness = createQueueHarness();

    await expect(harness.queue.hasMessageAdmission(FIRST_MESSAGE_ID)).resolves.toBe(false);
    await harness.queue.admitSubmittedMessage({
      userId: 'user_test' as UserId,
      turn: { type: 'prompt', id: FIRST_MESSAGE_ID, prompt: 'queue this prompt' },
    });

    await expect(harness.queue.hasMessageAdmission(FIRST_MESSAGE_ID)).resolves.toBe(true);
  });

  it('admits a durable queued message once and replays the original acknowledgement', async () => {
    const harness = createQueueHarness();
    const request = {
      userId: 'user_test' as UserId,
      turn: { type: 'prompt' as const, id: FIRST_MESSAGE_ID, prompt: 'queue this prompt' },
    };

    const admitted = await harness.queue.admitSubmittedMessage(request);
    const replay = await harness.queue.admitSubmittedMessage(request);
    const pending = await listPendingSessionMessages(harness.storage);
    const messageState = await getSessionMessageState(harness.storage, FIRST_MESSAGE_ID);

    expect(admitted).toEqual({
      success: true,
      outcome: 'queued',
      compatibilityDelivery: 'queued',
      messageId: FIRST_MESSAGE_ID,
    });
    expect(replay).toEqual(admitted);
    expect(pending.map(message => message.messageId)).toEqual([FIRST_MESSAGE_ID]);
    expect(messageState?.status).toBe('queued');
    expect(harness.events.map(event => event.streamEventType)).toEqual(['cloud.message.queued']);
    expect(JSON.parse(harness.events[0]?.payload ?? '{}')).toMatchObject({
      messageId: FIRST_MESSAGE_ID,
      content: 'queue this prompt',
      delivery: 'queued',
    });
    expect(harness.alarmDeadlines).toHaveLength(2);
  });

  it('repairs submitted admission event/drain effects after an event persistence failure', async () => {
    const harness = createQueueHarness({ failQueuedEventOnce: true });
    const request = {
      userId: 'user_test' as UserId,
      turn: { type: 'prompt' as const, id: FIRST_MESSAGE_ID, prompt: 'repair submission' },
    };

    const failed = await harness.queue.admitSubmittedMessage(request);
    const replay = await harness.queue.admitSubmittedMessage(request);

    expect(failed).toMatchObject({ success: false, code: 'INTERNAL' });
    expect(replay).toMatchObject({ success: true, messageId: FIRST_MESSAGE_ID });
    expect(harness.events).toHaveLength(1);
    expect(harness.alarmDeadlines).toHaveLength(1);
  });

  it('repairs submitted admission drain scheduling without duplicating queued event', async () => {
    const harness = createQueueHarness({ failAlarmOnce: true });
    const request = {
      userId: 'user_test' as UserId,
      turn: { type: 'prompt' as const, id: FIRST_MESSAGE_ID, prompt: 'repair drain' },
    };

    const failed = await harness.queue.admitSubmittedMessage(request);
    const replay = await harness.queue.admitSubmittedMessage(request);

    expect(failed).toMatchObject({ success: false, code: 'INTERNAL' });
    expect(replay).toMatchObject({ success: true, messageId: FIRST_MESSAGE_ID });
    expect(harness.events).toHaveLength(1);
    expect(harness.alarmDeadlines).toHaveLength(1);
  });

  it('rejects a conflicting submitted replay for an admitted message identity', async () => {
    const harness = createQueueHarness();
    await harness.queue.admitSubmittedMessage({
      userId: 'user_test' as UserId,
      turn: { type: 'prompt', id: FIRST_MESSAGE_ID, prompt: 'original prompt' },
      agent: { mode: 'plan', model: 'queued-model' },
      finalization: { autoCommit: true },
    });

    const replay = await harness.queue.admitSubmittedMessage({
      userId: 'user_test' as UserId,
      turn: { type: 'prompt', id: FIRST_MESSAGE_ID, prompt: 'changed prompt' },
      agent: { mode: 'code', model: 'default-model' },
      finalization: { autoCommit: false },
    });

    expect(replay).toMatchObject({ success: false, code: 'BAD_REQUEST' });
  });

  it('accepts replay matching predecessor partial immutable constraints without a stored turn', async () => {
    const harness = createQueueHarness();
    await harness.storage.put(`session_message:${FIRST_MESSAGE_ID}`, {
      messageId: FIRST_MESSAGE_ID,
      status: 'accepted',
      prompt: 'unrecoverable old prompt',
      createdAt: 1,
      acceptedAt: 2,
      agent: { mode: 'code', model: 'default-model', variant: 'stable' },
      finalization: { autoCommit: true, condenseOnComplete: false },
    });

    const result = await harness.queue.admitSubmittedMessage({
      userId: 'user_test' as UserId,
      turn: {
        type: 'prompt',
        id: FIRST_MESSAGE_ID,
        prompt: 'new request payload unavailable to compare',
      },
      agent: { mode: 'code', model: 'default-model', variant: 'stable' },
      finalization: { autoCommit: true, condenseOnComplete: false },
    });

    expect(result).toMatchObject({ success: true, compatibilityDelivery: 'sent' });
  });

  it.each([
    {
      agent: { mode: 'plan' as const, model: 'default-model', variant: 'stable' },
      finalization: { autoCommit: true, condenseOnComplete: false },
    },
    {
      agent: { mode: 'code' as const, model: 'changed-model', variant: 'stable' },
      finalization: { autoCommit: true, condenseOnComplete: false },
    },
    {
      agent: { mode: 'code' as const, model: 'default-model', variant: 'changed' },
      finalization: { autoCommit: true, condenseOnComplete: false },
    },
    {
      agent: { mode: 'code' as const, model: 'default-model', variant: 'stable' },
      finalization: { autoCommit: false, condenseOnComplete: false },
    },
  ])('rejects replay changing predecessor stored immutable configuration', async change => {
    const harness = createQueueHarness();
    await harness.storage.put(`session_message:${FIRST_MESSAGE_ID}`, {
      messageId: FIRST_MESSAGE_ID,
      status: 'accepted',
      prompt: 'unrecoverable old prompt',
      createdAt: 1,
      acceptedAt: 2,
      agent: { mode: 'code', model: 'default-model', variant: 'stable' },
      finalization: { autoCommit: true, condenseOnComplete: false },
    });

    const result = await harness.queue.admitSubmittedMessage({
      userId: 'user_test' as UserId,
      turn: { type: 'prompt', id: FIRST_MESSAGE_ID, prompt: 'anything' },
      agent: change.agent,
      finalization: change.finalization,
    });

    expect(result).toMatchObject({ success: false, code: 'BAD_REQUEST' });
  });

  it('accepts canonical replay against predecessor constraints with attachments', async () => {
    const harness = createQueueHarness();
    const attachments = {
      path: '123e4567-e89b-12d3-a456-426614174000',
      files: ['123e4567-e89b-12d3-a456-426614174001.pdf'],
    };
    await harness.storage.put(`session_message:${FIRST_MESSAGE_ID}`, {
      messageId: FIRST_MESSAGE_ID,
      status: 'accepted',
      prompt: 'saved constraint',
      legacyAdmissionConstraints: {
        turn: {
          type: 'prompt',
          messageId: FIRST_MESSAGE_ID,
          prompt: 'saved constraint',
          attachments,
        },
        agent: { mode: 'code', model: 'default-model' },
      },
      createdAt: 1,
      acceptedAt: 2,
    });

    const result = await harness.queue.admitSubmittedMessage({
      userId: 'user_test' as UserId,
      turn: { type: 'prompt', id: FIRST_MESSAGE_ID, prompt: 'saved constraint', attachments },
      agent: { mode: 'code', model: 'default-model' },
    });

    expect(result).toMatchObject({ success: true, compatibilityDelivery: 'sent' });
  });

  it('rejects replay changing a known legacy stored turn payload', async () => {
    const harness = createQueueHarness();
    await harness.storage.put(`session_message:${FIRST_MESSAGE_ID}`, {
      messageId: FIRST_MESSAGE_ID,
      status: 'accepted',
      prompt: 'original',
      turn: { type: 'prompt', messageId: FIRST_MESSAGE_ID, prompt: 'original' },
      createdAt: 1,
      acceptedAt: 2,
      agent: { mode: 'code', model: 'default-model' },
    });

    const result = await harness.queue.admitSubmittedMessage({
      userId: 'user_test' as UserId,
      turn: { type: 'prompt', id: FIRST_MESSAGE_ID, prompt: 'changed' },
      agent: { mode: 'code', model: 'default-model' },
    });

    expect(result).toMatchObject({ success: false, code: 'BAD_REQUEST' });
  });

  it.each(['completed', 'failed', 'interrupted'] as const)(
    'rejects same identity admission after terminal status %s without new effects',
    async status => {
      const harness = createQueueHarness();
      await putSessionMessageState(harness.storage, {
        ...createQueuedSessionMessageState({
          turn: { type: 'prompt', messageId: FIRST_MESSAGE_ID, prompt: 'terminal prompt' },
          agent: { mode: 'code', model: 'default-model' },
        }),
        status,
        terminalAt: 12,
        completionSource: status === 'completed' ? 'assistant_message_event' : 'wrapper_failure',
        callbackEnqueuedAt: 13,
      });

      const result = await harness.queue.admitSubmittedMessage({
        userId: 'user_test' as UserId,
        turn: { type: 'prompt', id: FIRST_MESSAGE_ID, prompt: 'terminal prompt' },
      });

      expect(result).toMatchObject({ success: false, code: 'BAD_REQUEST' });
      expect(harness.events).toHaveLength(0);
      expect(harness.alarmDeadlines).toHaveLength(0);
      expect(await listPendingSessionMessages(harness.storage)).toHaveLength(0);
      await expect(
        getSessionMessageState(harness.storage, FIRST_MESSAGE_ID)
      ).resolves.toMatchObject({
        status,
        terminalAt: 12,
        callbackEnqueuedAt: 13,
      });
    }
  );

  it('admits a new identity after a previous identity terminalized', async () => {
    const harness = createQueueHarness();
    await putSessionMessageState(harness.storage, {
      ...createQueuedSessionMessageState({
        turn: { type: 'prompt', messageId: FIRST_MESSAGE_ID, prompt: 'old terminal prompt' },
        agent: { mode: 'code', model: 'default-model' },
      }),
      status: 'failed',
      terminalAt: 12,
      completionSource: 'wrapper_failure',
    });

    const result = await harness.queue.admitSubmittedMessage({
      userId: 'user_test' as UserId,
      turn: { type: 'prompt', id: SECOND_MESSAGE_ID, prompt: 'new prompt' },
    });

    expect(result).toMatchObject({ success: true, messageId: SECOND_MESSAGE_ID });
    expect(harness.events).toHaveLength(1);
  });

  it('repairs a queued admission whose queued event failed before prompt drain scheduling', async () => {
    const harness = createQueueHarness({ failQueuedEventOnce: true });
    const request = {
      userId: 'user_test' as UserId,
      turn: { type: 'prompt' as const, messageId: FIRST_MESSAGE_ID, prompt: 'repair admission' },
      agent: { mode: 'code' as const, model: 'default-model' },
    };

    await expect(harness.queue.admitAcceptedMessage(request)).rejects.toThrow(
      'failed to persist queued event'
    );
    const replay = await harness.queue.admitAcceptedMessage(request);

    expect(replay).toMatchObject({
      success: true,
      outcome: 'queued',
      compatibilityDelivery: 'queued',
      messageId: FIRST_MESSAGE_ID,
    });
    expect(harness.events).toHaveLength(1);
    expect(harness.alarmDeadlines).toHaveLength(1);
  });

  it('reschedules prompt drain without duplicating a persisted queued event on retry', async () => {
    const harness = createQueueHarness({ failAlarmOnce: true });
    const request = {
      userId: 'user_test' as UserId,
      turn: { type: 'prompt' as const, messageId: FIRST_MESSAGE_ID, prompt: 'repair drain' },
      agent: { mode: 'code' as const, model: 'default-model' },
    };

    await expect(harness.queue.admitAcceptedMessage(request)).rejects.toThrow(
      'failed to schedule prompt drain'
    );
    const replay = await harness.queue.admitAcceptedMessage(request);

    expect(replay).toMatchObject({
      success: true,
      outcome: 'queued',
      compatibilityDelivery: 'queued',
      messageId: FIRST_MESSAGE_ID,
    });
    expect(harness.events).toHaveLength(1);
    expect(harness.alarmDeadlines).toHaveLength(1);
  });

  it('has no registered-initial replay command on its current admission interface', () => {
    const harness = createQueueHarness();

    expect(harness.queue).not.toHaveProperty('enqueue');
    expect(harness.queue).not.toHaveProperty('admitRegisteredInitial');
  });

  it('rejects command turns with generic attachments instead of dropping them', async () => {
    const harness = createQueueHarness();

    const result = await harness.queue.admitSubmittedMessage({
      userId: 'user_test' as UserId,
      turn: {
        type: 'command',
        id: FIRST_MESSAGE_ID,
        command: 'compact',
        arguments: '--aggressive',
        attachments: {
          path: '123e4567-e89b-12d3-a456-426614174000',
          files: ['123e4567-e89b-12d3-a456-426614174001.pdf'],
        },
      },
    });

    expect(result).toEqual({
      success: false,
      code: 'BAD_REQUEST',
      error: 'Attachments cannot be attached to slash commands',
    });
    expect(await listPendingSessionMessages(harness.storage)).toHaveLength(0);
    expect(harness.events).toHaveLength(0);
  });

  it('admits prompt documents as canonical attachments in durable pending state', async () => {
    const harness = createQueueHarness();
    const attachments = {
      path: '123e4567-e89b-12d3-a456-426614174000',
      files: ['123e4567-e89b-12d3-a456-426614174001.pdf'],
    };

    const result = await harness.queue.admitSubmittedMessage({
      userId: 'user_test' as UserId,
      turn: { type: 'prompt', id: FIRST_MESSAGE_ID, prompt: 'read this PDF', attachments },
    });
    const [pending] = await listPendingSessionMessages(harness.storage);

    expect(result).toMatchObject({ success: true, messageId: FIRST_MESSAGE_ID });
    expect(pending?.intent?.turn).toMatchObject({ attachments });
  });

  it('rejects queue admission once durable pending capacity is exhausted', async () => {
    const harness = createQueueHarness();
    for (let index = 0; index < PENDING_SESSION_MESSAGE_LIMIT; index++) {
      await storePendingSessionMessage(
        harness.storage,
        createPendingSessionMessage({
          messageId: `msg_018f1e2d3c4b${String(index).padStart(14, 'A')}`,
          role: 'user',
          content: 'already queued',
          createdAt: index,
        })
      );
    }

    const result = await harness.queue.admitSubmittedMessage({
      userId: 'user_test' as UserId,
      turn: { type: 'prompt', id: FIRST_MESSAGE_ID, prompt: 'overflow' },
    });

    expect(result).toMatchObject({ success: false, code: 'PENDING_QUEUE_FULL' });
    expect(harness.events).toHaveLength(0);
  });

  it('persists the pending intent before queued state admission', async () => {
    const storage = createMemoryStorage(undefined, { failPutPrefix: 'session_message:' });
    const harness = createQueueHarness({ storage });

    const result = await harness.queue.admitSubmittedMessage({
      userId: 'user_test' as UserId,
      turn: { type: 'prompt', id: FIRST_MESSAGE_ID, prompt: 'survive state write failure' },
    });

    expect(result).toMatchObject({ success: false, code: 'INTERNAL' });
    expect((await listPendingSessionMessages(storage)).map(message => message.messageId)).toEqual([
      FIRST_MESSAGE_ID,
    ]);
    expect(harness.events).toHaveLength(0);
  });

  it('repairs missing queued state from a pending callback-enabled message on retry', async () => {
    const callbackTarget = {
      url: 'https://callback.example.com/session',
      headers: { 'x-callback-id': 'callback-1' },
    };
    const harness = createQueueHarness({
      metadata: createMetadata({ callback: { target: callbackTarget } }),
    });
    await storePendingSessionMessage(
      harness.storage,
      createPendingSessionMessage({
        messageId: FIRST_MESSAGE_ID,
        role: 'user',
        content: 'survived without queued state',
        createdAt: 123,
        callbackSnapshot: { required: true, target: callbackTarget },
        executionOptions: {
          mode: 'plan',
          model: 'queued-model',
          variant: 'beta',
          autoCommit: false,
          condenseOnComplete: false,
        },
      })
    );

    const result = await harness.queue.admitSubmittedMessage({
      userId: 'user_test' as UserId,
      turn: { type: 'prompt', id: FIRST_MESSAGE_ID, prompt: 'survived without queued state' },
      agent: { mode: 'plan', model: 'queued-model', variant: 'beta' },
      finalization: { autoCommit: false, condenseOnComplete: false },
    });

    const repairedState = await getSessionMessageState(harness.storage, FIRST_MESSAGE_ID);
    expect(result).toEqual({
      success: true,
      outcome: 'queued',
      compatibilityDelivery: 'queued',
      messageId: FIRST_MESSAGE_ID,
    });
    expect(repairedState).toMatchObject({
      messageId: FIRST_MESSAGE_ID,
      status: 'queued',
      prompt: 'survived without queued state',
      createdAt: 123,
      queuedAt: 123,
      callbackRequired: true,
      callbackTarget,
      admissionSnapshot: {
        agent: { mode: 'plan', model: 'queued-model', variant: 'beta' },
      },
    });
    expect(repairedState).not.toHaveProperty('agent');
    expect(repairedState).not.toHaveProperty('finalization');
    expect(harness.events).toHaveLength(1);
    expect(harness.alarmDeadlines).toHaveLength(1);
  });

  it('retries queued effect completion before dispatch when reconstructed queued state already exists', async () => {
    let dispatchCount = 0;
    const harness = createQueueHarness({
      failQueuedEventOnce: true,
      deliver: async plan => {
        dispatchCount += 1;
        return {
          success: true,
          outcome: 'accepted',
          messageId: plan.turn.messageId,
          wrapperRunId: 'wr_test',
        };
      },
    });
    const intent = {
      turn: { type: 'prompt' as const, messageId: FIRST_MESSAGE_ID, prompt: 'repair before send' },
      agent: { mode: 'code', model: 'default-model' },
    };
    await storePendingSessionMessage(
      harness.storage,
      createPendingSessionMessageFromIntent(intent)
    );

    await expect(harness.queue.drainNextPendingMessage()).rejects.toThrow(
      'failed to persist queued event'
    );
    expect(dispatchCount).toBe(0);
    expect((await getSessionMessageState(harness.storage, FIRST_MESSAGE_ID))?.status).toBe(
      'queued'
    );

    await harness.queue.drainNextPendingMessage();

    expect(dispatchCount).toBe(1);
    expect(harness.events).toHaveLength(1);
  });

  it('repairs queued lifecycle effects from pending intent before wrapper dispatch', async () => {
    const dispatchObservations: Array<{ status?: string; queuedEventCount: number }> = [];
    const harness = createQueueHarness({
      deliver: async plan => {
        dispatchObservations.push({
          status: (await getSessionMessageState(harness.storage, plan.turn.messageId))?.status,
          queuedEventCount: harness.events.length,
        });
        return {
          success: true,
          outcome: 'accepted',
          messageId: plan.turn.messageId,
          wrapperRunId: 'wr_test',
        };
      },
    });
    await storePendingSessionMessage(
      harness.storage,
      createPendingSessionMessageFromIntent({
        turn: { type: 'prompt', messageId: FIRST_MESSAGE_ID, prompt: 'recover before dispatch' },
        agent: { mode: 'code', model: 'default-model' },
      })
    );

    await harness.queue.drainNextPendingMessage();

    expect(dispatchObservations).toEqual([{ status: 'queued', queuedEventCount: 1 }]);
    expect(harness.alarmDeadlines).toHaveLength(1);
  });

  it('keeps accepted pending residue when sent-effect repair fails so a later drain can retry it', async () => {
    const deliver = vi.fn().mockResolvedValue({
      success: true,
      outcome: 'accepted',
      messageId: FIRST_MESSAGE_ID,
      wrapperRunId: 'wr_test',
    });
    const harness = createQueueHarness({
      deliver,
      ensureAcceptedMessageEffects: async () => {
        throw new Error('sent event unavailable');
      },
    });
    await storePendingSessionMessage(
      harness.storage,
      createPendingSessionMessageFromIntent({
        turn: { type: 'prompt', messageId: FIRST_MESSAGE_ID, prompt: 'already accepted' },
        agent: { mode: 'code', model: 'default-model' },
      })
    );
    await putSessionMessageState(harness.storage, {
      ...createQueuedSessionMessageState({
        turn: { type: 'prompt', messageId: FIRST_MESSAGE_ID, prompt: 'already accepted' },
        agent: { mode: 'code', model: 'default-model' },
      }),
      status: 'accepted',
      acceptedAt: 3,
      wrapperRunId: 'wr_existing',
    });

    await expect(harness.queue.drainNextPendingMessage()).rejects.toThrow('sent event unavailable');

    expect(deliver).not.toHaveBeenCalled();
    expect(await listPendingSessionMessages(harness.storage)).toHaveLength(1);
  });

  it('cleans accepted pending residue and repairs sent effects without redelivery', async () => {
    const repaired: string[] = [];
    const deliver = vi.fn().mockResolvedValue({
      success: true,
      outcome: 'accepted',
      messageId: FIRST_MESSAGE_ID,
      wrapperRunId: 'wr_test',
    });
    const harness = createQueueHarness({
      deliver,
      ensureAcceptedMessageEffects: async messageId => {
        repaired.push(messageId);
      },
    });
    await storePendingSessionMessage(
      harness.storage,
      createPendingSessionMessageFromIntent({
        turn: { type: 'prompt', messageId: FIRST_MESSAGE_ID, prompt: 'already accepted' },
        agent: { mode: 'code', model: 'default-model' },
      })
    );
    await putSessionMessageState(harness.storage, {
      ...createQueuedSessionMessageState({
        turn: { type: 'prompt', messageId: FIRST_MESSAGE_ID, prompt: 'already accepted' },
        agent: { mode: 'code', model: 'default-model' },
      }),
      status: 'accepted',
      acceptedAt: 3,
      wrapperRunId: 'wr_existing',
    });

    await harness.queue.drainNextPendingMessage();

    expect(deliver).not.toHaveBeenCalled();
    expect(repaired).toEqual([FIRST_MESSAGE_ID]);
    expect(await listPendingSessionMessages(harness.storage)).toHaveLength(0);
  });

  it('cleans a stale pending row for terminal lifecycle state without redelivery', async () => {
    const deliver = vi.fn().mockResolvedValue({
      success: true,
      outcome: 'accepted',
      messageId: FIRST_MESSAGE_ID,
      wrapperRunId: 'wr_test',
    });
    const harness = createQueueHarness({ deliver });
    await storePendingSessionMessage(
      harness.storage,
      createPendingSessionMessageFromIntent({
        turn: { type: 'prompt', messageId: FIRST_MESSAGE_ID, prompt: 'must not redeliver' },
        agent: { mode: 'code', model: 'default-model' },
      })
    );
    await putSessionMessageState(harness.storage, {
      ...createQueuedSessionMessageState({
        turn: { type: 'prompt', messageId: FIRST_MESSAGE_ID, prompt: 'must not redeliver' },
        agent: { mode: 'code', model: 'default-model' },
      }),
      status: 'failed',
      terminalAt: 3,
      completionSource: 'delivery_failure',
      terminalEffects: { event: 'pending', callback: { disposition: 'not-required' } },
    });

    const drain = await harness.queue.drainNextPendingMessage();

    expect(deliver).not.toHaveBeenCalled();
    expect(await listPendingSessionMessages(harness.storage)).toHaveLength(0);
    expect(drain.remainingPendingCount).toBe(0);
  });

  it('hands exhausted queued delivery to settlement terminalization', async () => {
    const harness = createQueueHarness({
      deliver: async () => ({ success: false, code: 'BAD_REQUEST', error: 'invalid queued turn' }),
    });
    await harness.queue.admitSubmittedMessage({
      userId: 'user_test' as UserId,
      turn: { type: 'prompt', id: FIRST_MESSAGE_ID, prompt: 'terminalize me' },
    });

    const drain = await harness.queue.drainNextPendingMessage();

    expect(drain).toEqual({ retryAt: undefined, remainingPendingCount: 0 });
    expect(harness.terminalizations).toEqual([
      {
        messageId: FIRST_MESSAGE_ID,
        params: {
          kind: 'failed',
          reason: 'exhausted',
          error: 'invalid queued turn',
          completionSource: 'delivery_failure',
          attempts: 1,
        },
        options: { allowIdleBatchWithoutObservedIdle: true },
      },
    ]);
    expect(await listPendingSessionMessages(harness.storage)).toHaveLength(0);
    expect(harness.finalizedTerminalCallbacks).toEqual([{ allowWithoutObservedIdle: true }]);
  });

  it('builds reconnect snapshots for pending and never-accepted terminal queued messages', async () => {
    const harness = createQueueHarness();
    await storePendingSessionMessage(
      harness.storage,
      createPendingSessionMessage({
        messageId: SECOND_MESSAGE_ID,
        role: 'user',
        content: 'still pending',
        createdAt: 20,
      })
    );
    await putSessionMessageState(harness.storage, {
      ...createQueuedSessionMessageState(
        {
          turn: {
            type: 'prompt',
            messageId: FIRST_MESSAGE_ID,
            prompt: 'failed before acceptance',
          },
          agent: { mode: 'code', model: 'default-model' },
        },
        undefined,
        10
      ),
      status: 'failed',
      terminalAt: 30,
      completionSource: 'delivery_failure',
      failureReason: 'exhausted',
      error: 'delivery exhausted',
      attempts: 2,
    });

    const snapshots = await harness.queue.snapshotForStreamConnect();

    expect(snapshots).toEqual([
      {
        messageId: FIRST_MESSAGE_ID,
        content: 'failed before acceptance',
        timestamp: 10,
        terminalFailure: {
          status: 'failed',
          completionSource: 'delivery_failure',
          reason: 'exhausted',
          error: 'delivery exhausted',
          attempts: 2,
          timestamp: 30,
        },
      },
      {
        messageId: SECOND_MESSAGE_ID,
        content: 'still pending',
        timestamp: 20,
      },
    ]);
  });

  it('omits a reconnect delivery failure after a later turn completed', async () => {
    const harness = createQueueHarness();
    await putSessionMessageState(harness.storage, {
      ...createQueuedSessionMessageState(
        {
          turn: {
            type: 'prompt',
            messageId: FIRST_MESSAGE_ID,
            prompt: 'failed before acceptance',
          },
          agent: { mode: 'code', model: 'default-model' },
        },
        undefined,
        10
      ),
      status: 'failed',
      terminalAt: 30,
      completionSource: 'delivery_failure',
      failureReason: 'exhausted',
      error: 'delivery exhausted',
      attempts: 1,
    });
    await putSessionMessageState(harness.storage, {
      ...createQueuedSessionMessageState(
        {
          turn: {
            type: 'prompt',
            messageId: SECOND_MESSAGE_ID,
            prompt: 'delivered later',
          },
          agent: { mode: 'code', model: 'default-model' },
        },
        undefined,
        40
      ),
      status: 'completed',
      acceptedAt: 50,
      terminalAt: 60,
      completionSource: 'assistant_message_event',
    });

    await expect(harness.queue.snapshotForStreamConnect()).resolves.toEqual([]);
  });

  it('omits a reconnect delivery failure while a later turn is accepted', async () => {
    const harness = createQueueHarness();
    await putSessionMessageState(harness.storage, {
      ...createQueuedSessionMessageState(
        {
          turn: {
            type: 'prompt',
            messageId: FIRST_MESSAGE_ID,
            prompt: 'failed before acceptance',
          },
          agent: { mode: 'code', model: 'default-model' },
        },
        undefined,
        10
      ),
      status: 'failed',
      terminalAt: 30,
      completionSource: 'delivery_failure',
      failureReason: 'exhausted',
      error: 'delivery exhausted',
      attempts: 1,
    });
    await putSessionMessageState(harness.storage, {
      ...createQueuedSessionMessageState(
        {
          turn: {
            type: 'prompt',
            messageId: SECOND_MESSAGE_ID,
            prompt: 'currently running',
          },
          agent: { mode: 'code', model: 'default-model' },
        },
        undefined,
        40
      ),
      status: 'accepted',
      acceptedAt: 50,
    });

    await expect(harness.queue.snapshotForStreamConnect()).resolves.toEqual([]);
  });

  it('terminalizes pending queued work before deleting it during interrupt handoff', async () => {
    const harness = createQueueHarness();
    const first = createPendingSessionMessage({
      messageId: FIRST_MESSAGE_ID,
      role: 'user',
      content: 'first pending',
      createdAt: 1,
    });
    const second = createPendingSessionMessage({
      messageId: SECOND_MESSAGE_ID,
      role: 'user',
      content: 'second pending',
      createdAt: 2,
    });
    await storePendingSessionMessage(harness.storage, first);
    await storePendingSessionMessage(harness.storage, second);

    const cleared = await harness.queue.interruptPendingQueuedMessages(async messages => {
      expect(messages.map((message: PendingSessionMessage) => message.messageId)).toEqual([
        FIRST_MESSAGE_ID,
        SECOND_MESSAGE_ID,
      ]);
      expect(await listPendingSessionMessages(harness.storage)).toEqual([first, second]);
      expect(harness.terminalizations).toHaveLength(2);
    });

    expect(cleared.map((message: PendingSessionMessage) => message.messageId)).toEqual([
      FIRST_MESSAGE_ID,
      SECOND_MESSAGE_ID,
    ]);
    expect(await listPendingSessionMessages(harness.storage)).toEqual([]);
    expect(harness.terminalizations).toEqual([
      {
        messageId: FIRST_MESSAGE_ID,
        params: {
          kind: 'interrupted',
          error: 'Pending queued message interrupted by user',
          completionSource: 'interrupt',
        },
        options: { allowIdleBatchWithoutObservedIdle: true },
      },
      {
        messageId: SECOND_MESSAGE_ID,
        params: {
          kind: 'interrupted',
          error: 'Pending queued message interrupted by user',
          completionSource: 'interrupt',
        },
        options: { allowIdleBatchWithoutObservedIdle: true },
      },
    ]);
  });

  it('retains pending intent and fails interruption when durable state transition fails', async () => {
    const harness = createQueueHarness({ failTerminalizationOnce: true });
    const first = createPendingSessionMessage({
      messageId: FIRST_MESSAGE_ID,
      role: 'user',
      content: 'first pending',
      createdAt: 1,
    });
    const second = createPendingSessionMessage({
      messageId: SECOND_MESSAGE_ID,
      role: 'user',
      content: 'second pending',
      createdAt: 2,
    });
    await storePendingSessionMessage(harness.storage, first);
    await storePendingSessionMessage(harness.storage, second);

    await expect(harness.queue.interruptPendingQueuedMessages()).rejects.toThrow(
      'terminal transition failed'
    );

    expect(harness.terminalizations).toHaveLength(0);
    expect(
      (await listPendingSessionMessages(harness.storage)).map(message => message.messageId)
    ).toEqual([FIRST_MESSAGE_ID, SECOND_MESSAGE_ID]);
  });

  it('terminalizes interrupted callback-required queued messages as idle-batch eligible', async () => {
    const harness = createQueueHarness({
      metadata: createMetadata({
        callback: {
          target: { url: 'https://callback.example.com/session' },
        },
      }),
    });
    await harness.queue.admitSubmittedMessage({
      userId: 'user_test' as UserId,
      turn: { type: 'prompt', id: FIRST_MESSAGE_ID, prompt: 'callback queued prompt' },
    });

    await harness.queue.interruptPendingQueuedMessages();

    expect(harness.terminalizations).toEqual([
      {
        messageId: FIRST_MESSAGE_ID,
        params: {
          kind: 'interrupted',
          error: 'Pending queued message interrupted by user',
          completionSource: 'interrupt',
        },
        options: { allowIdleBatchWithoutObservedIdle: true },
      },
    ]);
  });
});
