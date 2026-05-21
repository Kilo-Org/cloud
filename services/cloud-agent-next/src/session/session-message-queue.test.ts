import { describe, expect, it, vi } from 'vitest';
import type {
  ExecutionDeliveryContext,
  MessageDeliveryPlan,
  QueueSessionMessageResult,
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
};

function createMemoryStorage(
  initialEntries?: Array<[string, unknown]>
): SessionMessageQueueStorage {
  const store = new Map(initialEntries ?? []);
  return {
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
  deliver?: (plan: MessageDeliveryPlan) => Promise<QueueSessionMessageResult>;
}) {
  const storage = createMemoryStorage();
  const events: QueueEvent[] = [];
  const alarmDeadlines: number[] = [];
  const terminalizations: Terminalization[] = [];
  const metadata = options?.metadata === undefined ? createMetadata() : options.metadata;
  const deliver = vi.fn(
    options?.deliver ??
      (async (plan: MessageDeliveryPlan): Promise<QueueSessionMessageResult> => ({
        success: true,
        status: 'started',
        messageId: plan.turn.messageId,
        delivery: 'sent',
        wrapperRunId: 'wr_test',
      }))
  );

  return {
    storage,
    events,
    alarmDeadlines,
    terminalizations,
    deliver,
    queue: createSessionMessageQueue({
      storage,
      getMetadata: async () => metadata,
      requireSessionId: async () => metadata?.identity.sessionId ?? 'agent_test',
      validateModeAgainstRuntimeAgents: () => null,
      getDeliveryContext: async () => (metadata ? createContext(metadata) : null),
      hasCurrentRuntimeExecution: async () => false,
      hasActiveAcceptedWrapperMessages: async () => false,
      isLegacyAcceptedMessageRunning: async () => false,
      deliver,
      insertAndBroadcastMessageEvent: event => {
        events.push(event);
      },
      terminalizeSessionMessageOnce: async (messageId, params) => {
        terminalizations.push({ messageId, params });
      },
      requestAlarmAtOrBefore: async deadline => {
        alarmDeadlines.push(deadline);
      },
      getSessionIdForLogs: () => metadata?.identity.sessionId,
    }),
  };
}

const FIRST_MESSAGE_ID = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';
const SECOND_MESSAGE_ID = 'msg_018f1e2d3c4bBBBBBBBBBBBBBB';

describe('recordPendingFlushFailure backoff progression', () => {
  it('applies warm follow-up retry backoff', async () => {
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

    for (let i = 0; i < 5; i++) {
      const result = await recordPendingFlushFailure(storage, message, 'test error', now, {
        policy: 'warm-followup',
        code: 'WORKSPACE_SETUP_FAILED',
      });
      delays.push(
        result.nextFlushAttemptAt !== undefined ? result.nextFlushAttemptAt - now : undefined
      );
      message = result.message;
    }

    expect(delays).toEqual([2_000, 4_000, 8_000, 15_000, undefined]);
  });

  it('applies extended cold-init retry backoff', async () => {
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

    for (let i = 0; i < 10; i++) {
      const result = await recordPendingFlushFailure(storage, message, 'test error', now, {
        policy: 'cold-init',
        code: 'WORKSPACE_SETUP_FAILED',
      });
      delays.push(
        result.nextFlushAttemptAt !== undefined ? result.nextFlushAttemptAt - now : undefined
      );
      message = result.message;
    }

    expect(delays).toEqual([
      2_000,
      4_000,
      8_000,
      16_000,
      32_000,
      60_000,
      60_000,
      60_000,
      120_000,
      undefined,
    ]);
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
      .fn<(_plan: MessageDeliveryPlan) => Promise<QueueSessionMessageResult>>()
      .mockResolvedValueOnce({
        success: false,
        code: 'WORKSPACE_SETUP_FAILED',
        error: 'workspace restore failed',
      })
      .mockResolvedValueOnce({
        success: true,
        status: 'started',
        messageId: FIRST_MESSAGE_ID,
        delivery: 'sent',
      });

    const first = await flushNextPendingSessionMessage({
      storage,
      now: 10,
      drainPolicy: 'ensure-wrapper',
      hasCurrentRuntimeExecution: async () => false,
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
      drainPolicy: 'ensure-wrapper',
      hasCurrentRuntimeExecution: async () => false,
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
      workspace: {
        repositoryAuthOverrides: {
          githubToken: 'queued-gh-token',
          gitToken: 'queued-git-token',
        },
      },
    });
    expect((await storage.list({ prefix: 'pending_message:' })).size).toBe(0);
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
      .fn<(_plan: MessageDeliveryPlan) => Promise<QueueSessionMessageResult>>()
      .mockRejectedValue(new Error(`${SANDBOX_WORKSPACE_PROBE_TIMEOUT_MESSAGE} after 30000ms`));

    const result = await flushNextPendingSessionMessage({
      storage,
      now: 10,
      drainPolicy: 'ensure-wrapper',
      hasCurrentRuntimeExecution: async () => false,
      getDeliveryContext: async () => createContext(),
      validateModeAgainstRuntimeAgents: () => null,
      deliver,
    });

    expect(result).toMatchObject({
      type: 'failure',
      exhausted: true,
      remainingCount: 0,
      nextFlushAttemptAt: undefined,
    });
    expect((await storage.list({ prefix: 'pending_message:' })).size).toBe(0);
  });
});

describe('SessionMessageQueue', () => {
  it('admits a durable queued message once and replays the original acknowledgement', async () => {
    const harness = createQueueHarness();
    const request = {
      kind: 'user-message' as const,
      userId: 'user_test' as UserId,
      message: { id: FIRST_MESSAGE_ID, prompt: 'queue this prompt' },
    };

    const admitted = await harness.queue.enqueue(request);
    const replay = await harness.queue.enqueue(request);
    const pending = await listPendingSessionMessages(harness.storage);
    const messageState = await getSessionMessageState(harness.storage, FIRST_MESSAGE_ID);

    expect(admitted).toEqual({
      success: true,
      status: 'started',
      messageId: FIRST_MESSAGE_ID,
      delivery: 'queued',
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
    expect(harness.alarmDeadlines).toHaveLength(1);
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

    const result = await harness.queue.enqueue({
      kind: 'user-message',
      userId: 'user_test' as UserId,
      message: { id: FIRST_MESSAGE_ID, prompt: 'overflow' },
    });

    expect(result).toMatchObject({ success: false, code: 'PENDING_QUEUE_FULL' });
    expect(harness.events).toHaveLength(0);
  });

  it('hands exhausted queued delivery to settlement terminalization', async () => {
    const harness = createQueueHarness({
      deliver: async () => ({ success: false, code: 'BAD_REQUEST', error: 'invalid queued turn' }),
    });
    await harness.queue.enqueue({
      kind: 'user-message',
      userId: 'user_test' as UserId,
      message: { id: FIRST_MESSAGE_ID, prompt: 'terminalize me' },
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
      },
    ]);
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
          turn: { messageId: FIRST_MESSAGE_ID, prompt: 'failed before acceptance' },
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

  it('clears and terminalizes pending queued work on interrupt handoff', async () => {
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
      expect(await listPendingSessionMessages(harness.storage)).toEqual([]);
      expect(harness.terminalizations).toEqual([]);
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
      },
      {
        messageId: SECOND_MESSAGE_ID,
        params: {
          kind: 'interrupted',
          error: 'Pending queued message interrupted by user',
          completionSource: 'interrupt',
        },
      },
    ]);
  });
});
