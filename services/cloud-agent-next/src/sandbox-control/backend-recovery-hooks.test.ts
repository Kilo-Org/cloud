import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxControl } from '../persistence/SandboxControl.js';
import type { Env } from '../types.js';
import type { ControlSessionState, ControlStopRequest } from '../shared/control-plane-session.js';
import {
  sameSessionOperation,
  sandboxReconcilePayloadSchema,
  sessionOperationAuthorizationSchema,
  sessionOperationLookupResultSchema,
  sessionOperationResultHash,
  type ResponseFrame,
  type SessionOperationAck,
  type SessionOperationAuthorization,
  type SessionOperationDelivery,
} from '../shared/sandbox-control-protocol.js';
import { encodeCloudflareProviderRef } from './cloudflare-provider.js';
import type * as CloudflareProvider from './cloudflare-provider.js';
import {
  loadDeadlines,
  loadNativeRuntimeRetirements,
  loadRecoveryDecisions,
  loadRouteTable,
  savePhysicalRecord,
  saveRecoveryDecisions,
  saveRouteTable,
} from './durable-state.js';
import { beginStop, type PhysicalRecord } from './physical-lifecycle.js';
import type { SessionRoute } from './session-routes.js';
import type { ProviderAdapter } from './provider.js';
import type * as SocketModule from './socket.js';
import type {
  SandboxControlConnectionIdentity,
  SandboxControlOutboundRequest,
  SandboxControlSocketHandler,
  SandboxControlSocketHooks,
} from './socket.js';

const mocks = vi.hoisted(() => ({ socket: vi.fn(), session: vi.fn(), provider: vi.fn() }));
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: DurableObjectState,
      public env: Env
    ) {}
  },
}));
vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(() => {
    throw new Error('Unexpected provider access');
  }),
}));
vi.mock('./cloudflare-provider.js', async importOriginal => ({
  ...(await importOriginal<typeof CloudflareProvider>()),
  createCloudflareProviderAdapter: mocks.provider,
}));
vi.mock('./socket.js', async importOriginal => ({
  ...(await importOriginal<typeof SocketModule>()),
  createSandboxControlSocketHandler: mocks.socket,
}));
vi.mock('../sandbox-session/session-stub.js', () => ({ getSandboxSessionStub: mocks.session }));

const NOW = 1_700_000_000_000;
const SANDBOX_ID = 'ses-abcdef';
const OWNER = 'owner_1';
const WRAPPER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EXECUTION_DEADLINE = NOW + 600_000;
const roots = [
  {
    sessionId: 'workspace_a',
    kiloSessionId: 'kilo_a',
    directory: '/workspace/a',
    nativeRuntimeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  },
  {
    sessionId: 'workspace_b',
    kiloSessionId: 'kilo_b',
    directory: '/workspace/b',
    nativeRuntimeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  },
] as const;
const [rootA, rootB] = roots;
const scenarios = ['pending Stop', 'getControlState timeout', 'operation.get timeout'] as const;
type Scenario = (typeof scenarios)[number];

function authorization(
  root: (typeof roots)[number],
  messageId = `original_${root.sessionId}`
): SessionOperationAuthorization {
  return {
    operation: 'session.prompt',
    operationId: messageId,
    messageId,
    session: {
      sessionId: root.sessionId,
      kiloSessionId: root.kiloSessionId,
      directory: root.directory,
    },
    wrapperInstanceId: WRAPPER,
    dispatchDeadlineAt: NOW + 5_000,
  };
}

function response(result: unknown): ResponseFrame {
  return { type: 'response', requestId: 'test_request', ok: true, result };
}

function maintenance(original: SessionOperationAuthorization): SandboxControlOutboundRequest {
  return {
    operation: 'session.operation.get',
    session: original.session,
    payload: original,
    expectedWrapperInstanceId: original.wrapperInstanceId,
    deadlineAt: Date.now() + 30_000,
    timeoutMs: 30_000,
  };
}

function prompt(original: SessionOperationAuthorization): SandboxControlOutboundRequest {
  return {
    operation: 'session.prompt',
    session: original.session,
    authorization: original,
    expectedWrapperInstanceId: original.wrapperInstanceId,
    payload: {
      messageId: original.messageId,
      turn: { type: 'prompt', prompt: 'Continue' },
      agent: { mode: 'code', model: 'kilo/fake' },
    },
  };
}

function memoryState() {
  const records = new Map<string, unknown>();
  let alarmAt: number | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  function remove(key: string): Promise<boolean>;
  function remove(keys: string[]): Promise<number>;
  async function remove(key: string | string[]): Promise<boolean | number> {
    return typeof key === 'string'
      ? records.delete(key)
      : key.filter(item => records.delete(item)).length;
  }
  const storage = {
    async get<T>(key: string): Promise<T | undefined> {
      return structuredClone(records.get(key)) as T | undefined;
    },
    async list(options?: { prefix?: string }) {
      return new Map(
        structuredClone([...records].filter(([key]) => key.startsWith(options?.prefix ?? '')))
      );
    },
    async put(key: string | Record<string, unknown>, value?: unknown) {
      if (typeof key === 'string') records.set(key, structuredClone(value));
      else
        for (const [name, entry] of Object.entries(key)) records.set(name, structuredClone(entry));
    },
    delete: remove,
    rollback() {
      throw new Error('Transaction rolled back');
    },
    async getAlarm() {
      return alarmAt;
    },
    async setAlarm(at: number) {
      alarmAt = at;
    },
    async deleteAlarm() {
      alarmAt = null;
    },
    transaction<T>(operation: (tx: DurableObjectTransaction) => Promise<T>): Promise<T> {
      const pending = tail.then(async () => {
        const snapshot = structuredClone(records);
        const previousAlarm = alarmAt;
        try {
          return await operation(storage as unknown as DurableObjectTransaction);
        } catch (error) {
          records.clear();
          for (const [key, value] of snapshot) records.set(key, value);
          alarmAt = previousAlarm;
          throw error;
        }
      });
      tail = pending.catch(() => undefined);
      return pending;
    },
  };
  return storage;
}

async function harness() {
  const storage = memoryState();
  const pending: Promise<unknown>[] = [];
  const ctx = {
    id: { name: SANDBOX_ID },
    storage,
    getWebSockets: () => [],
    setWebSocketAutoResponse: vi.fn(),
    blockConcurrencyWhile: (operation: () => Promise<void>) => operation(),
    waitUntil: (task: Promise<unknown>) => {
      pending.push(task);
    },
  } as unknown as DurableObjectState;
  const env = {} as Env;
  const provider = {
    resumable: false,
    create: vi.fn<ProviderAdapter['create']>(),
    launch: vi.fn<ProviderAdapter['launch']>(),
    ensureBillingAdmission: vi.fn(async () => undefined),
    observe: vi.fn<ProviderAdapter['observe']>(async () => ({ status: 'active' })),
    stop: vi.fn<ProviderAdapter['stop']>(async () => 'terminal'),
    ensureLeaseAtLeast: vi.fn(async () => undefined),
    logs: vi.fn(async () => ''),
  } satisfies ProviderAdapter;
  mocks.provider.mockReturnValue(provider);
  const containment = { kilocode: false, github: false, worktreeScoped: true } as const;
  const providerRef = encodeCloudflareProviderRef({
    sandboxId: SANDBOX_ID,
    containment: false,
    instanceId: 'allocation_1',
  });
  const physical = {
    state: 'running',
    providerRef,
    resumable: false,
    stopTombstone: null,
    createIntent: { intentId: 'allocation_1', createdAt: NOW - 1_000, containment },
    containment: { ...containment, providerRef },
  } satisfies PhysicalRecord;
  await savePhysicalRecord(storage, physical);
  await saveRouteTable(
    storage,
    new Map(
      roots.map(root => [
        root.sessionId,
        {
          ...root,
          ownerId: OWNER,
          lastState: 'idle',
          lastStateAt: NOW,
          idleForMs: 0,
          waitingOn: null,
        } satisfies SessionRoute,
      ])
    )
  );
  let connection: SandboxControlConnectionIdentity = {
    connectionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    providerInstanceId: providerRef,
    wrapperInstanceId: WRAPPER,
    recoveryCapable: true,
  };
  let hooks: SandboxControlSocketHooks = {};
  let operationTimeout = false;
  const sendRequest = vi.fn(
    async (request: SandboxControlOutboundRequest): Promise<ResponseFrame> => {
      if (request.operation === 'sandbox.reconcile') {
        const { recovery, phase } = sandboxReconcilePayloadSchema.parse(request.payload);
        return response({ episodeId: recovery.episodeId, attempt: recovery.attempt, phase });
      }
      if (request.operation === 'sandbox.status')
        return response({ healthy: true, state: 'active', version: '2.4.0', kiloReady: true });
      if (request.operation === 'session.operation.get') {
        const original = sessionOperationAuthorizationSchema.parse(request.payload);
        if (operationTimeout && original.session.sessionId === rootA.sessionId)
          return new Promise(() => undefined);
        return response({
          state: 'running',
          authorization: original,
          executionDeadlineAt: EXECUTION_DEADLINE,
        });
      }
      if (request.operation === 'session.prompt')
        return response({
          messageId: request.authorization?.messageId,
          status: 'accepted',
          executionDeadlineAt: EXECUTION_DEADLINE,
        });
      if (request.operation === 'session.abort')
        return response({ status: 'unconfirmed', runtimeRetired: false });
      if (request.operation === 'session.operation.ack') return response({ acknowledged: true });
      if (
        request.operation === 'session.permission.resolve' ||
        request.operation === 'session.question.resolve'
      )
        return response({ success: true });
      throw new Error(`Unexpected request ${request.operation}`);
    }
  );
  const socket = {
    getConnectionIdentity: () => connection,
    hasHandshakenSocket: () => true,
    supportsOperationResults: () => true,
    supportsScopedStopAbort: () => true,
    supportsNativeRuntimeRetirement: () => true,
    supportsConnectionRecovery: (): boolean => true,
    closeAll: vi.fn(),
    closeHandshakenSockets: vi.fn(),
    closeProvisionalSockets: vi.fn(),
    sendRequest,
  } satisfies Partial<SandboxControlSocketHandler>;
  mocks.socket.mockImplementation((_ctx, _id, _waiters, callbacks: SandboxControlSocketHooks) => {
    hooks = callbacks;
    return socket;
  });
  let control = new SandboxControl(ctx, env);
  const makeSession = () => ({
    getControlState: vi.fn(
      async (options?: { includeIdle?: boolean }): Promise<ControlSessionState | null> =>
        options?.includeIdle
          ? {
              version: 1,
              scope: { sandboxId: SANDBOX_ID, wrapperInstanceId: WRAPPER },
              targets: [],
            }
          : null
    ),
    interruptExecution: vi.fn(async (request: ControlStopRequest) => ({
      ...request,
      state: 'accepted' as const,
    })),
    reconcileControlRecovery: vi.fn(async (authorizations: SessionOperationAuthorization[]) => {
      for (const original of authorizations) {
        const reply = await control.request(maintenance(original));
        if (!reply.ok) return { state: 'unresolved' as const };
        const lookup = sessionOperationLookupResultSchema.parse(reply.result);
        if (lookup.state !== 'running' || !sameSessionOperation(lookup.authorization, original))
          return { state: 'unresolved' as const };
      }
      return { state: 'reconciled' as const };
    }),
    receiveSandboxOperationResult: vi.fn(
      async ({
        delivery,
      }: {
        delivery: SessionOperationDelivery;
      }): Promise<SessionOperationAck> => ({
        version: 2,
        authorization: delivery.authorization,
        resultHash: await sessionOperationResultHash(delivery),
        disposition: 'applied',
        decision: { state: 'completed', at: delivery.completedAt },
      })
    ),
    receiveSandboxControlEvent: vi.fn(async () => ({ applied: true })),
    failWaitingMessages: vi.fn(async () => undefined),
    invalidateTerminalRuntime: vi.fn(async () => undefined),
    recordNativeRuntime: vi.fn(async () => undefined),
  });
  const sessionA = makeSession();
  const sessionB = makeSession();
  mocks.session.mockImplementation((_env, ownerId, sessionId) => {
    if (ownerId !== OWNER) throw new Error('Unexpected Session owner');
    if (sessionId === rootA.sessionId) return sessionA;
    if (sessionId === rootB.sessionId) return sessionB;
    throw new Error('Unexpected Session id');
  });
  const flush = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  await control.initializeOwner(OWNER);
  await hooks.onHandshakeComplete?.(connection);
  await hooks.onReady?.(connection);
  await flush();
  expect(await loadRecoveryDecisions(storage)).toEqual([]);
  expect(sessionA.getControlState).toHaveBeenCalledWith({ includeIdle: true });
  expect(sessionB.getControlState).toHaveBeenCalledWith({ includeIdle: true });
  for (const [root, session] of [
    [rootA, sessionA],
    [rootB, sessionB],
  ] as const) {
    const original = authorization(root);
    expect(await control.request(prompt(original))).toMatchObject({
      ok: true,
      result: {
        status: 'accepted',
        executionDeadlineAt: EXECUTION_DEADLINE,
      },
    });
    session.getControlState.mockResolvedValue({
      version: 1,
      scope: { sandboxId: SANDBOX_ID, wrapperInstanceId: WRAPPER },
      targets: [
        {
          messageId: original.messageId,
          wrapperInstanceId: WRAPPER,
          executionDeadlineAt: EXECUTION_DEADLINE,
        },
      ],
      operations: [
        {
          messageId: original.messageId,
          authorization: original,
          executionDeadlineAt: EXECUTION_DEADLINE,
        },
      ],
    });
  }
  return {
    storage,
    provider,
    physical,
    sessionA,
    sessionB,
    socket,
    sendRequest,
    get control() {
      return control;
    },
    get hooks() {
      return hooks;
    },
    get connection() {
      return connection;
    },
    flush,
    async reconstruct() {
      control = new SandboxControl(ctx, env);
      await control.getStatus();
      await flush();
    },
    async reconnectForInteraction() {
      await hooks.onSocketClosed?.(true, connection);
      connection = { ...connection, connectionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' };
      await hooks.onHandshakeComplete?.(connection);
      await flush();
      expect(await control.getStatus()).toMatchObject({ connection: 'connected' });
      sendRequest.mockClear();
    },
    async recover(scenario: Scenario) {
      if (scenario === 'pending Stop') {
        const state = await sessionA.getControlState({ includeIdle: true });
        if (!state) throw new Error('Expected accepted A state');
        sessionA.getControlState.mockResolvedValue({
          ...state,
          stops: [
            {
              version: 1,
              operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              scope: state.scope,
              targets: state.targets,
              cleanupDeadlineAt: NOW + 20_000,
              state: 'accepted',
            },
          ],
        });
      }
      await hooks.onSocketClosed?.(true, connection);
      if (scenario === 'getControlState timeout')
        sessionA.getControlState.mockImplementation(() => new Promise(() => undefined));
      operationTimeout = scenario === 'operation.get timeout';
      vi.clearAllMocks();
      vi.setSystemTime(NOW + 6_000);
      connection = { ...connection, connectionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' };
      await hooks.onHandshakeComplete?.(connection);
      await hooks.onReady?.(connection);
      if (scenario !== 'pending Stop') await vi.advanceTimersByTimeAsync(30_000);
      await flush();
    },
    async retry(scenario: Scenario) {
      const deadlines = await loadDeadlines(storage);
      if (deadlines.recoveryRetry === undefined) throw new Error('Missing recovery retry deadline');
      vi.setSystemTime(Math.max(Date.now(), deadlines.recoveryRetry));
      await control.alarm();
      if (scenario !== 'pending Stop') await vi.advanceTimersByTimeAsync(30_000);
      await flush();
    },
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function retained(h: Harness) {
  const records = await loadRecoveryDecisions(h.storage);
  expect(records).toHaveLength(1);
  const record = records[0];
  if (!record) throw new Error('Expected retained scoped recovery');
  return record;
}

async function expectScopedAdmission(h: Harness) {
  const admitted = {
    ...authorization(rootB, 'followup_b'),
    dispatchDeadlineAt: Date.now() + 5_000,
  };
  await expect
    .soft(h.control.request(prompt(admitted)))
    .resolves.toMatchObject({ ok: true, result: { status: 'accepted' } });
  const blocked = { ...authorization(rootA, 'followup_a'), dispatchDeadlineAt: Date.now() + 5_000 };
  await expect
    .soft(h.control.request(prompt(blocked)))
    .rejects.toThrow('Session recovery is not ready');
  expect
    .soft(
      h.sendRequest.mock.calls.filter(
        ([request]) =>
          request.operation === 'session.prompt' && request.session?.sessionId === rootA.sessionId
      )
    )
    .toEqual([]);
  await expect.soft(h.control.request(maintenance(authorization(rootB)))).resolves.toEqual(
    response({
      state: 'running',
      authorization: authorization(rootB),
      executionDeadlineAt: EXECUTION_DEADLINE,
    })
  );
}

async function expectNoSiblingRetirement(h: Harness, scenario: Scenario) {
  const retirements = await loadNativeRuntimeRetirements(h.storage);
  expect
    .soft(
      retirements.some(
        item =>
          item.nativeRuntimeId === rootB.nativeRuntimeId ||
          item.recipients.some(recipient => recipient.sessionId === rootB.sessionId)
      )
    )
    .toBe(false);
  expect
    .soft(
      h.sendRequest.mock.calls.filter(
        ([request]) =>
          request.operation === 'session.abort' &&
          (scenario !== 'pending Stop' || request.session?.sessionId === rootB.sessionId)
      )
    )
    .toEqual([]);
  expect.soft(h.provider.stop).not.toHaveBeenCalled();
  expect
    .soft(h.sendRequest.mock.calls.filter(([request]) => request.operation === 'sandbox.shutdown'))
    .toEqual([]);
  expect.soft(h.socket.closeAll).not.toHaveBeenCalled();
  expect.soft(h.socket.closeHandshakenSockets).not.toHaveBeenCalled();
  expect.soft(await h.control.getPhysicalRecord()).toEqual(h.physical);
  const routeB = (await loadRouteTable(h.storage)).get(rootB.sessionId);
  expect.soft(routeB?.nativeRuntimeId).toBe(rootB.nativeRuntimeId);
  expect.soft(routeB?.retiringNativeRuntimeId).toBeUndefined();
  expect.soft(h.sessionB.failWaitingMessages).not.toHaveBeenCalled();
  expect.soft(h.sessionB.invalidateTerminalRuntime).not.toHaveBeenCalled();
  if (scenario !== 'pending Stop') {
    expect.soft(retirements).toEqual([]);
    expect.soft(h.sessionA.invalidateTerminalRuntime).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal('WebSocketRequestResponsePair', class {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each([
  {
    operation: 'session.permission.resolve',
    payload: { permissionId: 'permission_a', response: 'once' },
  },
  {
    operation: 'session.question.resolve',
    payload: { action: 'answer', questionId: 'question_a', answers: [['yes']] },
  },
  {
    operation: 'session.question.resolve',
    payload: { action: 'reject', questionId: 'question_a' },
  },
] satisfies Pick<SandboxControlOutboundRequest, 'operation' | 'payload'>[])(
  'SandboxControl recovery interaction $operation $payload',
  interaction => {
    function request(): SandboxControlOutboundRequest {
      return { ...interaction, session: authorization(rootA).session };
    }

    it('forwards the current reply before readiness and after reconstruction without admitting prompts', async () => {
      const h = await harness();
      await h.reconnectForInteraction();
      const recovery = await retained(h);
      expect(recovery.activationAcknowledgedAt).toBeUndefined();
      expect(
        recovery.authority?.roots?.find(root => root.sessionId === rootA.sessionId)
      ).toMatchObject({
        observation: 'known',
        decision: 'operation_unknown',
        nativeRuntimeId: rootA.nativeRuntimeId,
      });
      for (const reconstruct of [false, true]) {
        if (reconstruct) await h.reconstruct();
        expect(await h.control.getStatus()).toMatchObject({ connection: 'connected' });
        await expect(h.control.request(request())).resolves.toEqual(response({ success: true }));
        expect(h.sendRequest).toHaveBeenLastCalledWith(request());
        await expect(h.control.request(prompt(authorization(rootA)))).rejects.toThrow(
          'Sandbox runtime is not ready'
        );
      }
      expect(h.sendRequest).toHaveBeenCalledTimes(2);
      expect(await retained(h)).toEqual(recovery);
      expect(h.provider.stop).not.toHaveBeenCalled();
    });

    it.each([
      { session: undefined },
      { session: { ...rootA, sessionId: 'workspace_missing' } },
      { session: { ...rootA, kiloSessionId: rootB.kiloSessionId } },
      { session: { ...rootA, directory: rootB.directory } },
      { expectedWrapperInstanceId: rootB.nativeRuntimeId },
      { payload: {} },
    ])('rejects invalid or stale request scope %j without forwarding', async change => {
      const h = await harness();
      await h.reconnectForInteraction();
      await expect(h.control.request({ ...request(), ...change })).rejects.toThrow();
      expect(h.sendRequest).not.toHaveBeenCalled();
    });

    it.each([
      'missing route',
      'native runtime replaced',
      'native runtime retiring',
      'owner changed',
      'allocation changed',
      'physical stopping',
      'physical provider changed',
      'runtime deleted',
      'recovery connection changed',
      'recovery wrapper changed',
      'recovery exhausted',
      'recovery expired',
      'recovery root stale',
      'recovery Stop pending',
      'recovery missing',
      'recovery not negotiated',
    ])('rejects %s without forwarding', async change => {
      const h = await harness();
      await h.reconnectForInteraction();
      const routes = await loadRouteTable(h.storage);
      const route = routes.get(rootA.sessionId);
      if (!route) throw new Error('Expected current route');
      const recovery = await retained(h);
      switch (change) {
        case 'missing route':
          routes.delete(rootA.sessionId);
          break;
        case 'native runtime replaced':
          route.nativeRuntimeId = rootB.nativeRuntimeId;
          break;
        case 'native runtime retiring':
          route.retiringNativeRuntimeId = rootA.nativeRuntimeId;
          break;
        case 'owner changed':
          route.ownerId = 'owner_2';
          break;
        case 'allocation changed':
          await savePhysicalRecord(h.storage, {
            ...h.physical,
            createIntent: { ...h.physical.createIntent, intentId: 'allocation_2' },
          });
          break;
        case 'physical stopping':
          await savePhysicalRecord(
            h.storage,
            beginStop(h.physical, 'test stop', Date.now(), WRAPPER)
          );
          break;
        case 'physical provider changed':
          await savePhysicalRecord(h.storage, { ...h.physical, providerRef: 'replacement' });
          break;
        case 'runtime deleted':
          await h.storage.put('runtime_deleted', true);
          await h.reconstruct();
          break;
        case 'recovery connection changed':
          recovery.connectionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
          break;
        case 'recovery wrapper changed':
          recovery.wrapperInstanceId = rootB.nativeRuntimeId;
          break;
        case 'recovery exhausted':
          recovery.exhaustedAt = Date.now();
          break;
        case 'recovery expired':
          recovery.deadlineAt = Date.now();
          break;
        case 'recovery root stale':
        case 'recovery Stop pending': {
          const root = recovery.authority?.roots?.find(item => item.sessionId === rootA.sessionId);
          if (!root) throw new Error('Expected recovery root');
          if (change === 'recovery root stale') root.observation = 'stale';
          else root.decision = 'stop_pending';
          break;
        }
        case 'recovery not negotiated':
          vi.spyOn(h.socket, 'supportsConnectionRecovery').mockReturnValue(false);
          break;
      }
      await saveRouteTable(h.storage, routes);
      await saveRecoveryDecisions(h.storage, change === 'recovery missing' ? [] : [recovery]);
      await expect(h.control.request(request())).rejects.toThrow();
      expect(h.sendRequest).not.toHaveBeenCalled();
    });
  }
);

describe('SandboxControl production recovery hooks', () => {
  it.each(scenarios)(
    'activates B without changing its original operation while A has %s',
    async scenario => {
      const h = await harness();
      await h.recover(scenario);
      const recovery = await retained(h);
      expect.soft(recovery.activationAcknowledgedAt).toBe(Date.now());
      expect.soft(recovery.authority?.roots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: rootA.sessionId,
            decision: scenario === 'pending Stop' ? 'stop_pending' : 'operation_unknown',
          }),
          expect.objectContaining({ sessionId: rootB.sessionId, decision: 'ready' }),
        ])
      );
      expect
        .soft(
          h.sendRequest.mock.calls
            .filter(([request]) => request.operation === 'sandbox.reconcile')
            .map(([request]) => sandboxReconcilePayloadSchema.parse(request.payload).phase)
        )
        .toEqual(['drain', 'ready', 'commit']);
      expect
        .soft(h.sessionB.reconcileControlRecovery)
        .toHaveBeenCalledExactlyOnceWith([authorization(rootB)]);
      expect.soft(h.sendRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'session.operation.get',
          session: authorization(rootB).session,
          payload: authorization(rootB),
          expectedWrapperInstanceId: WRAPPER,
        })
      );
      expect
        .soft(recovery.authority?.scopes.find(scope => scope.sessionId === rootB.sessionId))
        .toMatchObject({
          ...authorization(rootB).session,
          messageId: authorization(rootB).messageId,
          authorization: authorization(rootB),
          executionDeadlineAt: EXECUTION_DEADLINE,
          wrapperInstanceId: WRAPPER,
          nativeRuntimeId: rootB.nativeRuntimeId,
        });
      expect
        .soft(
          h.sendRequest.mock.calls.filter(([request]) => request.operation === 'session.prompt')
        )
        .toEqual([]);
      if (scenario === 'pending Stop')
        expect.soft(h.sessionA.interruptExecution).toHaveBeenCalled();
      await expectScopedAdmission(h);
      await expectNoSiblingRetirement(h, scenario);
      const bStateCalls = h.sessionB.getControlState.mock.calls.length;
      const bReconcileCalls = h.sessionB.reconcileControlRecovery.mock.calls.length;
      await h.reconstruct();
      await expectScopedAdmission(h);
      await h.retry(scenario);
      expect.soft(h.sessionB.getControlState).toHaveBeenCalledTimes(bStateCalls);
      expect.soft(h.sessionB.reconcileControlRecovery).toHaveBeenCalledTimes(bReconcileCalls);
      const retried = await retained(h);
      expect.soft(retried.episodeId).toBe(recovery.episodeId);
      expect.soft(retried.activationAcknowledgedAt).toBe(recovery.activationAcknowledgedAt);
      expect
        .soft(retried.authority?.scopes.filter(scope => scope.sessionId === rootB.sessionId))
        .toEqual(recovery.authority?.scopes.filter(scope => scope.sessionId === rootB.sessionId));
    }
  );

  it.each(scenarios)(
    'preserves B admission and result through exhaustion and reconstruction when A has %s',
    async scenario => {
      const h = await harness();
      await h.recover(scenario);
      const initial = await retained(h);
      await h.reconstruct();
      await h.retry(scenario);
      await h.reconstruct();
      await h.retry(scenario);
      const exhausted = await retained(h);
      expect.soft(exhausted.exhaustedAt).toBeDefined();
      expect.soft(exhausted.episodeId).toBe(initial.episodeId);
      expect.soft(exhausted.activationAcknowledgedAt).toBe(initial.activationAcknowledgedAt);
      expect
        .soft(
          exhausted.authority?.roots?.find(root => root.sessionId === rootB.sessionId)?.decision
        )
        .toBe('ready');
      await h.reconstruct();
      await h.control.alarm();
      await h.flush();
      await expectNoSiblingRetirement(h, scenario);
      if (exhausted.cleanupDeadlineAt === undefined) throw new Error('Missing cleanup deadline');
      vi.setSystemTime(exhausted.cleanupDeadlineAt);
      await h.control.alarm();
      await h.flush();
      await h.reconstruct();
      await expectNoSiblingRetirement(h, scenario);
      await expectScopedAdmission(h);
      const finalRecovery = await retained(h);
      expect
        .soft(finalRecovery.authority?.scopes.filter(scope => scope.sessionId === rootB.sessionId))
        .toEqual(initial.authority?.scopes.filter(scope => scope.sessionId === rootB.sessionId));
      const delivery: SessionOperationDelivery = {
        version: 2,
        authorization: authorization(rootB),
        completedAt: Date.now(),
        result: {
          ok: true,
          result: {
            messageId: authorization(rootB).messageId,
            status: 'accepted',
            executionDeadlineAt: EXECUTION_DEADLINE,
          },
        },
        outcome: { messageId: authorization(rootB).messageId, status: 'completed' },
        events: [],
        preparing: [],
      };
      await expect
        .soft(h.hooks.onOperationResult?.(authorization(rootB).session, delivery, h.connection))
        .resolves.toMatchObject({
          authorization: authorization(rootB),
          disposition: 'applied',
          decision: { state: 'completed' },
        });
      expect.soft(h.sessionB.receiveSandboxOperationResult).toHaveBeenCalledExactlyOnceWith({
        session: authorization(rootB).session,
        wrapperInstanceId: WRAPPER,
        delivery,
      });
      expect.soft(h.sessionA.receiveSandboxOperationResult).not.toHaveBeenCalled();
      await h.flush();
    }
  );
});
