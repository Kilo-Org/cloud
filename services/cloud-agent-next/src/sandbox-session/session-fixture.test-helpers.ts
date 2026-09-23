import { expect, vi } from 'vitest';
import { SandboxSession } from './SandboxSession.js';
import {
  parseSessionMetadata,
  serializeSessionMetadata,
  type SessionMetadata,
} from '../persistence/session-metadata.js';
import { createMemoryEventQueries } from '../session/preparation-test-helpers.js';
import { createControlPlaneCredential } from '../sandbox-control/managed-credential.js';
import type { Env } from '../types.js';
import type { UserId } from '../types/ids.js';
import type { CallbackJob } from '../callbacks/types.js';
import type { sandboxControlRpc } from './control-rpc.js';
import type { SandboxControlOutboundRequest } from '../sandbox-control/socket.js';
import {
  sessionPromptPayloadSchema,
  type ControlError,
  type ResponseFrame,
  type SessionAttachPayload,
  type SessionMessageOutcome,
} from '../shared/sandbox-control-protocol.js';
import type { AcceptedPromptTurn, AgentSelection } from '../execution/types.js';
import type { ControlSessionMessageInput } from './session-message-queue.js';
import { readRawSessionMessages } from '../sandbox-state/persist/load.js';

export const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
export const SANDBOX_ID = 'ses-11111111111141118111111111111111';
export const RUNTIME_ID = '22222222-2222-4222-8222-222222222222';
export const NEXT_RUNTIME_ID = '33333333-3333-4333-8333-333333333333';
export const DIRECTORY = '/workspace/session';
export const KILO_CREDENTIAL = createControlPlaneCredential(SANDBOX_ID, 'kilo');
export const ATTACHMENT = {
  directory: DIRECTORY,
  env: { KILOCODE_TOKEN: KILO_CREDENTIAL },
  kilo: {
    scopeId: SESSION_ID,
    token: KILO_CREDENTIAL,
    targets: {
      backendBaseUrl: 'https://backend.example.test',
      providerBaseUrl: 'https://provider.example.test',
      sessionIngestBaseUrl: 'https://ingest.example.test',
    },
  },
} satisfies SessionAttachPayload;

export const defaultAgent: AgentSelection = {
  mode: 'code',
  model: 'kilo/anthropic/claude-sonnet-4',
  variant: 'high',
};

type Control = ReturnType<typeof sandboxControlRpc>;
export type { Control };
export type ControlStatus = Awaited<ReturnType<Control['ensureReady']>>;

export function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function controlResponse(result: unknown): ResponseFrame {
  return { type: 'response', requestId: 'request', ok: true, result };
}

export function receiptedEvent(
  sequence: number,
  payload: Parameters<SandboxSession['receiveSandboxControlEvent']>[0]['payload'],
  wrapperInstanceId = RUNTIME_ID,
  nativeRuntimeId?: string
) {
  const identity = {
    directory: DIRECTORY,
    kiloSessionId: 'kilo_root',
    rootKiloSessionId: 'kilo_root',
    ...(nativeRuntimeId ? { nativeRuntimeId } : {}),
  };
  return {
    identity,
    wrapperInstanceId,
    payload,
    sequence,
    receiptId: crypto.randomUUID(),
  };
}

export function receiptedPreparing(
  sequence: number,
  payload: Parameters<SandboxSession['receiveSandboxControlPreparing']>[0]['payload'],
  wrapperInstanceId = RUNTIME_ID,
  nativeRuntimeId?: string
) {
  const identity = {
    directory: DIRECTORY,
    kiloSessionId: 'kilo_root',
    rootKiloSessionId: 'kilo_root',
    ...(nativeRuntimeId ? { nativeRuntimeId } : {}),
  };
  return {
    identity,
    wrapperInstanceId,
    payload,
    sequence,
    receiptId: crypto.randomUUID(),
  };
}

export function unreceiptedPreparing(...input: Parameters<typeof receiptedPreparing>) {
  const preparing = receiptedPreparing(...input);
  return {
    identity: preparing.identity,
    wrapperInstanceId: preparing.wrapperInstanceId,
    payload: preparing.payload,
  };
}

export function controlFailure(
  retryable: boolean,
  code = 'not_ready',
  admission?: ControlError['admission']
): ResponseFrame {
  return {
    type: 'response',
    requestId: 'request',
    ok: false,
    error: {
      code,
      message: 'Control request failed',
      retryable,
      ...(admission ? { admission } : {}),
    },
  };
}

export type SessionFixtureDeps = {
  eventQueries: ReturnType<typeof vi.fn>;
  signedAttachments: ReturnType<typeof vi.fn>;
};

export function createSessionFixture(
  deps: SessionFixtureDeps,
  overrides: Partial<SessionMetadata> = {},
  sharedControl?: Control,
  callbackQueue?: Pick<Queue<CallbackJob>, 'send'>
) {
  const values = new Map<string, unknown>();
  let alarmAt: number | null = null;
  const errors: unknown[] = [];
  const background: Promise<unknown>[] = [];
  const kv: SyncKvStorage = {
    get: <T>(key: string): T | undefined => structuredClone(values.get(key)) as T | undefined,
    put: <T>(key: string, value: T) => {
      values.set(key, structuredClone(value));
    },
    delete: (key: string) => values.delete(key),
    list: <T>(options?: SyncKvListOptions) =>
      [...values.entries()]
        .filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
        .map(([key, value]) => [key, structuredClone(value) as T] as [string, T]),
  };
  const metadata = parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: { sessionId: SESSION_ID, userId: 'user_1', billingOrigin: 'cloud-agent-web' },
    auth: { kiloSessionId: 'kilo_root', kilocodeToken: 'test-token' },
    agent: defaultAgent,
    workspace: { sandboxId: SANDBOX_ID, workspacePath: DIRECTORY },
    lifecycle: { version: 1, timestamp: Date.now() },
    ...overrides,
  });
  kv.put('session_metadata', serializeSessionMetadata(metadata));
  const eventQueries = createMemoryEventQueries();
  let eventSequence = 0;
  eventQueries.insert = params =>
    eventQueries.upsert({ ...params, entityId: `test-event/${++eventSequence}` });
  eventQueries.insertUnique = params =>
    eventQueries.findByEntityId(params.entityId) ? null : eventQueries.upsert(params);
  eventQueries.getLatestEventId = () =>
    Math.max(0, ...eventQueries.findByEntityPrefix('').map(row => row.id));
  eventQueries.deleteOlderThan = vi.fn();
  deps.eventQueries.mockReturnValue(eventQueries);
  deps.signedAttachments.mockResolvedValue([]);
  const storage = {
    kv,
    get: async <T>(key: string) => kv.get<T>(key),
    put: async <T>(key: string, value: T) => kv.put(key, value),
    sql: {},
    transactionSync: <T>(callback: () => T) => callback(),
    getAlarm: vi.fn(async () => alarmAt),
    setAlarm: vi.fn(async (at: number | Date) => {
      alarmAt = Number(at);
    }),
    deleteAlarm: vi.fn(async () => {
      alarmAt = null;
    }),
  } as unknown as DurableObjectStorage;
  const ctx = {
    id: { name: `user_1:${metadata.identity.sessionId}` },
    storage,
    blockConcurrencyWhile: async (callback: () => Promise<void>) => callback(),
    getWebSockets: () => [],
    waitUntil: (promise: Promise<unknown>) => {
      background.push(promise);
      void promise.catch(error => {
        errors.push(error);
      });
    },
  } as unknown as DurableObjectState;
  let status: ControlStatus = {
    physical: 'running',
    connection: 'ready',
    wrapperInstanceId: RUNTIME_ID,
    allocationIncarnation: 'incarnation_1',
  };
  const request = vi.fn(async (input: SandboxControlOutboundRequest): Promise<ResponseFrame> => {
    if (input.operation === 'session.attach') return controlResponse({ attached: true });
    if (input.operation === 'session.prompt') {
      const prompt = sessionPromptPayloadSchema.parse(input.payload);
      return controlResponse({ messageId: prompt.messageId, status: 'accepted' });
    }
    if (input.operation === 'session.sync')
      return controlResponse({ status: { type: 'busy' }, questions: [], permissions: [] });
    if (input.operation === 'session.abort') return controlResponse({ status: 'aborted' });
    return controlResponse({ success: true });
  });
  const control = {
    getStatus: vi.fn(async (): Promise<ControlStatus> => ({ ...status })),
    getRuntimeCredentialProxyFence: vi.fn(async () => ({
      plane: 'control' as const,
      allocationId: 'allocation_1',
      providerInstanceId: 'provider_1',
      connectionId: 'connection_1',
      wrapperInstanceId: RUNTIME_ID,
    })),
    ensureReady: vi.fn(
      async (_input: Parameters<Control['ensureReady']>[0]): Promise<ControlStatus> => ({
        ...status,
        attachment: { ...ATTACHMENT, setupCommands: metadata.profile?.setupCommands },
      })
    ),
    attachSession: vi.fn(async () => ({})),
    bindRuntimeCredentialProxyHandle: vi.fn(async () => ({ bound: true as const })),
    detachSession: vi.fn(async () => ({ existed: true })),
    forgetSessionReference: vi.fn(async () => undefined),
    validateTerminalAccess: vi.fn(async () => ({ allowed: true })),
    recordTerminalActivity: vi.fn(async () => ({ allowed: true })),
    prepareSessionCredentials: vi.fn(async () => ({})),
    updateNetworkPolicy: vi.fn(async () => undefined),
    request,
  } satisfies Control;
  const containers = {
    clearSessionSnapshot: vi.fn(async (): Promise<void> => {}),
  };
  const env = {
    SANDBOX_CONTROL: { getByName: () => sharedControl ?? control },
    SANDBOX_CONTAINERS: { getByName: () => containers },
    WORKER_URL: 'https://worker.example.test',
    NEXTAUTH_SECRET: 'test-secret',
    CALLBACK_QUEUE: callbackQueue,
    CLOUD_AGENT_REPORT_QUEUE: { send: async () => undefined },
    CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'true',
    CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS: 'org_1',
    CLOUD_AGENT_CONTAINER_BILLING_USER_IDS: 'user_1',
  } as unknown as Env;
  let session = new SandboxSession(ctx, env);
  return {
    get session() {
      return session;
    },
    control,
    containers,
    env,
    settleBackground: () => Promise.all(background),
    metadata,
    storage,
    values,
    eventQueries,
    setStatus: (next: ControlStatus) => {
      status = next;
    },
    alarmAt: () => alarmAt,
    reload: () => {
      const now = Date.now();
      vi.clearAllTimers();
      vi.setSystemTime(now);
      deps.eventQueries.mockReturnValue(eventQueries);
      session = new SandboxSession(ctx, env);
    },
    fireAlarm: () => {
      alarmAt = null;
      return session.alarm();
    },
    record: (messageId: string) =>
      readRawSessionMessages(kv).find(message => message.messageId === messageId),
    acquisition: (messageId: string) => {
      const record = readRawSessionMessages(kv).find(message => message.messageId === messageId);
      const state = record?.state.kind === 'queued' ? record.state : undefined;
      if (!state?.preparationAttemptId || state.deadlineAt === null) {
        throw new Error('Missing durable acquisition request');
      }
      return { id: state.preparationAttemptId, deadlineAt: state.deadlineAt };
    },
    terminalEvents: () => eventQueries.findByEntityPrefix('terminal-message/'),
    flush: async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(errors).toEqual([]);
    },
    admit: (
      messageId: string,
      input: {
        prompt?: string;
        attachments?: AcceptedPromptTurn['attachments'];
        finalization?: ControlSessionMessageInput['finalization'];
      } = {}
    ) =>
      session.admitSubmittedMessage({
        userId: 'user_1' as UserId,
        turn: {
          type: 'prompt',
          id: messageId,
          prompt: input.prompt ?? `prompt ${messageId}`,
          attachments: input.attachments,
        },
        finalization: input.finalization,
      }),
    outcome: (
      messageId: string,
      outcome: SessionMessageOutcome['status'],
      wrapperInstanceId = RUNTIME_ID
    ) =>
      session.receiveSandboxControlEvent({
        identity: {
          directory: metadata.workspace?.workspacePath ?? DIRECTORY,
          kiloSessionId: metadata.auth.kiloSessionId,
          rootKiloSessionId: metadata.auth.kiloSessionId,
        },
        wrapperInstanceId,
        payload: { type: 'session.message.outcome', properties: { messageId, status: outcome } },
      }),
    rawEvent: (type: string, properties: Record<string, unknown>, kiloSessionId = 'kilo_root') =>
      session.receiveSandboxControlEvent({
        identity: { directory: DIRECTORY, kiloSessionId, rootKiloSessionId: 'kilo_root' },
        wrapperInstanceId: RUNTIME_ID,
        payload: { type, properties },
      }),
    snapshot: async () => (await session.fetch(new Request('http://unit.test/stream'))).json(),
  };
}

export function delegateRequest(
  fixture: ReturnType<typeof createSessionFixture>,
  operation: SandboxControlOutboundRequest['operation'],
  replacement: (input: SandboxControlOutboundRequest) => Promise<ResponseFrame>
) {
  const original = fixture.control.request.getMockImplementation();
  if (!original) throw new Error('Missing control fixture');
  fixture.control.request.mockImplementation(input =>
    input.operation === operation ? replacement(input) : original(input)
  );
}
