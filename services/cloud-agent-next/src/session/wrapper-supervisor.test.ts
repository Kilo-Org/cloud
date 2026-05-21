import { describe, expect, it, vi } from 'vitest';
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
import {
  createWrapperSupervisor,
  type WrapperReconnectDecision,
  type WrapperSupervisorStorage,
} from './wrapper-supervisor.js';
import { getWrapperRuntimeState } from './wrapper-runtime-state.js';

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
}));

type MemoryStorage = WrapperSupervisorStorage & MessageSettlementOutboxStorage;

type MessageEvent = {
  sessionId: string;
  streamEventType: string;
  payload: string;
  timestamp: number;
};

const WRAPPER_RUN_ID = 'wr_supervisor';
const WRAPPER_CONNECTION_ID = 'conn_supervisor';
const MESSAGE_ID = 'msg_018f1e2d3c4bSupvMsgAbCdEfG';

function createMemoryStorage(initialEntries?: Array<[string, unknown]>): MemoryStorage {
  const store = new Map(initialEntries ?? []);
  return {
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
    async list<T = unknown>({ prefix }: { prefix: string }): Promise<Map<string, T>> {
      return new Map(
        Array.from(store.entries()).filter(([key]) => key.startsWith(prefix)) as Array<[string, T]>
      );
    },
  } as MemoryStorage;
}

function createMetadata(): SessionMetadata {
  return {
    metadataSchemaVersion: 2,
    identity: {
      sessionId: 'agent_supervisor',
      userId: 'user_supervisor',
    },
    auth: {
      kiloSessionId: 'kilo_supervisor',
    },
    lifecycle: {
      version: 1,
      timestamp: 1,
    },
  } satisfies SessionMetadata;
}

function acceptedMessage(messageId = MESSAGE_ID): SessionMessageState {
  return {
    messageId,
    status: 'accepted',
    prompt: 'supervise this wrapper',
    createdAt: 1_000,
    acceptedAt: 2_000,
    wrapperRunId: WRAPPER_RUN_ID,
  };
}

function createHarness(initialEntries?: Array<[string, unknown]>) {
  const storage = createMemoryStorage(initialEntries);
  const events: MessageEvent[] = [];
  const sentPings: string[] = [];
  const stops: string[] = [];
  const currentMetadata = createMetadata();
  const settlementOutbox = createMessageSettlementOutbox({
    storage,
    getMetadata: async () => currentMetadata,
    requireSessionId: async () => currentMetadata.identity.sessionId,
    resolveCallbackSessionId: async metadata => metadata?.identity.sessionId ?? '',
    getCallbackQueue: () => undefined,
    getAssistantMessageForUserMessage: () => null,
    insertAndBroadcastMessageEvent: event => {
      events.push(event);
    },
    hasObservedWrapperIdle: async () => true,
    requestAlarmAtOrBefore: async () => {},
    getSessionIdForLogs: () => currentMetadata.identity.sessionId,
  });
  const requestPendingDrainIfNeeded = vi.fn().mockResolvedValue(false);
  const failExecution = vi.fn().mockResolvedValue(true);
  const supervisor = createWrapperSupervisor({
    storage,
    agentRuntime: {
      sendPing: ingestTagId => {
        sentPings.push(ingestTagId);
      },
      stopWrapperProcess: async reason => {
        stops.push(reason);
        return true;
      },
    },
    messageSettlementOutbox: settlementOutbox,
    sessionMessageQueue: { requestPendingDrainIfNeeded },
    getMetadata: async () => currentMetadata,
    getAssistantMessageForUserMessage: () => null,
    getCurrentRuntimeExecutionId: async () => null,
    getExecution: async () => null,
    hasActiveIngestConnection: async () => false,
    failExecution,
    clearInterruptRequest: async () => {},
    getSessionIdForLogs: () => currentMetadata.identity.sessionId,
  });

  return {
    storage,
    events,
    sentPings,
    stops,
    failExecution,
    requestPendingDrainIfNeeded,
    supervisor,
  };
}

function liveRuntimeState(overrides?: Record<string, unknown>): [string, unknown] {
  return [
    'wrapper_runtime_state',
    {
      wrapperGeneration: 4,
      wrapperConnectionId: WRAPPER_CONNECTION_ID,
      wrapperRunId: WRAPPER_RUN_ID,
      ...overrides,
    },
  ];
}

describe('WrapperSupervisor', () => {
  it('starts disconnect grace for current accepted work and cancels it after an approved fenced reconnect', async () => {
    const harness = createHarness([liveRuntimeState()]);
    await putSessionMessageState(harness.storage, acceptedMessage());

    await harness.supervisor.onDisconnected({
      disconnected: {
        wrapperRunId: WRAPPER_RUN_ID,
        wrapperGeneration: 4,
        wrapperConnectionId: WRAPPER_CONNECTION_ID,
      },
      wsCloseCode: 1006,
      wsCloseReason: 'socket closed',
    });

    const grace = await harness.storage.get<{
      wrapperGeneration?: number;
      wrapperConnectionId?: string;
    }>('disconnect_grace');
    expect(grace).toMatchObject({
      wrapperGeneration: 4,
      wrapperConnectionId: WRAPPER_CONNECTION_ID,
    });

    const decision = await harness.supervisor.checkReconnect({
      wrapperRunId: WRAPPER_RUN_ID,
      wrapperGeneration: 4,
      wrapperConnectionId: WRAPPER_CONNECTION_ID,
    });
    expect(decision).toEqual({ accepted: true } satisfies WrapperReconnectDecision);

    await harness.supervisor.recordReconnectAccepted({
      wrapperGeneration: 4,
      wrapperConnectionId: WRAPPER_CONNECTION_ID,
    });
    await expect(harness.storage.get('disconnect_grace')).resolves.toBeUndefined();
  });

  it('rejects a stale wrapper run before reconnect grace can be cancelled', async () => {
    const harness = createHarness([
      liveRuntimeState(),
      [
        'disconnect_grace',
        {
          wrapperRunId: WRAPPER_RUN_ID,
          disconnectedAt: 1,
          wsCloseCode: 1006,
          wsCloseReason: 'socket closed',
          wrapperGeneration: 4,
          wrapperConnectionId: WRAPPER_CONNECTION_ID,
        },
      ],
    ]);

    await expect(
      harness.supervisor.checkReconnect({
        wrapperRunId: 'wr_stale',
        wrapperGeneration: 4,
        wrapperConnectionId: WRAPPER_CONNECTION_ID,
      })
    ).resolves.toEqual({ accepted: false, reason: 'stale-wrapper-run' });
    await expect(harness.storage.get('disconnect_grace')).resolves.toBeDefined();
  });

  it('fails accepted messages and cleans up an unhealthy no-output wrapper', async () => {
    const harness = createHarness([
      liveRuntimeState({ noOutputDeadlineAt: 9_000, nextPingAt: 30_000 }),
    ]);
    await putSessionMessageState(harness.storage, acceptedMessage());

    await harness.supervisor.runMaintenance(10_000);

    const state = await getSessionMessageState(harness.storage, MESSAGE_ID);
    const runtimeState = await getWrapperRuntimeState(harness.storage);
    expect(state).toMatchObject({
      status: 'failed',
      failureReason: 'wrapper_failure',
      error: 'Wrapper accepted the message but produced no output',
      completionSource: 'wrapper_failure',
    });
    expect(runtimeState.wrapperConnectionId).toBeUndefined();
    expect(harness.stops).toEqual(['unhealthy-wrapper']);
    expect(harness.events.map(event => event.streamEventType)).toEqual(['cloud.message.failed']);
  });

  it('reconciles accepted idle work after its root-idle deadline', async () => {
    const harness = createHarness([
      liveRuntimeState({
        lastWrapperIdleAt: 1_000,
        idleReconcileAfter: 9_000,
        wrapperIdleDeadlineAt: 50_000,
      }),
    ]);
    await putSessionMessageState(harness.storage, acceptedMessage());

    await harness.supervisor.runMaintenance(10_000);

    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'missing_assistant_reply',
      error: 'No assistant reply found after idle timeout',
      completionSource: 'idle_reconciliation',
    });
  });

  it('cleans up an idle keep-warm wrapper only after the deadline has no queued or accepted work', async () => {
    const harness = createHarness([liveRuntimeState({ wrapperIdleDeadlineAt: 9_000 })]);

    await harness.supervisor.runMaintenance(10_000);

    const runtimeState = await getWrapperRuntimeState(harness.storage);
    expect(runtimeState.wrapperConnectionId).toBeUndefined();
    expect(runtimeState.wrapperGeneration).toBe(5);
    expect(harness.stops).toEqual(['keep-warm-expired']);
  });
});
