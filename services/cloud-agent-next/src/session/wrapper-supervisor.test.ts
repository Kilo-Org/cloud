import { describe, expect, it, vi } from 'vitest';
import type { CallbackJob } from '../callbacks/types.js';
import { WRAPPER_NO_OUTPUT_TIMEOUT_MS } from './agent-runtime.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import {
  createMessageSettlementOutbox,
  type MessageSettlementOutboxStorage,
} from './message-settlement-outbox.js';
import { storePendingSessionMessage } from './pending-messages.js';
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
import { getWrapperLease, getWrapperRuntimeState } from './wrapper-runtime-state.js';
import type { LatestAssistantMessage } from './types.js';

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
const OWNED_WRAPPER_LEASE: [string, unknown] = [
  'wrapper_lease',
  {
    state: 'owns_wrapper',
    nextInstanceGeneration: 2,
    instance: { instanceId: 'instance_supervisor', instanceGeneration: 1 },
  },
];

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
    storage?: MemoryStorage;
    storageHooks?: { beforeList?: (prefix: string) => Promise<void> };
    getAssistantMessageForUserMessage?: (
      sessionId: string,
      kiloSessionId: string,
      parentMessageId: string
    ) => LatestAssistantMessage | null;
    ensureAcceptedMessageBeforeTerminal?: (
      messageId: string,
      wrapperRunId: string
    ) => Promise<void>;
  }
) {
  const getAssistantMessageForUserMessage =
    options?.getAssistantMessageForUserMessage ?? (() => null);
  const storage = options?.storage ?? createMemoryStorage(initialEntries, options?.storageHooks);
  const events: MessageEvent[] = [];
  const callbackJobs: CallbackJob[] = [];
  const sentPings: string[] = [];
  const stops: string[] = [];
  const stopWrappers = vi.fn().mockResolvedValue({ status: 'absent' });
  const requestedAlarms: number[] = [];
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
    },
    messageSettlementOutbox: settlementOutbox,
    sessionMessageQueue: { requestPendingDrainIfNeeded },
    getMetadata: async () => currentMetadata,
    getAssistantMessageForUserMessage,
    hasActiveIngestConnection: async () => false,
    clearInterruptRequest: async () => {},
    ensureAcceptedMessageBeforeTerminal:
      options?.ensureAcceptedMessageBeforeTerminal ?? (async () => {}),
    stopWrappers,
    requestAlarmAtOrBefore: async deadline => {
      requestedAlarms.push(deadline);
    },
    getSessionIdForLogs: () => currentMetadata.identity.sessionId,
  });

  return {
    storage,
    events,
    callbackJobs,
    sentPings,
    stops,
    stopWrappers,
    requestedAlarms,
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

  it('starts disconnect grace for a finalizing current run without accepted messages', async () => {
    const harness = createHarness([
      liveRuntimeState({ finalizingWrapperRunId: WRAPPER_RUN_ID }),
      OWNED_WRAPPER_LEASE,
    ]);

    await harness.supervisor.onDisconnected({
      disconnected: {
        wrapperRunId: WRAPPER_RUN_ID,
        wrapperGeneration: 4,
        wrapperConnectionId: WRAPPER_CONNECTION_ID,
      },
      wsCloseCode: 1006,
      wsCloseReason: 'socket closed while finalizing',
    });

    const grace = await harness.storage.get<{ disconnectedAt: number }>('disconnect_grace');
    expect(grace).toBeDefined();
    if (!grace) throw new Error('Expected finalizing disconnect grace');

    await harness.supervisor.runMaintenance(grace.disconnectedAt + 10_001);

    await expect(getWrapperLease(harness.storage)).resolves.toMatchObject({
      state: 'stop_needed',
      reason: 'unhealthy-wrapper',
    });
    await expect(getWrapperRuntimeState(harness.storage)).resolves.toEqual({
      wrapperGeneration: 5,
    });
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

  it('releases a finalizing run callback after disconnect grace despite a queued follow-up', async () => {
    const harness = createHarness([liveRuntimeState({ finalizingWrapperRunId: WRAPPER_RUN_ID })], {
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
    await storePendingSessionMessage(harness.storage, {
      messageId: NEWER_MESSAGE_ID,
      content: 'queued follow-up',
      createdAt: 4_000,
      intent: {
        turn: { type: 'prompt', messageId: NEWER_MESSAGE_ID, prompt: 'queued follow-up' },
        agent: { mode: 'code', model: 'test-model' },
      },
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
      failureStage: 'post_dispatch_no_activity',
      failureCode: 'wrapper_disconnected',
    });
    await expect(getSessionMessageState(harness.storage, NEWER_MESSAGE_ID)).resolves.toMatchObject({
      status: 'accepted',
      wrapperRunId: 'wr_other_run',
    });
    await expect(getWrapperRuntimeState(harness.storage)).resolves.toMatchObject({
      wrapperGeneration: 5,
    });
    await expect(getWrapperLease(harness.storage)).resolves.toMatchObject({
      state: 'stop_needed',
      reason: 'unhealthy-wrapper',
    });
    expect(harness.requestPendingDrainIfNeeded).not.toHaveBeenCalled();
    expect(harness.events.map(event => event.streamEventType)).toEqual(['cloud.message.failed']);
    expect(harness.stops).toEqual([]);
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
    { status: 'failed' as const, expected: 'failed' as const, reason: 'terminal-failed' as const },
    {
      status: 'interrupted' as const,
      expected: 'interrupted' as const,
      reason: 'terminal-interrupted' as const,
    },
  ])(
    'settles matching-run messages and durably requests physical stop on current $status terminal events',
    async ({ status, expected, reason }) => {
      const otherRunId = 'wr_other_run';
      const otherMessageId = NEWER_MESSAGE_ID;
      const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE]);
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
      await expect(getWrapperLease(harness.storage)).resolves.toMatchObject({
        state: 'stop_needed',
        reason,
        target: {
          kind: 'instance',
          instance: { instanceId: 'instance_supervisor', instanceGeneration: 1 },
        },
      });
      expect(harness.stops).toEqual([]);
      expect(harness.requestPendingDrainIfNeeded).not.toHaveBeenCalled();
    }
  );

  it.each([
    'Payment Required',
    'usage_limit_exceeded',
    'Too Many Requests',
    'Model not found: kilo/anthropic/claude-haiku-4.5',
  ])('classifies an explicit assistant request failure as assistant_error: %s', async error => {
    const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE]);
    await putSessionMessageState(harness.storage, acceptedMessage());

    await harness.supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'failed',
      error,
      errorSource: 'assistant',
    });

    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'assistant_error',
      error,
      completionSource: 'wrapper_failure',
      failureStage: 'agent_activity',
      failureCode: 'assistant_error',
      safeFailureMessage:
        error === 'Payment Required' || error === 'usage_limit_exceeded'
          ? 'Assistant request failed: insufficient credits'
          : error === 'Too Many Requests'
            ? 'Assistant request was rate limited'
            : 'Assistant request failed: model not found',
    });
  });

  it('does not persist model diagnostics for non-model-not-found assistant failures', async () => {
    const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE]);
    await putSessionMessageState(harness.storage, acceptedMessage());

    await harness.supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'failed',
      error: 'Rate limit exceeded for provider request',
      errorSource: 'assistant',
      modelNotFoundRuntimeDiagnostics: {
        requestedModel: 'kilo/retired-model',
        availableModelCount: 2,
        availableModels: ['vendor/alpha-model', 'vendor/beta-model'],
        suggestedModels: ['vendor/alpha-model'],
        suggestionSource: 'fuzzy',
      },
    });

    const message = await getSessionMessageState(harness.storage, MESSAGE_ID);
    expect(message).toMatchObject({
      status: 'failed',
      failureReason: 'assistant_error',
      safeFailureMessage: 'Assistant request was rate limited',
    });
    expect(message?.modelNotFoundRuntimeDiagnostics).toBeUndefined();
  });

  it.each([
    {
      label: 'before activity',
      message: acceptedMessage(),
      failureStage: 'post_dispatch_no_activity' as const,
      failureCode: 'wrapper_error_before_activity' as const,
    },
    {
      label: 'after activity',
      message: { ...acceptedMessage(), agentActivityObservedAt: 2_500 },
      failureStage: 'agent_activity' as const,
      failureCode: 'wrapper_error_after_activity' as const,
    },
  ])(
    'keeps a genuine wrapper terminal failure classified as wrapper error $label',
    async testCase => {
      const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE]);
      await putSessionMessageState(harness.storage, testCase.message);

      await harness.supervisor.onTerminalEvent({
        wrapperRunId: WRAPPER_RUN_ID,
        status: 'failed',
        error: 'Wrapper process exited unexpectedly',
      });

      await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
        status: 'failed',
        failureReason: 'wrapper_error',
        failureStage: testCase.failureStage,
        failureCode: testCase.failureCode,
      });
    }
  );

  it.each(['SIGTERM', 'SIGINT'])(
    'classifies container shutdown %s separately from other system interruptions',
    async signal => {
      const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE]);
      await putSessionMessageState(harness.storage, acceptedMessage());

      await harness.supervisor.onTerminalEvent({
        wrapperRunId: WRAPPER_RUN_ID,
        status: 'interrupted',
        error: `Container shutdown: ${signal}`,
      });

      await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
        status: 'interrupted',
        error: `Container shutdown: ${signal}`,
        completionSource: 'interrupt',
        failureStage: 'interruption',
        failureCode: 'container_shutdown',
      });
    }
  );

  it('classifies structured container shutdown without parsing the error text', async () => {
    const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE]);
    await putSessionMessageState(harness.storage, acceptedMessage());

    await harness.supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'interrupted',
      error: 'Wrapper received a termination signal',
      interruptionSource: 'container_shutdown',
    });

    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'interrupted',
      error: 'Wrapper received a termination signal',
      failureStage: 'interruption',
      failureCode: 'container_shutdown',
    });
  });

  it.each(['aborted via API', 'Session stopped'])(
    'keeps unrelated wrapper interruption as system_interrupt: %s',
    async error => {
      const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE]);
      await putSessionMessageState(harness.storage, acceptedMessage());

      await harness.supervisor.onTerminalEvent({
        wrapperRunId: WRAPPER_RUN_ID,
        status: 'interrupted',
        error,
      });

      await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
        status: 'interrupted',
        error,
        failureStage: 'interruption',
        failureCode: 'system_interrupt',
      });
    }
  );

  it.each([
    { status: 'failed' as const, expected: 'failed' as const },
    { status: 'interrupted' as const, expected: 'interrupted' as const },
  ])(
    'repairs dispatching work before retiring a current $status terminal event',
    async ({ status, expected }) => {
      const storage = createMemoryStorage([
        liveRuntimeState({ dispatchingMessageId: MESSAGE_ID }),
        OWNED_WRAPPER_LEASE,
      ]);
      const ensureAccepted = vi.fn(async (messageId: string, wrapperRunId: string) => {
        await putSessionMessageState(storage, {
          ...acceptedMessage(messageId),
          wrapperRunId,
          dispatchAcceptanceKind: 'inferred_from_terminal',
        });
      });
      const harness = createHarness(undefined, {
        storage,
        ensureAcceptedMessageBeforeTerminal: ensureAccepted,
      });

      await harness.supervisor.onTerminalEvent({
        wrapperRunId: WRAPPER_RUN_ID,
        status,
        error: 'terminal event',
      });

      expect(ensureAccepted).toHaveBeenCalledWith(MESSAGE_ID, WRAPPER_RUN_ID);
      await expect(getSessionMessageState(storage, MESSAGE_ID)).resolves.toMatchObject({
        status: expected,
      });
    }
  );

  it.each([
    { failureCode: 'payment_required' as const, error: 'Insufficient credits' },
    { failureCode: 'model_missing' as const, error: 'Model not found' },
  ])('preserves $failureCode after agent activity', async failure => {
    const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE]);
    await putSessionMessageState(harness.storage, {
      ...acceptedMessage(),
      agentActivityObservedAt: 9_000,
    });

    await harness.supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'failed',
      errorSource: 'assistant',
      ...failure,
    });

    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'failed',
      failureStage: 'agent_activity',
      failureCode: failure.failureCode,
    });
  });

  it('persists physical stop obligation before reading messages for a failed terminal event', async () => {
    const storageRef: { current?: MemoryStorage } = {};
    let observedStopBeforeEffects = false;
    const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE], {
      storageHooks: {
        beforeList: async prefix => {
          if (
            observedStopBeforeEffects ||
            !prefix.startsWith('session_message:') ||
            !storageRef.current
          ) {
            return;
          }
          observedStopBeforeEffects = true;
          await expect(getWrapperLease(storageRef.current)).resolves.toMatchObject({
            state: 'stop_needed',
            reason: 'terminal-failed',
          });
        },
      },
    });
    storageRef.current = harness.storage;
    await putSessionMessageState(harness.storage, acceptedMessage());

    await harness.supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'failed',
      error: 'terminal event',
    });

    expect(observedStopBeforeEffects).toBe(true);
  });

  it('lets stable-idle assistant failure settle before no-output maintenance can overwrite it', async () => {
    const acceptedAt = 2_000;
    const providerErrorAt = acceptedAt + 300_800;
    const stableIdleAt = providerErrorAt + 3_000;
    const noOutputDeadlineAt = acceptedAt + WRAPPER_NO_OUTPUT_TIMEOUT_MS;
    const harness = createHarness([
      liveRuntimeState({ noOutputDeadlineAt, nextPingAt: noOutputDeadlineAt + 1 }),
      OWNED_WRAPPER_LEASE,
    ]);
    await putSessionMessageState(harness.storage, acceptedMessage());

    await harness.supervisor.runMaintenance(providerErrorAt);
    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'accepted',
    });

    await harness.supervisor.runMaintenance(stableIdleAt - 1);
    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'accepted',
    });

    await harness.supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'failed',
      error: 'Provider request timed out',
      errorSource: 'assistant',
    });
    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'assistant_error',
      error: 'Provider request timed out',
      failureCode: 'assistant_error',
    });

    await harness.supervisor.runMaintenance(noOutputDeadlineAt);
    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'assistant_error',
      error: 'Provider request timed out',
      failureCode: 'assistant_error',
    });
  });

  it('fails genuinely silent accepted work at the no-output deadline', async () => {
    const acceptedAt = 2_000;
    const noOutputDeadlineAt = acceptedAt + WRAPPER_NO_OUTPUT_TIMEOUT_MS;
    const harness = createHarness([
      liveRuntimeState({ noOutputDeadlineAt, nextPingAt: noOutputDeadlineAt + 1 }),
      OWNED_WRAPPER_LEASE,
    ]);
    await putSessionMessageState(harness.storage, acceptedMessage());

    await harness.supervisor.runMaintenance(noOutputDeadlineAt - 1);
    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'accepted',
    });

    await harness.supervisor.runMaintenance(noOutputDeadlineAt);

    const state = await getSessionMessageState(harness.storage, MESSAGE_ID);
    const runtimeState = await getWrapperRuntimeState(harness.storage);
    expect(state).toMatchObject({
      status: 'failed',
      failureReason: 'wrapper_failure',
      error: 'Wrapper accepted the message but produced no output',
      completionSource: 'wrapper_failure',
      failureStage: 'post_dispatch_no_activity',
      failureCode: 'wrapper_no_output',
    });
    expect(runtimeState.wrapperConnectionId).toBeUndefined();
    await expect(getWrapperLease(harness.storage)).resolves.toMatchObject({
      state: 'stop_needed',
      reason: 'unhealthy-wrapper',
    });
    expect(harness.requestPendingDrainIfNeeded).not.toHaveBeenCalled();
    expect(harness.stops).toEqual([]);
    expect(harness.events.map(event => event.streamEventType)).toEqual(['cloud.message.failed']);
  });

  it('terminates an unresponsive wrapper on ping timeout before no-output expires', async () => {
    const pingDeadlineAt = 92_000;
    const noOutputDeadlineAt = 332_000;
    const harness = createHarness([
      liveRuntimeState({ pingDeadlineAt, noOutputDeadlineAt }),
      OWNED_WRAPPER_LEASE,
    ]);
    await putSessionMessageState(harness.storage, acceptedMessage());

    await harness.supervisor.runMaintenance(pingDeadlineAt);

    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'failed',
      error: 'Wrapper did not respond to liveness ping',
      failureCode: 'wrapper_ping_timeout',
    });
  });

  it('releases a finalizing callback on liveness expiry but holds a queued follow-up until physical absence', async () => {
    const harness = createHarness(
      [
        liveRuntimeState({
          finalizingWrapperRunId: WRAPPER_RUN_ID,
          noOutputDeadlineAt: 9_000,
          nextPingAt: 30_000,
        }),
        OWNED_WRAPPER_LEASE,
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
      status: 'completed',
      terminalAt: 3_000,
      completionSource: 'assistant_message_event',
      callbackRequired: true,
      callbackTarget: { url: 'https://example.com/finalizing-liveness-release' },
    });
    await harness.settlementOutbox.terminalizeSessionMessageOnce(MESSAGE_ID, {
      kind: 'completed',
      completionSource: 'assistant_message_event',
    });
    await storePendingSessionMessage(harness.storage, {
      messageId: NEWER_MESSAGE_ID,
      content: 'queued follow-up',
      createdAt: 4_000,
      intent: {
        turn: { type: 'prompt', messageId: NEWER_MESSAGE_ID, prompt: 'queued follow-up' },
        agent: { mode: 'code', model: 'test-model' },
      },
    });

    await harness.supervisor.runMaintenance(10_000);

    expect(harness.callbackJobs).toHaveLength(1);
    expect(harness.callbackJobs[0].payload).toMatchObject({
      messageId: MESSAGE_ID,
      status: 'completed',
    });
    expect(harness.callbackJobs[0].payload.gateResult).toBeUndefined();
    const cleanupHold = await getWrapperLease(harness.storage);
    expect(cleanupHold).toMatchObject({
      state: 'stop_needed',
      reason: 'unhealthy-wrapper',
    });
    if (cleanupHold.state !== 'stop_needed') throw new Error('Expected physical cleanup hold');
    expect(harness.requestPendingDrainIfNeeded).not.toHaveBeenCalled();

    await harness.supervisor.runMaintenance(cleanupHold.nextAttemptAt);

    expect(harness.stopWrappers).toHaveBeenCalledOnce();
    await expect(getWrapperLease(harness.storage)).resolves.toEqual({
      state: 'none',
      nextInstanceGeneration: 2,
    });
    expect(harness.requestPendingDrainIfNeeded).toHaveBeenCalledOnce();
  });

  it('schedules the updated no-output deadline when it is the next liveness deadline', async () => {
    const noOutputDeadlineAt = 332_000;
    const harness = createHarness([
      liveRuntimeState({ noOutputDeadlineAt, nextPingAt: noOutputDeadlineAt + 1 }),
    ]);
    await putSessionMessageState(harness.storage, acceptedMessage());

    await expect(harness.supervisor.nextMaintenanceDeadlines()).resolves.toContain(
      noOutputDeadlineAt
    );
  });

  it('aggregates concurrent physical, liveness, disconnect, and cleanup deadlines', async () => {
    const harness = createHarness([
      liveRuntimeState({
        nextPingAt: 20_000,
        noOutputDeadlineAt: 50_000,
        wrapperIdleDeadlineAt: 40_000,
      }),
      [
        'wrapper_lease',
        {
          state: 'owns_wrapper',
          nextInstanceGeneration: 2,
          instance: { instanceId: 'instance_deadlines', instanceGeneration: 1 },
          startupDeadlineAt: 60_000,
        },
      ],
      [
        'disconnect_grace',
        {
          wrapperRunId: WRAPPER_RUN_ID,
          disconnectedAt: 5_000,
          wsCloseCode: 1006,
          wsCloseReason: 'lost connection',
          wrapperGeneration: 4,
          wrapperConnectionId: WRAPPER_CONNECTION_ID,
        },
      ],
    ]);
    await putSessionMessageState(harness.storage, acceptedMessage());

    const deadlines = await harness.supervisor.nextMaintenanceDeadlines();

    expect(deadlines).toHaveLength(4);
    expect(deadlines).toEqual(expect.arrayContaining([60_000, 20_000, 15_000, 40_000]));
    expect(Math.min(...deadlines)).toBe(15_000);
  });

  it('persists finalizing only for the current wrapper run', async () => {
    const harness = createHarness([liveRuntimeState()]);

    await harness.supervisor.observeFinalizing('wr_stale');
    await expect(getWrapperRuntimeState(harness.storage)).resolves.not.toHaveProperty(
      'finalizingWrapperRunId'
    );

    await harness.supervisor.observeFinalizing(WRAPPER_RUN_ID);
    await expect(getWrapperRuntimeState(harness.storage)).resolves.toMatchObject({
      finalizingWrapperRunId: WRAPPER_RUN_ID,
    });
  });

  it('raw idle maintenance never settles accepted work', async () => {
    const harness = createHarness([liveRuntimeState({ wrapperIdleDeadlineAt: 50_000 })]);
    await putSessionMessageState(harness.storage, acceptedMessage());

    await harness.supervisor.runMaintenance(10_000);

    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'accepted',
    });
  });

  it('settles a still-accepted successful reply when the wrapper completes', async () => {
    // Wrapper complete is the normal turn boundary, independent of assistant
    // message completion markers emitted during the turn.
    const assistantMessageId = 'ase_complete_reconcile';
    const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE], {
      getAssistantMessageForUserMessage: () =>
        ({
          info: { id: assistantMessageId, role: 'assistant' },
          parts: [],
        }) as unknown as LatestAssistantMessage,
    });
    await putSessionMessageState(harness.storage, {
      ...acceptedMessage(),
      callbackRequired: true,
      callbackTarget: { url: 'https://example.com/complete-reconcile' },
    });

    await harness.supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'completed',
      messageIds: [MESSAGE_ID],
    });

    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'completed',
      completionSource: 'idle_reconciliation',
      assistantMessageId,
    });
    expect(harness.callbackJobs).toHaveLength(1);
    expect(harness.callbackJobs[0].payload).toMatchObject({
      messageId: MESSAGE_ID,
      status: 'completed',
    });
    expect(harness.requestPendingDrainIfNeeded).toHaveBeenCalledOnce();
  });

  it('settles current accepted work from a legacy complete without sealed membership', async () => {
    const assistantMessageId = 'ase_legacy_complete';
    const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE], {
      getAssistantMessageForUserMessage: () =>
        ({
          info: { id: assistantMessageId, role: 'assistant' },
          parts: [],
        }) as unknown as LatestAssistantMessage,
    });
    await putSessionMessageState(harness.storage, acceptedMessage());

    await harness.supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'completed',
    });

    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'completed',
      completionSource: 'idle_reconciliation',
      assistantMessageId,
    });
    await expect(getWrapperLease(harness.storage)).resolves.toMatchObject({
      state: 'owns_wrapper',
      keepWarmUntil: expect.any(Number),
    });
  });

  it('rejects missing sealed membership from a current indexed wrapper run', async () => {
    const harness = createHarness([
      liveRuntimeState({ messageIndexVersion: 1 }),
      OWNED_WRAPPER_LEASE,
    ]);
    await putSessionMessageState(harness.storage, acceptedMessage());

    await harness.supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'completed',
    });

    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'wrapper_protocol_error',
    });
    await expect(getWrapperLease(harness.storage)).resolves.toMatchObject({
      state: 'stop_needed',
      reason: 'terminal-failed',
    });
  });

  it('deduplicates accepted dispatching membership from a legacy complete', async () => {
    const harness = createHarness(
      [liveRuntimeState({ dispatchingMessageId: MESSAGE_ID }), OWNED_WRAPPER_LEASE],
      {
        getAssistantMessageForUserMessage: () =>
          ({
            info: { id: 'ase_legacy_accepted_race', role: 'assistant' },
            parts: [],
          }) as unknown as LatestAssistantMessage,
      }
    );
    await putSessionMessageState(harness.storage, acceptedMessage());

    await harness.supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'completed',
    });

    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'completed',
      assistantMessageId: 'ase_legacy_accepted_race',
    });
    await expect(getWrapperLease(harness.storage)).resolves.toMatchObject({
      state: 'owns_wrapper',
      keepWarmUntil: expect.any(Number),
    });
  });

  it('repairs legacy complete-before-acceptance from the dispatching message fence', async () => {
    const storage = createMemoryStorage([
      liveRuntimeState({ dispatchingMessageId: MESSAGE_ID }),
      OWNED_WRAPPER_LEASE,
    ]);
    const ensureAccepted = vi.fn(async (messageId: string, wrapperRunId: string) => {
      await putSessionMessageState(storage, {
        ...acceptedMessage(messageId),
        wrapperRunId,
        dispatchAcceptanceKind: 'inferred_from_terminal',
      });
    });
    const harness = createHarness(undefined, {
      storage,
      getAssistantMessageForUserMessage: () =>
        ({
          info: { id: 'ase_legacy_race_reply', role: 'assistant' },
          parts: [],
        }) as unknown as LatestAssistantMessage,
      ensureAcceptedMessageBeforeTerminal: ensureAccepted,
    });

    await harness.supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'completed',
    });

    expect(ensureAccepted).toHaveBeenCalledWith(MESSAGE_ID, WRAPPER_RUN_ID);
    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'completed',
      assistantMessageId: 'ase_legacy_race_reply',
    });
  });

  it('repairs complete-before-acceptance from durable pending intent', async () => {
    const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE], {
      getAssistantMessageForUserMessage: () =>
        ({
          info: { id: 'ase_race_reply', role: 'assistant' },
          parts: [],
        }) as unknown as LatestAssistantMessage,
    });
    await putSessionMessageState(harness.storage, {
      ...acceptedMessage(),
      status: 'queued',
      acceptedAt: undefined,
      wrapperRunId: undefined,
    });
    const ensureAccepted = vi.fn(async (messageId: string, wrapperRunId: string) => {
      await putSessionMessageState(harness.storage, {
        ...acceptedMessage(messageId),
        wrapperRunId,
        dispatchAcceptanceKind: 'inferred_from_terminal',
      });
    });
    const supervisor = createWrapperSupervisor({
      storage: harness.storage,
      agentRuntime: { sendPing: () => {} },
      messageSettlementOutbox: harness.settlementOutbox,
      sessionMessageQueue: { requestPendingDrainIfNeeded: harness.requestPendingDrainIfNeeded },
      getMetadata: async () => createMetadata(),
      getAssistantMessageForUserMessage: () =>
        ({
          info: { id: 'ase_race_reply', role: 'assistant' },
          parts: [],
        }) as unknown as LatestAssistantMessage,
      hasActiveIngestConnection: async () => false,
      clearInterruptRequest: async () => {},
      ensureAcceptedMessageBeforeTerminal: ensureAccepted,
      requestAlarmAtOrBefore: async () => {},
      getSessionIdForLogs: () => 'agent_supervisor',
    });

    await supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'completed',
      messageIds: [MESSAGE_ID],
    });

    expect(ensureAccepted).toHaveBeenCalledWith(MESSAGE_ID, WRAPPER_RUN_ID);
    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'completed',
      assistantMessageId: 'ase_race_reply',
    });
  });

  it('fails a command-free prompt with no reply when the wrapper completes', async () => {
    const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE]);
    await putSessionMessageState(harness.storage, acceptedMessage());

    await harness.supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'completed',
      messageIds: [MESSAGE_ID],
    });

    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'missing_assistant_reply',
      completionSource: 'idle_reconciliation',
    });
    await expect(getWrapperLease(harness.storage)).resolves.toMatchObject({
      state: 'stop_needed',
      reason: 'terminal-failed',
    });
    await expect(getWrapperRuntimeState(harness.storage)).resolves.toEqual({
      wrapperGeneration: 4,
    });
  });

  it.each([
    {
      label: 'current',
      messageShape: {
        admissionSnapshot: {
          turn: {
            type: 'command' as const,
            messageId: MESSAGE_ID,
            command: 'compact',
            arguments: '',
          },
          agent: { mode: 'code', model: 'test-model' },
        },
      },
    },
    {
      label: 'legacy',
      messageShape: {
        legacyAdmissionConstraints: {
          turn: {
            type: 'command' as const,
            messageId: MESSAGE_ID,
            command: 'compact',
            arguments: '',
          },
        },
      },
    },
  ])(
    'completes a successful $label command without an assistant reply',
    async ({ messageShape }) => {
      const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE]);
      await putSessionMessageState(harness.storage, {
        ...acceptedMessage(),
        ...messageShape,
      });

      await harness.supervisor.onTerminalEvent({
        wrapperRunId: WRAPPER_RUN_ID,
        status: 'completed',
        messageIds: [MESSAGE_ID],
      });

      await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
        status: 'completed',
        completionSource: 'idle_reconciliation',
        assistantMessageId: undefined,
      });
    }
  );

  it('fails a still-accepted errored reply when the wrapper completes', async () => {
    const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE], {
      getAssistantMessageForUserMessage: () =>
        ({
          info: {
            id: 'ase_complete_error',
            role: 'assistant',
            error: { data: { message: 'provider failed during completion' } },
          },
          parts: [],
        }) as unknown as LatestAssistantMessage,
    });
    await putSessionMessageState(harness.storage, acceptedMessage());

    await harness.supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'completed',
      messageIds: [MESSAGE_ID],
    });

    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'assistant_error',
      error: 'provider failed during completion',
      completionSource: 'idle_reconciliation',
    });
    await expect(getWrapperLease(harness.storage)).resolves.toMatchObject({
      state: 'stop_needed',
      reason: 'terminal-failed',
    });
    await expect(getWrapperRuntimeState(harness.storage)).resolves.toEqual({
      wrapperGeneration: 4,
    });
  });

  it('includes the gate result when wrapper completion releases a reconciled callback', async () => {
    const assistantMessageId = 'ase_complete_gate';
    const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE], {
      metadata: {
        ...createMetadata(),
        finalization: { gateThreshold: 'warning' },
      },
      getAssistantMessageForUserMessage: () =>
        ({
          info: { id: assistantMessageId, role: 'assistant' },
          parts: [],
        }) as unknown as LatestAssistantMessage,
    });
    await putSessionMessageState(harness.storage, {
      ...acceptedMessage(),
      callbackRequired: true,
      callbackTarget: { url: 'https://example.com/complete-gate' },
    });

    await harness.supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'completed',
      gateResult: 'pass',
      messageIds: [MESSAGE_ID],
    });

    expect(harness.callbackJobs).toHaveLength(1);
    expect(harness.callbackJobs[0].payload).toMatchObject({
      messageId: MESSAGE_ID,
      status: 'completed',
      gateResult: 'pass',
    });
  });

  it('fails accepted work omitted from sealed complete membership', async () => {
    const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE]);
    await putSessionMessageState(harness.storage, acceptedMessage());

    await harness.supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'completed',
      messageIds: [],
    });

    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'wrapper_protocol_error',
    });
    await expect(getWrapperLease(harness.storage)).resolves.toMatchObject({
      state: 'stop_needed',
      reason: 'terminal-failed',
    });
  });

  it('rejects complete membership that omits an already terminal message fenced to the run', async () => {
    const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE]);
    await putSessionMessageState(harness.storage, acceptedMessage());
    await putSessionMessageState(harness.storage, {
      ...acceptedMessage(NEWER_MESSAGE_ID),
      status: 'completed',
      terminalAt: 3_000,
      completionSource: 'idle_reconciliation',
    });

    await harness.supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'completed',
      messageIds: [MESSAGE_ID],
    });

    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'wrapper_protocol_error',
    });
    await expect(getSessionMessageState(harness.storage, NEWER_MESSAGE_ID)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it.each(['failed', 'interrupted'] as const)(
    'treats an already %s sealed member fenced to the run as batch failure',
    async status => {
      const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE]);
      await putSessionMessageState(harness.storage, {
        ...acceptedMessage(),
        status,
        terminalAt: 3_000,
        completionSource: status === 'failed' ? 'wrapper_failure' : 'interrupt',
      });

      await harness.supervisor.onTerminalEvent({
        wrapperRunId: WRAPPER_RUN_ID,
        status: 'completed',
        messageIds: [MESSAGE_ID],
      });

      await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
        status,
      });
      await expect(getWrapperLease(harness.storage)).resolves.toMatchObject({
        state: 'stop_needed',
        reason: 'terminal-failed',
      });
      await expect(getWrapperRuntimeState(harness.storage)).resolves.toEqual({
        wrapperGeneration: 4,
      });
    }
  );

  it('accepts an already completed sealed member fenced to the run as a no-op', async () => {
    const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE]);
    await putSessionMessageState(harness.storage, {
      ...acceptedMessage(),
      status: 'completed',
      terminalAt: 3_000,
      completionSource: 'idle_reconciliation',
    });

    await harness.supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'completed',
      messageIds: [MESSAGE_ID],
    });

    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'completed',
      terminalAt: 3_000,
    });
    await expect(getWrapperLease(harness.storage)).resolves.toMatchObject({
      state: 'owns_wrapper',
      keepWarmUntil: expect.any(Number),
    });
    await expect(getWrapperRuntimeState(harness.storage)).resolves.toEqual({
      wrapperGeneration: 5,
    });
  });

  it('fails every accepted message before retiring a duplicate complete membership', async () => {
    const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE]);
    await putSessionMessageState(harness.storage, acceptedMessage());
    await putSessionMessageState(harness.storage, acceptedMessage(NEWER_MESSAGE_ID));

    await harness.supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'completed',
      messageIds: [MESSAGE_ID, MESSAGE_ID],
    });

    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'wrapper_protocol_error',
    });
    await expect(getSessionMessageState(harness.storage, NEWER_MESSAGE_ID)).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'wrapper_protocol_error',
    });
    await expect(getWrapperRuntimeState(harness.storage)).resolves.toEqual({
      wrapperGeneration: 4,
    });
  });

  it('fails complete-before-acceptance work before retiring duplicate membership', async () => {
    const storage = createMemoryStorage([
      liveRuntimeState({ dispatchingMessageId: MESSAGE_ID }),
      OWNED_WRAPPER_LEASE,
    ]);
    const ensureAccepted = vi.fn(async (messageId: string, wrapperRunId: string) => {
      await putSessionMessageState(storage, {
        ...acceptedMessage(messageId),
        wrapperRunId,
        dispatchAcceptanceKind: 'inferred_from_terminal',
      });
    });
    const harness = createHarness(undefined, {
      storage,
      ensureAcceptedMessageBeforeTerminal: ensureAccepted,
    });

    await harness.supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'completed',
      messageIds: [MESSAGE_ID, MESSAGE_ID],
    });

    expect(ensureAccepted).toHaveBeenCalledWith(MESSAGE_ID, WRAPPER_RUN_ID);
    await expect(getSessionMessageState(storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'wrapper_protocol_error',
    });
  });

  it('rejects a terminal sealed message fenced to another wrapper run', async () => {
    const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE]);
    await putSessionMessageState(harness.storage, acceptedMessage());
    await putSessionMessageState(harness.storage, {
      ...acceptedMessage(NEWER_MESSAGE_ID),
      status: 'completed',
      terminalAt: 3_000,
      wrapperRunId: 'wr_other_run',
      completionSource: 'idle_reconciliation',
    });

    await harness.supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'completed',
      messageIds: [NEWER_MESSAGE_ID],
    });

    await expect(getSessionMessageState(harness.storage, MESSAGE_ID)).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'wrapper_protocol_error',
    });
    await expect(getSessionMessageState(harness.storage, NEWER_MESSAGE_ID)).resolves.toMatchObject({
      status: 'completed',
      wrapperRunId: 'wr_other_run',
    });
  });

  it('keeps supervising finalizing work after all accepted messages settle', async () => {
    const harness = createHarness([
      liveRuntimeState({
        finalizingWrapperRunId: WRAPPER_RUN_ID,
        nextPingAt: 2_000,
        noOutputDeadlineAt: 50_000,
      }),
    ]);

    await harness.supervisor.runMaintenance(2_001);

    expect(harness.sentPings).toEqual([WRAPPER_RUN_ID]);
    await expect(getWrapperRuntimeState(harness.storage)).resolves.toMatchObject({
      finalizingWrapperRunId: WRAPPER_RUN_ID,
      pingDeadlineAt: 32_001,
    });
  });

  it('keeps finalizing fenced while post-processing output refreshes liveness', async () => {
    const harness = createHarness([
      liveRuntimeState({
        finalizingWrapperRunId: WRAPPER_RUN_ID,
        wrapperIdleDeadlineAt: 50_000,
      }),
    ]);

    await harness.supervisor.observeMeaningfulOutput(4, WRAPPER_CONNECTION_ID, 2_000);

    await expect(getWrapperRuntimeState(harness.storage)).resolves.toMatchObject({
      finalizingWrapperRunId: WRAPPER_RUN_ID,
      wrapperIdleDeadlineAt: 50_000,
      lastWrapperMessageAt: 2_000,
      noOutputDeadlineAt: 332_000,
    });
  });

  it('retains successful idle ownership with a bounded physical warm deadline', async () => {
    const harness = createHarness([liveRuntimeState(), OWNED_WRAPPER_LEASE]);

    await harness.supervisor.onTerminalEvent({
      wrapperRunId: WRAPPER_RUN_ID,
      status: 'completed',
      messageIds: [],
    });

    await expect(getWrapperLease(harness.storage)).resolves.toMatchObject({
      state: 'owns_wrapper',
      keepWarmUntil: expect.any(Number),
    });
    await expect(getWrapperRuntimeState(harness.storage)).resolves.toEqual({
      wrapperGeneration: 5,
    });
  });

  it('requests durable cleanup when a physical keep-warm deadline expires without work', async () => {
    const harness = createHarness([
      liveRuntimeState({ wrapperIdleDeadlineAt: 9_000 }),
      [
        'wrapper_lease',
        {
          ...(OWNED_WRAPPER_LEASE[1] as object),
          keepWarmUntil: 9_000,
        },
      ],
    ]);

    await harness.supervisor.runMaintenance(10_000);

    const runtimeState = await getWrapperRuntimeState(harness.storage);
    expect(runtimeState.wrapperConnectionId).toBeUndefined();
    expect(runtimeState.wrapperGeneration).toBe(5);
    await expect(getWrapperLease(harness.storage)).resolves.toMatchObject({
      state: 'stop_needed',
      reason: 'keep-warm-expired',
    });
    expect(harness.stops).toEqual([]);
  });

  it('skips expired keep-warm cleanup while the current wrapper run is finalizing', async () => {
    const harness = createHarness([
      liveRuntimeState({
        finalizingWrapperRunId: WRAPPER_RUN_ID,
        wrapperIdleDeadlineAt: 9_000,
      }),
      [
        'wrapper_lease',
        {
          ...(OWNED_WRAPPER_LEASE[1] as object),
          keepWarmUntil: 9_000,
        },
      ],
    ]);

    await harness.supervisor.runMaintenance(10_000);

    await expect(getWrapperRuntimeState(harness.storage)).resolves.toMatchObject({
      wrapperConnectionId: WRAPPER_CONNECTION_ID,
      wrapperGeneration: 4,
      finalizingWrapperRunId: WRAPPER_RUN_ID,
    });
    await expect(getWrapperLease(harness.storage)).resolves.toMatchObject({
      state: 'owns_wrapper',
      keepWarmUntil: 9_000,
    });
  });

  it('turns an expired startup allowance into verified cleanup work', async () => {
    const harness = createHarness([
      [
        'wrapper_lease',
        {
          state: 'owns_wrapper',
          nextInstanceGeneration: 2,
          instance: { instanceId: 'instance_starting', instanceGeneration: 1 },
          startupDeadlineAt: 1_000,
        },
      ],
    ]);

    await harness.supervisor.runMaintenance(1_001);

    expect(harness.stopWrappers).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          kind: 'instance',
          instance: { instanceId: 'instance_starting', instanceGeneration: 1 },
        },
        reason: 'startup-failed',
      })
    );
    await expect(getWrapperLease(harness.storage)).resolves.toEqual({
      state: 'none',
      nextInstanceGeneration: 2,
    });
  });

  it('repairs an expired readiness deadline when accepted work already proves delivery', async () => {
    const harness = createHarness([
      liveRuntimeState({ lastWrapperMessageAt: 1_000 }),
      [
        'wrapper_lease',
        {
          state: 'owns_wrapper',
          nextInstanceGeneration: 2,
          instance: { instanceId: 'instance_accepted', instanceGeneration: 1 },
          startupDeadlineAt: 1_000,
        },
      ],
    ]);
    await putSessionMessageState(harness.storage, acceptedMessage());

    await harness.supervisor.runMaintenance(1_001);

    await expect(getWrapperLease(harness.storage)).resolves.toMatchObject({
      state: 'owns_wrapper',
      startupDeadlineAt: undefined,
    });
    expect(harness.stopWrappers).not.toHaveBeenCalled();
  });

  it('claims due cleanup before provider I/O and confirms verified absence', async () => {
    const harness = createHarness([
      [
        'wrapper_lease',
        {
          state: 'stop_needed',
          nextInstanceGeneration: 2,
          target: {
            kind: 'instance',
            instance: { instanceId: 'instance_stop', instanceGeneration: 1 },
          },
          reason: 'startup-failed',
          requestedAt: 1_000,
          nextAttemptAt: 1_000,
          attempts: 0,
        },
      ],
    ]);
    harness.stopWrappers.mockImplementationOnce(async () => {
      await expect(getWrapperLease(harness.storage)).resolves.toMatchObject({
        state: 'stopping',
        attemptId: expect.any(String),
      });
      expect(harness.requestedAlarms).toHaveLength(1);
      return { status: 'absent' };
    });

    await harness.supervisor.runMaintenance(1_001);

    expect(harness.stopWrappers).toHaveBeenCalledOnce();
    await expect(getWrapperLease(harness.storage)).resolves.toEqual({
      state: 'none',
      nextInstanceGeneration: 2,
    });
    expect(harness.requestPendingDrainIfNeeded).toHaveBeenCalledOnce();
  });

  it.each([
    { result: { status: 'still-present', observed: [] }, label: 'still-present' },
    { result: { status: 'inspection-failed', error: 'unavailable' }, label: 'inspection-failed' },
  ])('retries a $label cleanup result with its target preserved', async ({ result }) => {
    const harness = createHarness([
      [
        'wrapper_lease',
        {
          state: 'stop_needed',
          nextInstanceGeneration: 4,
          target: { kind: 'session' },
          reason: 'unexpected-wrapper',
          requestedAt: 1_000,
          nextAttemptAt: 1_000,
          attempts: 0,
        },
      ],
    ]);
    harness.stopWrappers.mockResolvedValueOnce(result);

    await harness.supervisor.runMaintenance(1_001);

    await expect(getWrapperLease(harness.storage)).resolves.toMatchObject({
      state: 'stop_needed',
      target: { kind: 'session' },
      attempts: 1,
      nextAttemptAt: expect.any(Number),
    });
  });

  it('schedules an unconfirmed cleanup retry from the time its result is observed', async () => {
    const harness = createHarness([
      [
        'wrapper_lease',
        {
          state: 'stop_needed',
          nextInstanceGeneration: 2,
          target: { kind: 'session' },
          reason: 'unexpected-wrapper',
          requestedAt: 1_000,
          nextAttemptAt: 1_000,
          attempts: 0,
        },
      ],
    ]);
    const attemptStartedAt = 1_000;
    const failedAt = 20_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(attemptStartedAt);
    harness.stopWrappers.mockImplementationOnce(async () => {
      clock.mockReturnValue(failedAt);
      return { status: 'still-present', observed: [] };
    });

    try {
      await harness.supervisor.runMaintenance(attemptStartedAt);
    } finally {
      clock.mockRestore();
    }

    await expect(getWrapperLease(harness.storage)).resolves.toMatchObject({
      state: 'stop_needed',
      attempts: 1,
      nextAttemptAt: failedAt + 5_000,
    });
  });

  it('backs off unconfirmed physical cleanup retries through the saturated delay tail', async () => {
    const harness = createHarness([
      [
        'wrapper_lease',
        {
          state: 'stop_needed',
          nextInstanceGeneration: 2,
          target: { kind: 'session' },
          reason: 'unexpected-wrapper',
          requestedAt: 1_000,
          nextAttemptAt: 1_000,
          attempts: 0,
        },
      ],
    ]);
    harness.stopWrappers.mockResolvedValue({ status: 'still-present', observed: [] });
    const expectedDelays = [5_000, 30_000, 120_000, 300_000, 300_000];
    let now = 1_001;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);

    try {
      for (const [index, expectedDelay] of expectedDelays.entries()) {
        clock.mockReturnValue(now);
        await harness.supervisor.runMaintenance(now);
        const lease = await getWrapperLease(harness.storage);
        if (lease.state !== 'stop_needed') {
          throw new Error(`Expected a retryable cleanup lease after attempt ${index + 1}`);
        }
        expect(lease.attempts).toBe(index + 1);
        expect(lease.nextAttemptAt - now).toBe(expectedDelay);
        now = lease.nextAttemptAt;
      }
    } finally {
      clock.mockRestore();
    }
  });

  it('retries thrown cleanup and does not issue a parallel stop during a valid watchdog', async () => {
    const harness = createHarness([
      [
        'wrapper_lease',
        {
          state: 'stop_needed',
          nextInstanceGeneration: 2,
          target: { kind: 'session' },
          reason: 'observation-failed',
          requestedAt: 1_000,
          nextAttemptAt: 1_000,
          attempts: 0,
        },
      ],
    ]);
    harness.stopWrappers.mockRejectedValueOnce(new Error('stop failed'));
    await harness.supervisor.runMaintenance(1_001);
    await expect(getWrapperLease(harness.storage)).resolves.toMatchObject({ state: 'stop_needed' });

    await harness.storage.put('wrapper_lease', {
      state: 'stopping',
      nextInstanceGeneration: 2,
      target: { kind: 'session' },
      reason: 'observation-failed',
      requestedAt: 1_000,
      attemptId: 'inflight',
      attemptStartedAt: 2_000,
      attemptDeadlineAt: 30_000,
      attempts: 2,
    });
    await harness.supervisor.runMaintenance(20_000);
    expect(harness.stopWrappers).toHaveBeenCalledOnce();
    expect(await harness.supervisor.nextMaintenanceDeadlines()).toContain(30_000);
  });

  it('expires a stale watchdog into retryable cleanup without settling a late attempt', async () => {
    const harness = createHarness([
      [
        'wrapper_lease',
        {
          state: 'stopping',
          nextInstanceGeneration: 2,
          target: { kind: 'session' },
          reason: 'observation-failed',
          requestedAt: 1_000,
          attemptId: 'expired',
          attemptStartedAt: 1_000,
          attemptDeadlineAt: 2_000,
          attempts: 1,
        },
      ],
    ]);

    await harness.supervisor.runMaintenance(2_001);

    expect(harness.stopWrappers).not.toHaveBeenCalled();
    await expect(getWrapperLease(harness.storage)).resolves.toMatchObject({
      state: 'stop_needed',
      attempts: 1,
    });
  });

  it('releases a gate-waiting callback when keep-warm cleanup abandons wrapper terminal state', async () => {
    const harness = createHarness(
      [
        liveRuntimeState({ wrapperIdleDeadlineAt: 9_000 }),
        [
          'wrapper_lease',
          {
            ...(OWNED_WRAPPER_LEASE[1] as object),
            keepWarmUntil: 9_000,
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
      callbackTarget: { url: 'https://example.com/keep-warm-release' },
    });
    await harness.settlementOutbox.terminalizeSessionMessageOnce(MESSAGE_ID, {
      kind: 'completed',
      completionSource: 'assistant_message_event',
    });

    await harness.supervisor.runMaintenance(10_000);

    await expect(getWrapperLease(harness.storage)).resolves.toMatchObject({
      state: 'stop_needed',
      reason: 'keep-warm-expired',
    });
    expect(harness.stops).toEqual([]);
    expect(harness.callbackJobs).toHaveLength(1);
    expect(harness.callbackJobs[0].payload).toMatchObject({
      messageId: MESSAGE_ID,
      status: 'completed',
    });
    expect(harness.callbackJobs[0].payload.gateResult).toBeUndefined();
  });
});
