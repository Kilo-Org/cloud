import { describe, expect, it, vi } from 'vitest';
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
  entityId: string;
};

const WRAPPER_RUN_ID = 'wr_supervisor';
const WRAPPER_CONNECTION_ID = 'conn_supervisor';
const MESSAGE_ID = 'msg_018f1e2d3c4bSupvMsgAbCdEfG';
const NEWER_MESSAGE_ID = 'msg_018f1e2d3c4bNewerMsgAbCdEF';

function createMemoryStorage(
  initialEntries?: Array<[string, unknown]>,
  options?: { beforeList?: (prefix: string) => Promise<void> }
): MemoryStorage {
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
      await options?.beforeList?.(prefix);
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

function createHarness(
  initialEntries?: Array<[string, unknown]>,
  options?: {
    metadata?: SessionMetadata;
    storageHooks?: { beforeList?: (prefix: string) => Promise<void> };
  }
) {
  const storage = createMemoryStorage(initialEntries, options?.storageHooks);
  const events: MessageEvent[] = [];
  const callbackJobs: CallbackJob[] = [];
  const sentPings: string[] = [];
  const stops: string[] = [];
  const currentMetadata = options?.metadata ?? createMetadata();
  const settlementOutbox = createMessageSettlementOutbox({
    storage,
    getMetadata: async () => currentMetadata,
    requireSessionId: async () => currentMetadata.identity.sessionId,
    resolveCallbackSessionId: async metadata => metadata?.identity.sessionId ?? '',
    getCallbackQueue: () => ({
      send: async job => {
        callbackJobs.push(job);
      },
    }),
    sendPushNotification: async () => ({ dispatched: true }),
    hasConnectedStreamClients: () => false,
    getAssistantMessageForUserMessage: () => null,
    ensureTerminalMessageEvent: event => {
      if (!events.some(existing => existing.entityId === event.entityId)) events.push(event);
    },
    hasObservedWrapperIdle: async () => true,
    requestAlarmAtOrBefore: async () => {},
    getSessionIdForLogs: () => currentMetadata.identity.sessionId,
  });
  const requestPendingDrainIfNeeded = vi.fn().mockResolvedValue(false);
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
    hasActiveIngestConnection: async () => false,
    clearInterruptRequest: async () => {},
    getSessionIdForLogs: () => currentMetadata.identity.sessionId,
  });

  return {
    storage,
    events,
    callbackJobs,
    sentPings,
    stops,
    requestPendingDrainIfNeeded,
    settlementOutbox,
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

  it('starts disconnect grace while a completed gate callback still waits for wrapper terminal state', async () => {
    const harness = createHarness([liveRuntimeState()], {
      metadata: {
        ...createMetadata(),
        finalization: { gateThreshold: 'warning' },
      },
    });
    await putSessionMessageState(harness.storage, {
      ...acceptedMessage(),
      callbackRequired: true,
      callbackTarget: { url: 'https://example.com/gate-wait' },
    });
    await harness.settlementOutbox.terminalizeSessionMessageOnce(MESSAGE_ID, {
      kind: 'completed',
      completionSource: 'assistant_message_event',
    });

    await harness.supervisor.onDisconnected({
      disconnected: {
        wrapperRunId: WRAPPER_RUN_ID,
        wrapperGeneration: 4,
        wrapperConnectionId: WRAPPER_CONNECTION_ID,
      },
      wsCloseCode: 1006,
      wsCloseReason: 'socket closed before wrapper terminal',
    });

    await expect(harness.storage.get('disconnect_grace')).resolves.toBeDefined();
    expect(harness.callbackJobs).toHaveLength(0);
  });

  it('releases a gate-waiting callback after disconnect grace expires without a terminal event', async () => {
    const harness = createHarness([liveRuntimeState()], {
      metadata: {
        ...createMetadata(),
        finalization: { gateThreshold: 'warning' },
      },
    });
    await putSessionMessageState(harness.storage, {
      ...acceptedMessage(),
      callbackRequired: true,
      callbackTarget: { url: 'https://example.com/disconnect-release' },
    });
    await harness.settlementOutbox.terminalizeSessionMessageOnce(MESSAGE_ID, {
      kind: 'completed',
      completionSource: 'assistant_message_event',
    });
    await harness.supervisor.onDisconnected({
      disconnected: {
        wrapperRunId: WRAPPER_RUN_ID,
        wrapperGeneration: 4,
        wrapperConnectionId: WRAPPER_CONNECTION_ID,
      },
      wsCloseCode: 1006,
      wsCloseReason: 'socket closed before wrapper terminal',
    });

    const grace = await harness.storage.get<{ disconnectedAt: number }>('disconnect_grace');
    if (!grace) throw new Error('Expected disconnect grace to be persisted');
    await harness.supervisor.runMaintenance(grace.disconnectedAt + 10_001);

    expect(harness.callbackJobs).toHaveLength(1);
    expect(harness.callbackJobs[0].payload).toMatchObject({
      messageId: MESSAGE_ID,
      status: 'completed',
    });
    expect(harness.callbackJobs[0].payload.gateResult).toBeUndefined();
  });

  it('releases a gate-waiting callback when disconnect grace expires after wrapper generation changed', async () => {
    const harness = createHarness(
      [
        liveRuntimeState({ wrapperGeneration: 5, wrapperConnectionId: 'conn_new_generation' }),
        [
          'disconnect_grace',
          {
            wrapperRunId: WRAPPER_RUN_ID,
            disconnectedAt: 1_000,
            wsCloseCode: 1006,
            wsCloseReason: 'socket closed before wrapper terminal',
            wrapperGeneration: 4,
            wrapperConnectionId: WRAPPER_CONNECTION_ID,
          },
        ],
      ],
      {
        metadata: {
          ...createMetadata(),
          finalization: { gateThreshold: 'warning' },
        },
      }
    );
    await putSessionMessageState(harness.storage, {
      ...acceptedMessage(),
      callbackRequired: true,
      callbackTarget: { url: 'https://example.com/stale-generation-release' },
    });
    await harness.settlementOutbox.terminalizeSessionMessageOnce(MESSAGE_ID, {
      kind: 'completed',
      completionSource: 'assistant_message_event',
    });

    await harness.supervisor.runMaintenance(11_001);

    expect(harness.callbackJobs).toHaveLength(1);
    expect(harness.callbackJobs[0].payload).toMatchObject({
      messageId: MESSAGE_ID,
      status: 'completed',
    });
    await expect(harness.storage.get('disconnect_grace')).resolves.toBeUndefined();
  });

  it('does not release a newer wrapper run gate callback for stale disconnect grace', async () => {
    const oldWrapperRunId = 'wr_stale_grace';
    const newerWrapperRunId = 'wr_newer_gate_wait';
    const harness = createHarness(
      [
        liveRuntimeState({
          wrapperRunId: newerWrapperRunId,
          wrapperGeneration: 5,
          wrapperConnectionId: 'conn_new_generation',
        }),
        [
          'disconnect_grace',
          {
            wrapperRunId: oldWrapperRunId,
            disconnectedAt: 1_000,
            wsCloseCode: 1006,
            wsCloseReason: 'old socket closed before wrapper terminal',
            wrapperGeneration: 4,
            wrapperConnectionId: WRAPPER_CONNECTION_ID,
          },
        ],
      ],
      {
        metadata: {
          ...createMetadata(),
          finalization: { gateThreshold: 'warning' },
        },
      }
    );
    await putSessionMessageState(harness.storage, {
      ...acceptedMessage(NEWER_MESSAGE_ID),
      wrapperRunId: newerWrapperRunId,
      callbackRequired: true,
      callbackTarget: { url: 'https://example.com/newer-gate-wait' },
    });
    await harness.settlementOutbox.terminalizeSessionMessageOnce(NEWER_MESSAGE_ID, {
      kind: 'completed',
      completionSource: 'assistant_message_event',
    });

    await harness.supervisor.runMaintenance(11_001);

    expect(harness.callbackJobs).toHaveLength(0);
    await expect(harness.settlementOutbox.isWaitingForWrapperTerminalGateResult()).resolves.toBe(
      true
    );
    await expect(harness.storage.get('disconnect_grace')).resolves.toBeUndefined();
  });

  it('fails accepted current work without redispatch after its fenced wrapper disconnects and no authoritative query remains', async () => {
    const harness = createHarness([liveRuntimeState()]);
    await putSessionMessageState(harness.storage, acceptedMessage());
    await putSessionMessageState(harness.storage, {
      ...acceptedMessage(NEWER_MESSAGE_ID),
      wrapperRunId: 'wr_other_run',
    });
    await harness.supervisor.onDisconnected({
      disconnected: {
        wrapperRunId: WRAPPER_RUN_ID,
        wrapperGeneration: 4,
        wrapperConnectionId: WRAPPER_CONNECTION_ID,
      },
      wsCloseCode: 1006,
      wsCloseReason: 'socket closed',
    });

    const grace = await harness.storage.get<{ disconnectedAt: number }>('disconnect_grace');
    if (!grace) throw new Error('Expected disconnect grace to be persisted');
    await harness.supervisor.runMaintenance(grace.disconnectedAt + 10_001);

    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'wrapper_disconnected',
      completionSource: 'wrapper_failure',
    });
    await expect(getSessionMessageState(harness.storage, NEWER_MESSAGE_ID)).resolves.toMatchObject({
      status: 'accepted',
      wrapperRunId: 'wr_other_run',
    });
    await expect(getWrapperRuntimeState(harness.storage)).resolves.toMatchObject({
      wrapperGeneration: 5,
    });
    expect(harness.requestPendingDrainIfNeeded).not.toHaveBeenCalled();
    expect(harness.events.map(event => event.streamEventType)).toEqual(['cloud.message.failed']);
    expect(harness.stops).toEqual(['unhealthy-wrapper']);
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

  it('ignores a terminal event attributed to a non-current wrapper run', async () => {
    const newerRunId = 'wr_newer_current';
    const harness = createHarness([liveRuntimeState({ wrapperRunId: newerRunId })]);
    await putSessionMessageState(harness.storage, {
      ...acceptedMessage(),
      wrapperRunId: newerRunId,
    });

    await harness.supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'interrupted',
      error: 'stale interrupted event',
    });

    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'accepted',
      wrapperRunId: newerRunId,
    });
    expect(harness.requestPendingDrainIfNeeded).not.toHaveBeenCalled();
    expect(harness.events).toHaveLength(0);
  });

  it.each([
    { status: 'failed' as const, expected: 'failed' as const },
    { status: 'interrupted' as const, expected: 'interrupted' as const },
  ])(
    'settles only matching-run messages on current $status terminal events',
    async ({ status, expected }) => {
      const otherRunId = 'wr_other_run';
      const otherMessageId = NEWER_MESSAGE_ID;
      const harness = createHarness([liveRuntimeState()]);
      await putSessionMessageState(harness.storage, acceptedMessage());
      await putSessionMessageState(harness.storage, {
        ...acceptedMessage(otherMessageId),
        wrapperRunId: otherRunId,
      });

      await harness.supervisor.onTerminalEvent({
        wrapperRunId: WRAPPER_RUN_ID,
        status,
        error: 'terminal event',
      });

      await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
        status: expected,
      });
      await expect(getSessionMessageState(harness.storage, otherMessageId)).resolves.toMatchObject({
        status: 'accepted',
        wrapperRunId: otherRunId,
      });
      expect(harness.requestPendingDrainIfNeeded).toHaveBeenCalledOnce();
    }
  );

  it('fails accepted current work on liveness expiry without redispatch when no wrapper-local Kilo query remains', async () => {
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
    expect(harness.requestPendingDrainIfNeeded).not.toHaveBeenCalled();
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

  it('does not clear idle reconciliation fields after wrapper identity changes', async () => {
    let replacedRuntimeState = false;
    const storageForHook: { current?: MemoryStorage } = {};
    const harness = createHarness(
      [
        liveRuntimeState({
          lastWrapperIdleAt: 1_000,
          idleReconcileAfter: 9_000,
          wrapperIdleDeadlineAt: 50_000,
        }),
      ],
      {
        storageHooks: {
          beforeList: async prefix => {
            if (replacedRuntimeState || !prefix.startsWith('session_message:')) return;
            replacedRuntimeState = true;
            await storageForHook.current?.put('wrapper_runtime_state', {
              wrapperGeneration: 5,
              wrapperConnectionId: 'conn_replacement',
              wrapperRunId: WRAPPER_RUN_ID,
              lastWrapperIdleAt: 2_000,
              idleReconcileAfter: 12_000,
              wrapperIdleDeadlineAt: 60_000,
            });
          },
        },
      }
    );
    storageForHook.current = harness.storage;

    await harness.supervisor.runMaintenance(10_000);

    await expect(getWrapperRuntimeState(harness.storage)).resolves.toMatchObject({
      wrapperGeneration: 5,
      wrapperConnectionId: 'conn_replacement',
      lastWrapperIdleAt: 2_000,
      idleReconcileAfter: 12_000,
      wrapperIdleDeadlineAt: 60_000,
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

  it('releases a gate-waiting callback when keep-warm cleanup abandons wrapper terminal state', async () => {
    const harness = createHarness([liveRuntimeState({ wrapperIdleDeadlineAt: 9_000 })], {
      metadata: {
        ...createMetadata(),
        finalization: { gateThreshold: 'warning' },
      },
    });
    await putSessionMessageState(harness.storage, {
      ...acceptedMessage(),
      callbackRequired: true,
      callbackTarget: { url: 'https://example.com/keep-warm-release' },
    });
    await harness.settlementOutbox.terminalizeSessionMessageOnce(MESSAGE_ID, {
      kind: 'completed',
      completionSource: 'assistant_message_event',
    });

    await harness.supervisor.runMaintenance(10_000);

    expect(harness.stops).toEqual(['keep-warm-expired']);
    expect(harness.callbackJobs).toHaveLength(1);
    expect(harness.callbackJobs[0].payload).toMatchObject({
      messageId: MESSAGE_ID,
      status: 'completed',
    });
    expect(harness.callbackJobs[0].payload.gateResult).toBeUndefined();
  });
});
