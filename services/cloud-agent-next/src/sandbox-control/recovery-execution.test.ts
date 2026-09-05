import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  sandboxReconcilePayloadSchema,
  type ResponseFrame,
} from '../shared/sandbox-control-protocol.js';
import {
  ACTIVE_WRAPPER_RUNTIME_KEY,
  WRAPPER_READY_AT_KEY,
  admitsRecoveryRequest,
  beginRecovery,
  commitRecoveryActivation,
  recoveryDeadlines,
  sameConnection,
  type RecoveryAuthority,
  type RecoveryScopeResult,
  type SandboxRecoveryDecision,
} from './control-recovery.js';
import {
  loadDeadlines,
  loadPhysicalRecord,
  loadRecoveryDecisions,
  saveDeadlines,
  savePhysicalRecord,
  saveRecoveryDecisions,
} from './durable-state.js';
import type { PhysicalRecord } from './physical-lifecycle.js';
import { createRecoveryExecution, type RecoveryExecutionRuntime } from './recovery-execution.js';
import type { SandboxControlOutboundRequest } from './socket.js';

const NOW = 1_000_000;
const identity = {
  connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  providerInstanceId: 'allocation_a',
  wrapperInstanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  recoveryCapable: true,
};
const rootA = {
  sessionId: 'workspace_a',
  ownerId: 'owner_a',
  kiloSessionId: 'kilo_a',
  directory: '/workspace/a',
  nativeRuntimeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  observation: 'known',
  decision: 'ready',
} satisfies NonNullable<RecoveryAuthority['roots']>[number];
const rootB = {
  sessionId: 'workspace_b',
  ownerId: 'owner_b',
  kiloSessionId: 'kilo_b',
  directory: '/workspace/b',
  nativeRuntimeId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  observation: 'known',
  decision: 'ready',
} satisfies NonNullable<RecoveryAuthority['roots']>[number];

function memoryStorage() {
  const values = new Map<string, unknown>();
  let failCommit = false;
  const view = (rows: Map<string, unknown>) => ({
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return structuredClone(rows.get(key)) as T | undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      rows.set(key, structuredClone(value));
    },
    async delete(keys: string[]): Promise<number> {
      return keys.filter(key => rows.delete(key)).length;
    },
  });
  return {
    ...view(values),
    failNextTransaction() {
      failCommit = true;
    },
    async transaction<T>(callback: (tx: DurableObjectTransaction) => Promise<T>): Promise<T> {
      const draft = structuredClone(values);
      const result = await callback(view(draft) as DurableObjectTransaction);
      if (failCommit) {
        failCommit = false;
        throw new Error('Ready transaction persistence failed');
      }
      values.clear();
      for (const [key, value] of draft) values.set(key, value);
      return result;
    },
  };
}

function authority(): RecoveryAuthority {
  return {
    source: 'session_control_state',
    observedAt: NOW - 1_000,
    allocation: { providerRef: identity.providerInstanceId, createIntentId: 'create_a' },
    roots: [rootA, rootB],
    scopes: [rootA, rootB].map(root => {
      const messageId = `message_${root.sessionId}`;
      return {
        sessionId: root.sessionId,
        kiloSessionId: root.kiloSessionId,
        directory: root.directory,
        messageId,
        wrapperInstanceId: identity.wrapperInstanceId,
        nativeRuntimeId: root.nativeRuntimeId,
        executionDeadlineAt: NOW + 60_000,
        authorization: {
          operation: 'session.prompt',
          operationId: messageId,
          messageId,
          session: {
            sessionId: root.sessionId,
            kiloSessionId: root.kiloSessionId,
            directory: root.directory,
          },
          wrapperInstanceId: identity.wrapperInstanceId,
          dispatchDeadlineAt: NOW + 5_000,
        },
      };
    }),
    stops: [
      {
        sessionId: rootA.sessionId,
        ownerId: rootA.ownerId,
        request: {
          version: 1,
          operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          scope: { sandboxId: 'sandbox_a', wrapperInstanceId: identity.wrapperInstanceId },
          targets: [
            {
              messageId: `message_${rootA.sessionId}`,
              wrapperInstanceId: identity.wrapperInstanceId,
              executionDeadlineAt: NOW + 60_000,
            },
          ],
          cleanupDeadlineAt: NOW + 10_000,
        },
      },
    ],
    wholeAllocation: true,
  };
}

function recoveryDecision(): SandboxRecoveryDecision {
  return {
    ...beginRecovery(undefined, identity, 'control_disconnected', NOW),
    authority: authority(),
  };
}

function committedDecision(): SandboxRecoveryDecision {
  return commitRecoveryActivation(
    {
      ...recoveryDecision(),
      startedAt: NOW - 100_000,
      deadlineAt: NOW - 10_000,
      attempt: 2,
    },
    NOW
  );
}

function acknowledge(request: SandboxControlOutboundRequest): ResponseFrame {
  if (request.operation === 'sandbox.status') {
    return {
      type: 'response',
      requestId: 'status',
      ok: true,
      result: { healthy: true, state: 'idle', version: 'test', kiloReady: true },
    };
  }
  if (request.operation !== 'sandbox.reconcile')
    throw new Error(`Unexpected operation: ${request.operation}`);
  const { recovery, phase } = sandboxReconcilePayloadSchema.parse(request.payload);
  return {
    type: 'response',
    requestId: phase,
    ok: true,
    result: { episodeId: recovery.episodeId, attempt: recovery.attempt, phase },
  };
}

async function harness(decision = recoveryDecision()) {
  const storage = memoryStorage();
  await saveRecoveryDecisions(storage, [decision]);
  await saveDeadlines(storage, recoveryDeadlines({ idleStop: NOW + 300_000 }, [decision]));
  const physical = {
    state: 'running' as const,
    providerRef: identity.providerInstanceId,
    createIntent: { intentId: 'create_a', createdAt: NOW - 100_000 },
    stopTombstone: null,
    resumable: true,
  };
  await savePhysicalRecord(storage, physical);
  const runtime = {
    identity,
    isCurrent: vi.fn(() => true),
    acceptsPhysical: vi.fn(
      (current: PhysicalRecord) =>
        current.state === 'running' &&
        current.stopTombstone === null &&
        current.providerRef === identity.providerInstanceId
    ),
  } satisfies RecoveryExecutionRuntime;
  const dependencies = {
    storage,
    sendRequest: vi.fn(async (request: SandboxControlOutboundRequest) => acknowledge(request)),
    loadPhysical: vi.fn(() => loadPhysicalRecord(storage)),
    loadAuthority: vi.fn(async () => authority()),
    reconcileStops: vi.fn(
      async (): Promise<RecoveryScopeResult[]> => [
        { sessionId: rootB.sessionId, decision: 'ready' },
        { sessionId: rootA.sessionId, decision: 'ready' },
      ]
    ),
    reconcileOperations: vi.fn(
      async (): Promise<RecoveryScopeResult[]> => [
        { sessionId: rootB.sessionId, decision: 'ready' },
        { sessionId: rootA.sessionId, decision: 'ready' },
      ]
    ),
    onReady: vi.fn<Parameters<typeof createRecoveryExecution>[0]['onReady']>(
      async (connection, claimed) =>
        storage.transaction(async tx => {
          const records = await loadRecoveryDecisions(tx);
          const current = records.find(item => item.episodeId === claimed.episodeId);
          if (
            !current ||
            !sameConnection(current, connection) ||
            current.attempt !== claimed.attempt
          )
            return false;
          const committed = records.map(item =>
            item === current ? commitRecoveryActivation(item, Date.now()) : item
          );
          await saveRecoveryDecisions(tx, committed);
          await saveDeadlines(tx, recoveryDeadlines(await loadDeadlines(tx), committed));
          await tx.put(ACTIVE_WRAPPER_RUNTIME_KEY, {
            ...connection,
            readyConnectionId: connection.connectionId,
          });
          await tx.put(WRAPPER_READY_AT_KEY, Date.now());
          return true;
        })
    ),
    onActivated: vi.fn(),
    scheduleAlarm: vi.fn<Parameters<typeof createRecoveryExecution>[0]['scheduleAlarm']>(
      async () => undefined
    ),
  } satisfies Parameters<typeof createRecoveryExecution>[0];
  return {
    storage,
    runtime,
    dependencies,
    physical,
    reconstruct: () => createRecoveryExecution(dependencies),
    async retained() {
      const records = await loadRecoveryDecisions(storage);
      expect(records).toHaveLength(1);
      const record = records[0];
      if (!record) throw new Error('Expected a durable recovery record');
      return record;
    },
    requests() {
      return dependencies.sendRequest.mock.calls.map(([request]) =>
        request.operation === 'sandbox.reconcile'
          ? sandboxReconcilePayloadSchema.parse(request.payload).phase
          : request.operation
      );
    },
  };
}

function expectActivationOnly(dependencies: Awaited<ReturnType<typeof harness>>['dependencies']) {
  expect(dependencies.loadAuthority).not.toHaveBeenCalled();
  expect(dependencies.reconcileStops).not.toHaveBeenCalled();
  expect(dependencies.reconcileOperations).not.toHaveBeenCalled();
  expect(dependencies.loadPhysical).not.toHaveBeenCalled();
  expect(dependencies.onReady).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => vi.useRealTimers());

describe('createRecoveryExecution activation replay', () => {
  it('replays only commit after the original recovery deadline with the original episode and attempt', async () => {
    const committed = committedDecision();
    const h = await harness(committed);
    h.dependencies.loadPhysical.mockRejectedValue(new Error('Physical observation unavailable'));
    h.dependencies.loadAuthority.mockRejectedValue(new Error('Session authority unavailable'));

    expect(await h.reconstruct().reconcile(h.runtime)).toBe(true);

    expectActivationOnly(h.dependencies);
    expect(h.runtime.acceptsPhysical).not.toHaveBeenCalled();
    expect(h.dependencies.sendRequest).toHaveBeenCalledExactlyOnceWith({
      operation: 'sandbox.reconcile',
      expectedWrapperInstanceId: identity.wrapperInstanceId,
      payload: {
        phase: 'commit',
        recovery: {
          episodeId: committed.episodeId,
          cause: committed.cause,
          startedAt: committed.startedAt,
          deadlineAt: committed.deadlineAt,
          attempt: 2,
        },
      },
      deadlineAt: NOW + 30_000,
      timeoutMs: 30_000,
    });
    expect(h.dependencies.onActivated).toHaveBeenCalledExactlyOnceWith(identity);
    expect(await loadRecoveryDecisions(h.storage)).toEqual([]);
    expect(await h.storage.get(ACTIVE_WRAPPER_RUNTIME_KEY)).toEqual({
      ...identity,
      readyConnectionId: identity.connectionId,
    });
    expect(await h.storage.get(WRAPPER_READY_AT_KEY)).toBe(NOW);
    expect(await loadDeadlines(h.storage)).toEqual({
      idleStop: NOW + 300_000,
      heartbeatExpiry: NOW + 90_000,
    });
    expect(h.dependencies.scheduleAlarm).toHaveBeenLastCalledWith({
      idleStop: NOW + 300_000,
      heartbeatExpiry: NOW + 90_000,
    });
  });

  it('retains lost commit response scheduling and repairs it after reconstruction without reconciling authority again', async () => {
    const h = await harness();
    h.dependencies.sendRequest.mockImplementation(async request => {
      const response = acknowledge(request);
      if (
        request.operation === 'sandbox.reconcile' &&
        sandboxReconcilePayloadSchema.parse(request.payload).phase === 'commit'
      ) {
        throw new Error('Commit response lost');
      }
      return response;
    });
    expect(await h.reconstruct().reconcile(h.runtime)).toBe(false);
    const retained = await h.retained();
    expect(retained).toMatchObject({
      attempt: 1,
      activationCommittedAt: NOW,
      activationCommitDeadlineAt: NOW + 90_000,
      activationCommitAttempts: 1,
      nextAttemptAt: NOW + 1_000,
    });
    expect(retained.activationAcknowledgedAt).toBeUndefined();
    expect(retained.exhaustedAt).toBeUndefined();
    expect(h.requests()).toEqual(['drain', 'ready', 'sandbox.status', 'commit']);
    expect(h.dependencies.onActivated).not.toHaveBeenCalled();
    const deadlines = {
      idleStop: NOW + 300_000,
      recoveryExpiry: NOW + 90_000,
      recoveryRetry: NOW + 1_000,
    };
    expect(await loadDeadlines(h.storage)).toEqual(deadlines);
    expect(h.dependencies.scheduleAlarm).toHaveBeenLastCalledWith(deadlines);

    vi.clearAllMocks();
    h.dependencies.sendRequest.mockImplementation(async request => acknowledge(request));
    vi.setSystemTime(NOW + 999);
    expect(await h.reconstruct().reconcile(h.runtime)).toBe(false);
    expect(await h.retained()).toEqual(retained);
    expect(await loadDeadlines(h.storage)).toEqual(deadlines);
    expect(h.dependencies.sendRequest).not.toHaveBeenCalled();
    vi.setSystemTime(NOW + 1_000);
    expect(await h.reconstruct().reconcile(h.runtime)).toBe(true);
    expectActivationOnly(h.dependencies);
    expect(h.requests()).toEqual(['commit']);
    expect(h.dependencies.sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          phase: 'commit',
          recovery: {
            episodeId: retained.episodeId,
            cause: retained.cause,
            startedAt: retained.startedAt,
            deadlineAt: retained.deadlineAt,
            attempt: 1,
          },
        },
      })
    );
    expect(await loadRecoveryDecisions(h.storage)).toEqual([]);
    expect(await loadDeadlines(h.storage)).toEqual({
      idleStop: NOW + 300_000,
      heartbeatExpiry: NOW + 91_000,
    });
    expect(h.dependencies.onActivated).toHaveBeenCalledExactlyOnceWith(identity);
  });

  it('retains the committed receipt when readiness repair or completion alarm persistence fails', async () => {
    const h = await harness(committedDecision());
    h.dependencies.scheduleAlarm.mockImplementation(async deadlines => {
      if (deadlines.heartbeatExpiry !== undefined) throw new Error('Readiness alarm unavailable');
    });
    expect(await h.reconstruct().reconcile(h.runtime)).toBe(false);
    const retained = await h.retained();
    expect(retained).toMatchObject({
      activationCommittedAt: NOW,
      activationCommitDeadlineAt: NOW + 90_000,
      activationCommitAttempts: 1,
      nextAttemptAt: NOW + 1_000,
    });
    expect(retained.activationAcknowledgedAt).toBeUndefined();
    expect(h.dependencies.onActivated).not.toHaveBeenCalled();
    expectActivationOnly(h.dependencies);
    h.dependencies.scheduleAlarm.mockResolvedValue(undefined);
    vi.setSystemTime(NOW + 1_000);
    expect(await h.reconstruct().reconcile(h.runtime)).toBe(true);
    expect(await h.storage.get(WRAPPER_READY_AT_KEY)).toBe(NOW);
    expect(await loadRecoveryDecisions(h.storage)).toEqual([]);
  });

  it('allows at most three commit ACK attempts across reconstruction without renewing the episode or budget', async () => {
    const committed = committedDecision();
    const h = await harness(committed);
    h.dependencies.sendRequest.mockRejectedValue(new Error('Commit response lost'));
    for (const attempt of [1, 2, 3]) {
      vi.setSystemTime(NOW + (attempt - 1) * 1_000);
      expect(await h.reconstruct().reconcile(h.runtime)).toBe(false);
      expect(await h.retained()).toMatchObject({
        episodeId: committed.episodeId,
        attempt: committed.attempt,
        startedAt: committed.startedAt,
        deadlineAt: committed.deadlineAt,
        activationCommittedAt: NOW,
        activationCommitDeadlineAt: NOW + 90_000,
        activationCommitAttempts: attempt,
      });
      expect(h.dependencies.sendRequest).toHaveBeenCalledTimes(attempt);
    }
    const exhausted = await h.retained();
    expect(exhausted).toMatchObject({ exhaustedAt: NOW + 2_000, cleanupState: 'pending' });
    const deadlines = await loadDeadlines(h.storage);
    expect(deadlines).toEqual({ idleStop: NOW + 300_000, recoveryRetry: NOW + 2_000 });
    expect(h.dependencies.scheduleAlarm).toHaveBeenLastCalledWith(deadlines);
    vi.setSystemTime(NOW + 3_000);
    expect(await h.reconstruct().reconcile(h.runtime)).toBe(false);
    expect(await h.retained()).toEqual(exhausted);
    expect(h.requests()).toEqual(['commit', 'commit', 'commit']);
    expectActivationOnly(h.dependencies);
    expect(h.dependencies.onActivated).not.toHaveBeenCalled();
  });

  it('bounds commit ACKs to the original 90-second window across reconstruction', async () => {
    const h = await harness(committedDecision());
    h.dependencies.sendRequest.mockRejectedValueOnce(new Error('Commit response lost'));
    expect(await h.reconstruct().reconcile(h.runtime)).toBe(false);
    vi.setSystemTime(NOW + 89_000);
    h.dependencies.sendRequest.mockImplementationOnce(async request => {
      vi.setSystemTime(NOW + 90_000);
      return acknowledge(request);
    });
    expect(await h.reconstruct().reconcile(h.runtime)).toBe(false);
    expect(h.dependencies.sendRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        deadlineAt: NOW + 90_000,
        timeoutMs: 1_000,
      })
    );
    const expired = await h.retained();
    expect(expired).toMatchObject({
      activationCommitDeadlineAt: NOW + 90_000,
      activationCommitAttempts: 2,
      exhaustedAt: NOW + 90_000,
    });
    expect(await h.reconstruct().reconcile(h.runtime)).toBe(false);
    expect(await h.retained()).toEqual(expired);
    expect(h.requests()).toEqual(['commit', 'commit']);
    expectActivationOnly(h.dependencies);
    expect(h.dependencies.onActivated).not.toHaveBeenCalled();
  });

  it.each([
    { episodeId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    { attempt: 1 },
    { phase: 'ready' },
  ])(
    'retains the activation receipt when the commit ACK has a mismatched fence: %j',
    async mismatch => {
      const committed = committedDecision();
      const h = await harness(committed);
      h.dependencies.sendRequest.mockResolvedValue({
        type: 'response',
        requestId: 'commit',
        ok: true,
        result: {
          episodeId: committed.episodeId,
          attempt: committed.attempt,
          phase: 'commit',
          ...mismatch,
        },
      });
      expect(await h.reconstruct().reconcile(h.runtime)).toBe(false);
      expect(await h.retained()).toMatchObject({
        episodeId: committed.episodeId,
        attempt: committed.attempt,
        activationCommittedAt: NOW,
        activationCommitAttempts: 1,
        nextAttemptAt: NOW + 1_000,
      });
      expect(h.dependencies.onActivated).not.toHaveBeenCalled();
      expectActivationOnly(h.dependencies);
      expect(h.dependencies.scheduleAlarm).toHaveBeenLastCalledWith(await loadDeadlines(h.storage));
    }
  );
});

describe('createRecoveryExecution ready persistence', () => {
  it('rolls back a failed ready transaction and retains the prior recovery attempt and retry schedule', async () => {
    const decision = { ...recoveryDecision(), attempt: 1, nextAttemptAt: NOW };
    const h = await harness(decision);
    h.dependencies.sendRequest.mockImplementation(async request => {
      if (request.operation === 'sandbox.status') h.storage.failNextTransaction();
      return acknowledge(request);
    });
    expect(await h.reconstruct().reconcile(h.runtime)).toBe(false);
    const retained = await h.retained();
    expect(retained).toMatchObject({
      episodeId: decision.episodeId,
      startedAt: decision.startedAt,
      deadlineAt: decision.deadlineAt,
      attempt: 2,
      nextAttemptAt: NOW + 2_000,
    });
    expect(retained.activationCommittedAt).toBeUndefined();
    expect(retained.activationCommitDeadlineAt).toBeUndefined();
    expect(retained.activationCommitAttempts).toBeUndefined();
    expect(retained.exhaustedAt).toBeUndefined();
    expect(await h.storage.get(WRAPPER_READY_AT_KEY)).toBeUndefined();
    expect(await h.storage.get(ACTIVE_WRAPPER_RUNTIME_KEY)).toBeUndefined();
    expect(h.requests()).toEqual(['drain', 'ready', 'sandbox.status']);
    expect(h.dependencies.onReady).toHaveBeenCalledOnce();
    expect(h.dependencies.onActivated).not.toHaveBeenCalled();
    expect(await loadDeadlines(h.storage)).toEqual({
      idleStop: NOW + 300_000,
      recoveryExpiry: decision.deadlineAt,
      recoveryRetry: NOW + 2_000,
    });
    expect(h.dependencies.scheduleAlarm).toHaveBeenLastCalledWith(await loadDeadlines(h.storage));

    h.dependencies.sendRequest.mockImplementation(async request => acknowledge(request));
    vi.setSystemTime(NOW + 1_999);
    expect(await h.reconstruct().reconcile(h.runtime)).toBe(false);
    expect(await h.retained()).toEqual(retained);
    vi.setSystemTime(NOW + 2_000);
    expect(await h.reconstruct().reconcile(h.runtime)).toBe(true);
    expect(h.dependencies.onReady).toHaveBeenLastCalledWith(
      identity,
      expect.objectContaining({
        episodeId: decision.episodeId,
        attempt: 3,
        deadlineAt: decision.deadlineAt,
      })
    );
    expect(await loadRecoveryDecisions(h.storage)).toEqual([]);
    expect(await loadPhysicalRecord(h.storage)).toEqual(h.physical);
  });
});

describe('createRecoveryExecution scoped recovery', () => {
  it.each(['operation_unknown', 'stop_pending'] as const)(
    'commits ready B while A remains %s and preserves authority fences across reconstruction',
    async decision => {
      const initial = recoveryDecision();
      const h = await harness(initial);
      const refreshed = authority();
      refreshed.observedAt = NOW;
      refreshed.scopes = refreshed.scopes.map(scope => ({
        ...scope,
        executionDeadlineAt: NOW + 120_000,
        authorization: scope.authorization && {
          ...scope.authorization,
          dispatchDeadlineAt: NOW + 65_000,
        },
      }));
      h.dependencies.loadAuthority.mockResolvedValue(refreshed);
      h.dependencies.reconcileStops.mockResolvedValue([
        { sessionId: rootB.sessionId, decision: 'ready' },
        {
          sessionId: rootA.sessionId,
          decision: decision === 'stop_pending' ? 'stop_pending' : 'ready',
        },
      ]);
      h.dependencies.reconcileOperations.mockResolvedValue([
        { sessionId: rootB.sessionId, decision: 'ready' },
        {
          sessionId: rootA.sessionId,
          decision: decision === 'operation_unknown' ? 'operation_unknown' : 'ready',
        },
      ]);
      expect(await h.reconstruct().reconcile(h.runtime)).toBe(true);
      expect(h.requests()).toEqual(['drain', 'ready', 'sandbox.status', 'commit']);
      expect(h.dependencies.onActivated).toHaveBeenCalledExactlyOnceWith(identity);
      const retained = await h.retained();
      expect(retained).toMatchObject({
        episodeId: initial.episodeId,
        attempt: 1,
        activationCommittedAt: NOW,
        activationAcknowledgedAt: NOW,
        nextAttemptAt: NOW + 1_000,
      });
      expect(retained.exhaustedAt).toBeUndefined();
      expect(retained.cleanupState).toBeUndefined();
      expect(retained.authority).toEqual({
        ...authority(),
        observedAt: NOW,
        roots: [{ ...rootA, decision }, rootB],
      });
      expect(admitsRecoveryRequest([retained], identity, rootA)).toBe(false);
      expect(admitsRecoveryRequest([retained], identity, rootB)).toBe(true);
      expect(
        admitsRecoveryRequest([retained], identity, { ...rootB, kiloSessionId: 'replacement' })
      ).toBe(false);
      expect(
        admitsRecoveryRequest([retained], identity, { ...rootB, directory: '/replacement' })
      ).toBe(false);
      expect(await loadPhysicalRecord(h.storage)).toEqual(h.physical);
      expect(h.dependencies.scheduleAlarm).toHaveBeenLastCalledWith({
        idleStop: NOW + 300_000,
        heartbeatExpiry: NOW + 90_000,
        recoveryExpiry: initial.deadlineAt,
        recoveryRetry: NOW + 1_000,
      });

      vi.clearAllMocks();
      vi.setSystemTime(NOW + 1_000);
      expect(await h.reconstruct().reconcile(h.runtime)).toBe(true);
      const retried = await h.retained();
      expect(retried.authority).toEqual(retained.authority);
      expect(retried).toMatchObject({
        episodeId: initial.episodeId,
        attempt: 2,
        activationAcknowledgedAt: NOW,
        nextAttemptAt: NOW + 3_000,
      });
      expect(retried.exhaustedAt).toBeUndefined();
      expect(retried.cleanupState).toBeUndefined();
      expect(h.dependencies.onReady).not.toHaveBeenCalled();
      expect(h.dependencies.sendRequest).not.toHaveBeenCalled();
      expect(admitsRecoveryRequest([retried], identity, rootA)).toBe(false);
      expect(admitsRecoveryRequest([retried], identity, rootB)).toBe(true);
      expect(await loadPhysicalRecord(h.storage)).toEqual(h.physical);
    }
  );
});
