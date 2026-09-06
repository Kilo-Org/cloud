import { describe, expect, it, vi } from 'vitest';
import type {
  RecoveryAuthority,
  RecoveryRoot,
  SandboxRecoveryDecision,
} from './control-recovery.js';
import {
  loadDeadlines,
  loadNativeRuntimeRetirements,
  loadPhysicalRecord,
  loadRecoveryDecisions,
  loadRouteTable,
  saveNativeRuntimeRetirements,
  savePhysicalRecord,
  saveRecoveryDecisions,
  saveRouteTable,
  type NativeRuntimeRetirementReceipt,
} from './durable-state.js';
import { createNativeRuntimeRetirement } from './native-runtime-retirement.js';
import type { PhysicalRecord } from './physical-lifecycle.js';
import type { SessionRoute } from './session-routes.js';
import {
  canRecoveryRetirementStopAllocation,
  createRecoveryCleanup,
  ownsRecoveryCleanupAllocation,
  RECOVERY_CLEANUP_REASON,
  selectRecoveryCleanupRoots,
} from './recovery-cleanup.js';

const connection = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  providerInstanceId: 'provider-1',
  wrapperInstanceId: '22222222-2222-4222-8222-222222222222',
};
const nativeRuntimeId = '33333333-3333-4333-8333-333333333333';
const route: SessionRoute = {
  sessionId: 'session-1',
  ownerId: 'owner-1',
  kiloSessionId: 'kilo-1',
  directory: '/workspace/a',
  nativeRuntimeId,
  retiringNativeRuntimeId: nativeRuntimeId,
  lastState: 'active',
  lastStateAt: 1,
  idleForMs: 0,
  waitingOn: 'model',
};
const root: RecoveryRoot = {
  sessionId: route.sessionId,
  ownerId: route.ownerId,
  kiloSessionId: route.kiloSessionId,
  directory: route.directory,
  nativeRuntimeId,
  observation: 'known',
  decision: 'execution_expired',
};
const physical: PhysicalRecord = {
  state: 'running',
  providerRef: connection.providerInstanceId,
  createIntent: { intentId: 'allocation-1', createdAt: 1 },
  stopTombstone: null,
  resumable: false,
};
const authority: RecoveryAuthority = {
  source: 'session_control_state',
  observedAt: 100,
  allocation: { providerRef: connection.providerInstanceId, createIntentId: 'allocation-1' },
  roots: [root],
  scopes: [
    {
      sessionId: root.sessionId,
      kiloSessionId: root.kiloSessionId,
      directory: root.directory,
      nativeRuntimeId,
      messageId: 'message-1',
      executionDeadlineAt: 200,
    },
  ],
  stops: [],
  wholeAllocation: true,
};
const decision: SandboxRecoveryDecision = {
  ...connection,
  episodeId: '44444444-4444-4444-8444-444444444444',
  cause: 'control_disconnected',
  startedAt: 100,
  deadlineAt: 200,
  attempt: 1,
  exhaustedAt: 200,
  cleanupDeadlineAt: 300,
  cleanupState: 'pending',
  authority,
};

function retirement(overrides: Partial<NativeRuntimeRetirementReceipt> = {}) {
  const receipt = createNativeRuntimeRetirement(
    physical,
    connection,
    [route],
    RECOVERY_CLEANUP_REASON,
    300,
    1_000
  );
  if (!receipt) throw new Error('Missing fixture receipt');
  return { ...receipt, ...overrides };
}

async function fixture(record: SandboxRecoveryDecision = decision) {
  const values = new Map<string, unknown>();
  const store = {
    async get<T>(key: string): Promise<T | undefined> {
      return structuredClone(values.get(key)) as T | undefined;
    },
    async put(key: string, value: unknown) {
      values.set(key, structuredClone(value));
    },
    async delete(keys: string[]) {
      return keys.filter(key => values.delete(key)).length;
    },
    async transaction<T>(run: (tx: DurableObjectTransaction) => Promise<T>): Promise<T> {
      return run(store as unknown as DurableObjectTransaction);
    },
  };
  const storage = store as unknown as Parameters<typeof createRecoveryCleanup>[0]['storage'];
  let time = 250;
  let currentConnection: typeof connection | undefined = connection;
  const retire = vi
    .fn<Parameters<typeof createRecoveryCleanup>[0]['retirement']['retire']>()
    .mockResolvedValue('pending');
  const onPhysicalStop = vi
    .fn<Parameters<typeof createRecoveryCleanup>[0]['onPhysicalStop']>()
    .mockResolvedValue(undefined);
  const scheduleAlarm = vi.fn().mockResolvedValue(undefined);
  const cleanup = createRecoveryCleanup({
    storage,
    retirement: { retire },
    getConnection: () => currentConnection,
    supportsTargetedRetirement: () => true,
    persistPhysical: (_from, to) => savePhysicalRecord(storage, to),
    onPhysicalStop,
    scheduleAlarm,
    now: () => time,
  });
  await savePhysicalRecord(storage, physical);
  await saveRouteTable(storage, new Map([[route.sessionId, route]]));
  await saveRecoveryDecisions(storage, [record]);
  return {
    cleanup,
    storage,
    retire,
    onPhysicalStop,
    scheduleAlarm,
    setTime: (value: number) => {
      time = value;
    },
    setConnection: (value: typeof connection | undefined) => {
      currentConnection = value;
    },
  };
}

describe('recovery cleanup selection', () => {
  it.each(['stop_pending', 'execution_expired'] as const)(
    'selects known %s roots without requiring an operation scope',
    state => {
      const selected = { ...root, decision: state };
      expect(
        selectRecoveryCleanupRoots({ ...authority, scopes: [], roots: [selected] }, 250)
      ).toEqual([selected]);
    }
  );

  it.each([
    { observation: 'known', decision: 'ready' },
    { observation: 'known', decision: 'operation_unknown' },
    { observation: 'unknown', decision: 'execution_expired' },
    { observation: 'stale', decision: 'stop_pending' },
    { observation: 'idle', decision: 'ready' },
    { observation: 'known' },
  ] satisfies Partial<RecoveryRoot>[])(
    'does not treat transport expiry as authority for $observation/$decision',
    state => {
      expect(
        selectRecoveryCleanupRoots(
          { ...authority, scopes: [], roots: [{ ...root, decision: undefined, ...state }] },
          999
        )
      ).toEqual([]);
    }
  );

  it('uses an original execution bound, not the failed RPC deadline, for stale ownership', () => {
    const stale = {
      ...root,
      observation: 'stale' as const,
      decision: 'operation_unknown' as const,
    };
    const uncertain = { ...authority, roots: [stale], wholeAllocation: false };
    expect(selectRecoveryCleanupRoots(uncertain, 199)).toEqual([]);
    expect(selectRecoveryCleanupRoots(uncertain, 200)).toEqual([stale]);
    expect(
      selectRecoveryCleanupRoots({ ...uncertain, roots: [{ ...stale, decision: 'ready' }] }, 200)
    ).toEqual([]);
  });

  it('retains cleanup responsibility for an idle root with a pending Stop', () => {
    const stopped = { ...root, observation: 'idle' as const, decision: 'stop_pending' as const };
    expect(selectRecoveryCleanupRoots({ ...authority, scopes: [], roots: [stopped] }, 250)).toEqual(
      [stopped]
    );
  });

  it('only selects legacy operation scopes with an expired execution deadline or Stop', () => {
    const legacy = { ...authority, roots: undefined };
    expect(selectRecoveryCleanupRoots(legacy, 199)).toEqual([]);
    expect(selectRecoveryCleanupRoots(legacy, 200)).toEqual(legacy.scopes);
  });
});

describe('targeted recovery cleanup', () => {
  it('releases stale observation gates on exact native proof without new cleanup authority', async () => {
    const f = await fixture({
      ...decision,
      authority: {
        ...authority,
        wholeAllocation: false,
        roots: [{ ...root, observation: 'stale', decision: 'operation_unknown' }],
      },
    });
    const proof = retirement({
      state: 'completed',
      disposition: 'retired',
      notificationState: 'pending',
    });
    await saveNativeRuntimeRetirements(f.storage, [proof]);
    await f.cleanup.reconcile();
    expect(await loadRecoveryDecisions(f.storage)).toEqual([]);
    expect(await loadNativeRuntimeRetirements(f.storage)).toEqual([proof]);
    expect(f.retire).not.toHaveBeenCalled();
    expect(f.onPhysicalStop).not.toHaveBeenCalled();
  });

  it.each(['pending', 'exhausted', 'delivered'] as const)(
    'releases gates and the episode on exact proof with %s notifications, retaining replay',
    async notificationState => {
      const f = await fixture();
      const receipt = retirement({ state: 'completed', disposition: 'retired', notificationState });
      await saveNativeRuntimeRetirements(f.storage, [receipt]);
      await f.cleanup.reconcile();
      expect(await loadRecoveryDecisions(f.storage)).toEqual([]);
      const released = (await loadRouteTable(f.storage)).get(route.sessionId);
      expect(released?.nativeRuntimeId).toBeUndefined();
      expect(released?.retiringNativeRuntimeId).toBeUndefined();
      expect(await loadNativeRuntimeRetirements(f.storage)).toEqual([receipt]);
      expect((await loadDeadlines(f.storage)).recoveryRetry).toBeUndefined();
      expect(f.retire).not.toHaveBeenCalled();
      expect(f.onPhysicalStop).not.toHaveBeenCalled();
    }
  );

  it('preserves the original cleanup deadline through retries and notification failure', async () => {
    const f = await fixture();
    await f.cleanup.reconcile();
    expect(f.retire.mock.calls[0]?.[0].cleanupDeadlineAt).toBe(300);
    f.setTime(275);
    f.retire.mockImplementationOnce(async () => {
      await saveNativeRuntimeRetirements(f.storage, [
        retirement({ state: 'completed', disposition: 'retired' }),
      ]);
      throw new Error('Session notification failed');
    });
    await f.cleanup.reconcile();
    expect(f.retire.mock.calls[1]?.[0].cleanupDeadlineAt).toBe(300);
    expect(await loadRecoveryDecisions(f.storage)).toEqual([]);
    expect(f.onPhysicalStop).not.toHaveBeenCalled();
  });

  it.each([
    { allocation: { providerRef: 'provider-1', createIntentId: 'older-allocation' } },
    { connection: { ...connection, wrapperInstanceId: '55555555-5555-4555-8555-555555555555' } },
    { nativeRuntimeId: '66666666-6666-4666-8666-666666666666' },
    { disposition: 'operation_only' as const },
    { recipients: [{ ...root, ownerId: 'other-owner' }] },
  ])('rejects non-exact retirement proof %#', async mismatch => {
    const f = await fixture();
    await saveNativeRuntimeRetirements(f.storage, [
      retirement({ state: 'completed', disposition: 'retired', ...mismatch }),
    ]);
    await f.cleanup.reconcile();
    expect((await loadRecoveryDecisions(f.storage))[0]?.cleanupState).toBe('targeted');
    expect((await loadRouteTable(f.storage)).get(route.sessionId)?.nativeRuntimeId).toBe(
      nativeRuntimeId
    );
  });

  it('uses old exact proof after reconnect without retargeting a replacement route', async () => {
    const f = await fixture();
    const replacement = { ...route, nativeRuntimeId: '77777777-7777-4777-8777-777777777777' };
    await saveRouteTable(f.storage, new Map([[route.sessionId, replacement]]));
    f.setConnection({ ...connection, connectionId: '88888888-8888-4888-8888-888888888888' });
    await saveNativeRuntimeRetirements(f.storage, [
      retirement({ state: 'completed', disposition: 'retired' }),
    ]);
    await f.cleanup.reconcile();
    expect(await loadRecoveryDecisions(f.storage)).toEqual([]);
    expect((await loadRouteTable(f.storage)).get(route.sessionId)).toEqual(replacement);
    expect(f.retire).not.toHaveBeenCalled();
  });

  it('releases proven roots but retains uncertain sibling authority', async () => {
    const unknown = {
      ...root,
      sessionId: 'session-2',
      directory: '/workspace/b',
      observation: 'unknown' as const,
      decision: undefined,
    };
    const f = await fixture({
      ...decision,
      authority: { ...authority, roots: [root, unknown], wholeAllocation: false },
    });
    await saveNativeRuntimeRetirements(f.storage, [
      retirement({ state: 'completed', disposition: 'retired' }),
    ]);
    await f.cleanup.reconcile();
    const current = (await loadRecoveryDecisions(f.storage))[0];
    expect(current?.cleanupState).toBe('unconfirmed');
    expect(current?.authority?.roots).toEqual([
      { ...root, observation: 'idle', decision: 'ready' },
      unknown,
    ]);
    expect(
      (await loadRouteTable(f.storage)).get(route.sessionId)?.retiringNativeRuntimeId
    ).toBeUndefined();
    expect(f.onPhysicalStop).not.toHaveBeenCalled();
  });

  it('rechecks root authority after retiring another native runtime', async () => {
    const sibling = {
      ...root,
      sessionId: 'session-2',
      kiloSessionId: 'kilo-2',
      directory: '/workspace/b',
      nativeRuntimeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };
    const f = await fixture({ ...decision, authority: { ...authority, roots: [root, sibling] } });
    await saveRouteTable(
      f.storage,
      new Map([
        [route.sessionId, route],
        [sibling.sessionId, { ...route, ...sibling }],
      ])
    );
    f.retire.mockImplementationOnce(async () => {
      await saveRecoveryDecisions(f.storage, [
        {
          ...decision,
          authority: { ...authority, roots: [root, { ...sibling, decision: 'ready' }] },
        },
      ]);
      return 'pending';
    });
    await f.cleanup.reconcile();
    expect(f.retire).toHaveBeenCalledOnce();
    expect(f.retire.mock.calls[0]?.[0].route.sessionId).toBe(root.sessionId);
    expect(f.onPhysicalStop).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'protects a ready sibling with its route still attached: %s',
    async attached => {
      const sibling = {
        ...root,
        sessionId: 'session-2',
        kiloSessionId: 'kilo-2',
        decision: 'ready' as const,
      };
      const f = await fixture({ ...decision, authority: { ...authority, roots: [root, sibling] } });
      await saveRouteTable(
        f.storage,
        new Map([
          [route.sessionId, route],
          [sibling.sessionId, { ...route, ...sibling }],
        ])
      );
      if (!attached) await saveRouteTable(f.storage, new Map([[route.sessionId, route]]));
      await f.cleanup.reconcile();
      f.setTime(300);
      await f.cleanup.reconcile();
      expect(f.retire).not.toHaveBeenCalled();
      expect(f.onPhysicalStop).not.toHaveBeenCalled();
      expect((await loadRecoveryDecisions(f.storage))[0]?.cleanupState).toBe('unconfirmed');
    }
  );
});

describe('recovery physical fallback', () => {
  it('commits a stop before entering physical fallback even with pending native cleanup', async () => {
    const f = await fixture();
    await saveNativeRuntimeRetirements(f.storage, [retirement()]);
    f.setTime(300);
    await f.cleanup.reconcile();
    expect((await loadPhysicalRecord(f.storage)).stopTombstone).toMatchObject({
      reason: RECOVERY_CLEANUP_REASON,
      attempts: 0,
    });
    expect((await loadRecoveryDecisions(f.storage))[0]?.cleanupState).toBe('physical_fallback');
    expect(f.onPhysicalStop).toHaveBeenCalledOnce();
    expect(f.retire).not.toHaveBeenCalled();
    await f.cleanup.reconcile();
    expect(f.onPhysicalStop).toHaveBeenCalledOnce();
  });

  it('ends denied fallback without a perpetual cleanup alarm or an invented stop', async () => {
    const f = await fixture({
      ...decision,
      authority: { ...authority, wholeAllocation: false },
      cleanupState: 'physical_fallback',
    });
    await saveNativeRuntimeRetirements(f.storage, [retirement()]);
    f.setTime(300);
    await f.cleanup.reconcile();
    expect((await loadRecoveryDecisions(f.storage))[0]?.cleanupState).toBe('unconfirmed');
    expect((await loadNativeRuntimeRetirements(f.storage))[0]?.state).toBe('unconfirmed');
    expect((await loadDeadlines(f.storage)).recoveryRetry).toBeUndefined();
    expect((await loadPhysicalRecord(f.storage)).stopTombstone).toBeNull();
    expect(f.onPhysicalStop).not.toHaveBeenCalled();
  });

  it.each(['allocation', 'route', 'owner', 'wrapper', 'authority'] as const)(
    'revalidates %s changes after a targeted await',
    async change => {
      const f = await fixture();
      f.retire.mockImplementationOnce(async () => {
        f.setTime(300);
        if (change === 'allocation')
          await savePhysicalRecord(f.storage, {
            ...physical,
            createIntent: { intentId: 'replacement', createdAt: 275 },
          });
        if (change === 'route')
          await saveRouteTable(
            f.storage,
            new Map([
              [route.sessionId, route],
              ['new-session', { ...route, sessionId: 'new-session', directory: '/workspace/new' }],
            ])
          );
        if (change === 'owner')
          await saveRouteTable(
            f.storage,
            new Map([[route.sessionId, { ...route, ownerId: 'other-owner' }]])
          );
        if (change === 'wrapper')
          f.setConnection({
            ...connection,
            wrapperInstanceId: '99999999-9999-4999-8999-999999999999',
          });
        if (change === 'authority')
          await saveRecoveryDecisions(f.storage, [
            { ...decision, authority: { ...authority, roots: [{ ...root, decision: 'ready' }] } },
          ]);
        return 'pending';
      });
      await f.cleanup.reconcile();
      expect((await loadPhysicalRecord(f.storage)).stopTombstone).toBeNull();
      expect((await loadRecoveryDecisions(f.storage))[0]?.cleanupState).toBe('unconfirmed');
      expect(f.onPhysicalStop).not.toHaveBeenCalled();
    }
  );

  it('requires exact allocation and whole-allocation ownership in PR4 escalation', () => {
    const routes = new Map([[route.sessionId, route]]);
    expect(
      canRecoveryRetirementStopAllocation(retirement(), [decision], physical, routes, 300)
    ).toBe(true);
    expect(
      canRecoveryRetirementStopAllocation(
        retirement({ cleanupDeadlineAt: 301 }),
        [decision],
        physical,
        routes,
        300
      )
    ).toBe(false);
    expect(
      ownsRecoveryCleanupAllocation(
        decision,
        { ...physical, createIntent: { intentId: 'replacement', createdAt: 250 } },
        routes,
        300
      )
    ).toBe(false);
    expect(
      ownsRecoveryCleanupAllocation(
        { ...decision, authority: { ...authority, roots: [{ ...root, observation: 'unknown' }] } },
        physical,
        routes,
        300
      )
    ).toBe(false);
  });
});

describe('recovery exhaustion persistence', () => {
  it('keeps the original cleanup deadline and exhausts only due episodes', async () => {
    const f = await fixture({ ...decision, exhaustedAt: undefined, cleanupState: undefined });
    await f.cleanup.exhaustExpired(199);
    expect((await loadRecoveryDecisions(f.storage))[0]?.exhaustedAt).toBeUndefined();
    await f.cleanup.exhaustExpired(200);
    await f.cleanup.exhaustExpired(275);
    expect((await loadRecoveryDecisions(f.storage))[0]).toMatchObject({
      exhaustedAt: 200,
      cleanupDeadlineAt: 300,
    });
  });

  it('uses activation repair expiry rather than the expired transport deadline', async () => {
    const f = await fixture({
      ...decision,
      exhaustedAt: undefined,
      cleanupState: undefined,
      activationCommittedAt: 190,
      activationCommitDeadlineAt: 290,
    });
    await f.cleanup.exhaustExpired(250);
    expect((await loadRecoveryDecisions(f.storage))[0]?.exhaustedAt).toBeUndefined();
    await f.cleanup.exhaustExpired(290);
    expect((await loadRecoveryDecisions(f.storage))[0]?.exhaustedAt).toBe(290);
  });
});
