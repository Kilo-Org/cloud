import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import type { SessionOperationAuthorization } from '../shared/sandbox-control-protocol.js';
import {
  beginRecovery,
  replaceRecoveryAuthority,
  type RecoveryAuthority,
} from './control-recovery.js';
import { createRecoveryAuthority } from './recovery-authority.js';
import { savePhysicalRecord, saveRouteTable } from './durable-state.js';
import { DEADLINE_MS } from './deadlines.js';

const sessionStub = vi.hoisted(() => vi.fn());
vi.mock('../sandbox-session/session-stub.js', () => ({ getSandboxSessionStub: sessionStub }));
const identity = {
  connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  wrapperInstanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  providerInstanceId: 'allocation_a',
  recoveryCapable: true,
};
const routes = ['a', 'b'].map(name => ({
  sessionId: `workspace_${name}`,
  ownerId: 'owner',
  kiloSessionId: `kilo_${name}`,
  directory: `/workspace/${name}`,
  nativeRuntimeId:
    name === 'a' ? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' : 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  lastState: 'active' as const,
  lastStateAt: 10_000,
  idleForMs: 0,
  waitingOn: 'model' as const,
}));
function authorization(index: number): SessionOperationAuthorization {
  const route = routes[index];
  if (!route) throw new Error('Missing route');
  return {
    operation: 'session.prompt',
    operationId: `message_${index}`,
    messageId: `message_${index}`,
    session: {
      sessionId: route.sessionId,
      kiloSessionId: route.kiloSessionId,
      directory: route.directory,
    },
    wrapperInstanceId: identity.wrapperInstanceId,
    dispatchDeadlineAt: 100_000,
  };
}
async function harness() {
  const records = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => structuredClone(records.get(key)),
    put: async (key: string, value: unknown) => {
      records.set(key, structuredClone(value));
    },
    delete: async (keys: string[]) => keys.filter(key => records.delete(key)).length,
  } as unknown as DurableObjectStorage;
  await savePhysicalRecord(storage, {
    state: 'running',
    providerRef: identity.providerInstanceId,
    createIntent: { intentId: 'create_a', createdAt: 1 },
    stopTombstone: null,
    resumable: true,
  });
  await saveRouteTable(storage, new Map(routes.map(route => [route.sessionId, route])));
  const stubs = routes.map((route, index) => ({
    getControlState: vi.fn().mockResolvedValue({
      version: 1,
      scope: { sandboxId: 'sandbox_a', wrapperInstanceId: identity.wrapperInstanceId },
      targets: [
        {
          messageId: `message_${index}`,
          wrapperInstanceId: identity.wrapperInstanceId,
          executionDeadlineAt: 90_000 + index,
        },
      ],
      operations: [
        {
          messageId: `message_${index}`,
          authorization: authorization(index),
          executionDeadlineAt: 90_000 + index,
        },
      ],
    }),
    interruptExecution: vi.fn(),
    reconcileControlRecovery: vi.fn().mockResolvedValue({ state: 'reconciled' }),
  }));
  sessionStub.mockImplementation(
    (_env, _owner, sessionId) => stubs[routes.findIndex(route => route.sessionId === sessionId)]
  );
  const owner = createRecoveryAuthority({ storage, env: {} as Env, sandboxId: 'sandbox_a' });
  return {
    storage,
    owner,
    stubs,
    recovery: beginRecovery(undefined, identity, 'control_disconnected', Date.now()),
  };
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected value');
  return value;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('recovery authority observations', () => {
  it('retains immutable A bounds and Stop provenance when A times out, without changing B', async () => {
    const h = await harness();
    const a = required(h.stubs[0]);
    const stop = {
      version: 1,
      operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      scope: { sandboxId: 'sandbox_a', wrapperInstanceId: identity.wrapperInstanceId },
      targets: [
        {
          messageId: 'message_0',
          wrapperInstanceId: identity.wrapperInstanceId,
          executionDeadlineAt: 90_000,
        },
      ],
      cleanupDeadlineAt: 70_000,
      state: 'accepted',
    };
    a.getControlState.mockResolvedValueOnce({
      version: 1,
      scope: stop.scope,
      targets: stop.targets,
      stops: [stop],
      operations: [
        { messageId: 'message_0', authorization: authorization(0), executionDeadlineAt: 90_000 },
      ],
    });
    const first = required(await h.owner.load(h.recovery));
    expect(first.stops).toHaveLength(1);
    expect(first.scopes.filter(scope => scope.sessionId === 'workspace_a')).toHaveLength(2);
    a.getControlState.mockImplementation(() => new Promise(() => undefined));
    const loading = h.owner.load(replaceRecoveryAuthority(h.recovery, first));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS.stopAttempt);
    const observed = required(await loading);
    expect(observed.roots?.find(root => root.sessionId === 'workspace_a')).toMatchObject({
      observation: 'stale',
      decision: 'operation_unknown',
      observedAt: 10_000,
    });
    expect(observed.scopes.filter(scope => scope.sessionId === 'workspace_a')).toEqual(
      first.scopes.filter(scope => scope.sessionId === 'workspace_a')
    );
    expect(observed.stops).toEqual(first.stops);
    expect(
      observed.scopes.find(scope => scope.sessionId === 'workspace_b')?.executionDeadlineAt
    ).toBe(90_001);
    expect(observed.allocation).toEqual(first.allocation);
    expect(observed.wholeAllocation).toBe(false);
  });

  it('distinguishes null ownership from an authoritative empty idle Session', async () => {
    const h = await harness();
    required(h.stubs[0]).getControlState.mockResolvedValue(null);
    required(h.stubs[1]).getControlState.mockResolvedValue({
      version: 1,
      scope: { sandboxId: 'sandbox_a' },
      targets: [],
    });
    const observed = required(await h.owner.load(h.recovery));
    expect(observed.roots?.map(root => root.observation)).toEqual(['unknown', 'idle']);
    expect(observed.wholeAllocation).toBe(false);
  });

  it('never retargets a captured native incarnation after the route changes', async () => {
    const h = await harness();
    const first = required(await h.owner.load(h.recovery));
    const replacement = {
      ...required(routes[0]),
      nativeRuntimeId: crypto.randomUUID(),
      directory: '/workspace/replacement',
    };
    await saveRouteTable(
      h.storage,
      new Map([replacement, required(routes[1])].map(route => [route.sessionId, route]))
    );
    const observed = required(await h.owner.load(replaceRecoveryAuthority(h.recovery, first)));
    expect(observed.roots?.[0]).toMatchObject({
      observation: 'stale',
      nativeRuntimeId: routes[0]?.nativeRuntimeId,
      directory: '/workspace/a',
    });
    expect(observed.scopes.filter(scope => scope.sessionId === 'workspace_a')).toEqual(
      first.scopes.filter(scope => scope.sessionId === 'workspace_a')
    );
  });

  it('returns independent Stop decisions while B operation maintenance succeeds', async () => {
    const h = await harness();
    const authority = required(await h.owner.load(h.recovery));
    authority.stops = [
      {
        sessionId: 'workspace_a',
        ownerId: 'owner',
        request: {
          version: 1,
          operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          scope: { sandboxId: 'sandbox_a' },
          targets: [{ messageId: 'message_0' }],
          cleanupDeadlineAt: 70_000,
        },
      },
    ];
    required(h.stubs[0]).interruptExecution.mockRejectedValue(new Error('Unavailable'));
    expect(await h.owner.reconcileStops(authority)).toEqual([
      { sessionId: 'workspace_a', decision: 'stop_pending' },
      { sessionId: 'workspace_b', decision: 'ready' },
    ]);
    expect(await h.owner.reconcileOperations(authority)).toEqual([
      { sessionId: 'workspace_a', decision: 'ready' },
      { sessionId: 'workspace_b', decision: 'ready' },
    ]);
  });

  it('does not reinterpret an RPC timeout as an equal-valued execution expiry', async () => {
    const h = await harness();
    const authority: RecoveryAuthority = required(await h.owner.load(h.recovery));
    required(h.stubs[0]).reconcileControlRecovery.mockImplementation(
      () => new Promise(() => undefined)
    );
    const timeout = h.owner.reconcileOperations(authority);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS.stopAttempt);
    expect(await timeout).toEqual([
      { sessionId: 'workspace_a', decision: 'operation_unknown' },
      { sessionId: 'workspace_b', decision: 'ready' },
    ]);
    const executionExpired = {
      ...authority,
      scopes: authority.scopes.map(scope =>
        scope.sessionId === 'workspace_a' ? { ...scope, executionDeadlineAt: Date.now() } : scope
      ),
    };
    expect(await h.owner.reconcileOperations(executionExpired)).toEqual([
      { sessionId: 'workspace_a', decision: 'execution_expired' },
      { sessionId: 'workspace_b', decision: 'ready' },
    ]);
  });
});
