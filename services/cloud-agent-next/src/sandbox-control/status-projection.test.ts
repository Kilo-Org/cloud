import { describe, expect, it, vi } from 'vitest';
import {
  projectReportedStatus,
  projectSandboxStatus,
  summarizeHeartbeatIdle,
} from './status-projection.js';
import { DEADLINE_MS } from './deadlines.js';
import { readSandboxControlState, type StoredSandboxControlState } from './durable-state.js';
import type { PhysicalRecord } from './physical-lifecycle.js';
import type { SessionRoute } from './session-routes.js';
import type { SandboxControlConnectionObservation } from './socket.js';
import type { SandboxHeartbeatPayload } from '../shared/sandbox-control-protocol.js';
import { SandboxStatusSnapshotSchema } from '../shared/sandbox-status.js';

describe('projectReportedStatus', () => {
  it('reports off when physical is stopped', () => {
    expect(
      projectReportedStatus({ physical: 'stopped', connection: 'ready', work: 'active' })
    ).toBe('off');
  });

  it('reports booting while creating, including when disconnected', () => {
    expect(
      projectReportedStatus({
        physical: 'creating',
        connection: 'disconnected',
        work: 'idle',
      })
    ).toBe('booting');
  });

  it('reports booting while running but only connected', () => {
    expect(
      projectReportedStatus({
        physical: 'running',
        connection: 'connected',
        work: 'idle',
      })
    ).toBe('booting');
  });

  it('reports ready when running, ready, and idle', () => {
    expect(projectReportedStatus({ physical: 'running', connection: 'ready', work: 'idle' })).toBe(
      'ready'
    );
  });

  it('reports working when running, ready, and active', () => {
    expect(
      projectReportedStatus({ physical: 'running', connection: 'ready', work: 'active' })
    ).toBe('working');
  });

  it('reports finalizing when running, ready, and finalizing', () => {
    expect(
      projectReportedStatus({
        physical: 'running',
        connection: 'ready',
        work: 'finalizing',
      })
    ).toBe('finalizing');
  });

  it('reports degraded when running and disconnected', () => {
    expect(
      projectReportedStatus({
        physical: 'running',
        connection: 'disconnected',
        work: 'active',
      })
    ).toBe('degraded');
  });

  it('reports shutting-down when physical is stopping', () => {
    expect(
      projectReportedStatus({
        physical: 'stopping',
        connection: 'ready',
        work: 'idle',
      })
    ).toBe('shutting-down');
  });

  it('reports failed when physical is failed', () => {
    expect(projectReportedStatus({ physical: 'failed', connection: 'ready', work: 'idle' })).toBe(
      'failed'
    );
  });

  it('reports unknown when physical is unknown', () => {
    expect(projectReportedStatus({ physical: 'unknown', connection: 'ready', work: 'idle' })).toBe(
      'unknown'
    );
  });
});

const now = 1_000_000;
const receivedAt = now - 1_000;
const ownerId = 'owner_1';
const physical: PhysicalRecord = {
  state: 'running',
  providerRef: 'instance_1',
  createIntent: null,
  stopTombstone: null,
  resumable: false,
};
const route: SessionRoute = {
  sessionId: 'workspace_1',
  kiloSessionId: 'kilo_1',
  directory: '/workspace/one',
  ownerId,
  lastState: 'idle',
  lastStateAt: receivedAt,
  idleForMs: 0,
  waitingOn: null,
};
const idleHeartbeat: SandboxHeartbeatPayload = {
  state: 'idle',
  pendingMessages: 0,
  kilo: { ready: true },
  sessions: [{ kiloSessionId: route.kiloSessionId, state: 'idle', idleForMs: 0 }],
};

async function fixture() {
  const connection = {
    state: 'connected',
    acceptedAt: now - 10_000,
    observation: { ready: true, receivedAt, idle: await summarizeHeartbeatIdle(idleHeartbeat) },
  } satisfies SandboxControlConnectionObservation;
  return {
    stored: {
      physical: { ...physical },
      routes: [{ ...route }],
      deadlines: {
        idleStop: receivedAt + DEADLINE_MS.idleStop,
        heartbeatExpiry: receivedAt + DEADLINE_MS.heartbeatExpiry,
      },
    } satisfies StoredSandboxControlState,
    connection,
    ownerId,
    provider: 'cloudflare',
    now,
  };
}

describe('passive sandbox status projection', () => {
  it.each(['running', 'stopped', 'creating', 'stopping', 'unknown', 'failed'] as const)(
    'projects retained metadata for %s without changing lifecycle freshness',
    async state => {
      const input = await fixture();
      const runtime = {
        sandboxType: 'isolated-standard' as const,
        wrapperVersion: '2.4.0',
        kiloCliVersion: '7.4.20',
        startedAt: null,
        stoppedAt: null,
      };
      const stored = { ...input.stored, physical: { ...physical, state }, runtime };
      const before = structuredClone(stored);
      const result = await projectSandboxStatus({
        ...input,
        stored,
        connection: { state: 'disconnected' },
      });
      expect(result.runtime).toEqual(runtime);
      expect(result.estimatedSleepAt).toBeNull();
      if (state === 'running') expect(result.status).toBe('unreachable');
      expect(await projectSandboxStatus({ ...input, stored, ownerId: null })).not.toHaveProperty(
        'runtime'
      );
      expect(
        await projectSandboxStatus({ ...input, stored: { ...stored, physical: null } })
      ).not.toHaveProperty('runtime');
      expect(stored).toEqual(before);
    }
  );

  it.each([
    ['stopped', 'sleeping', 'sandbox_stopped'],
    ['creating', 'starting', 'sandbox_starting'],
    ['stopping', 'stopping', 'sandbox_stopping'],
    ['failed', 'error', 'sandbox_failed'],
    ['unknown', 'unknown', 'insufficient_evidence'],
  ] as const)(
    'maps confirmed %s to %s regardless of connection and work',
    async (state, status, detailCode) => {
      const input = await fixture();
      input.stored.physical.state = state;
      input.stored.routes[0] = { ...route, lastState: 'active' };
      const result = await projectSandboxStatus(input);
      expect(result).toEqual({
        status,
        detailCode,
        provider: 'Cloudflare',
        observedAt: now,
        inactivityTimeoutMs: DEADLINE_MS.idleStop,
        estimatedSleepAt: null,
      });
      expect(SandboxStatusSnapshotSchema.safeParse(result).success).toBe(true);
    }
  );

  it('does not synthesize stopped state from missing records or owners', async () => {
    const input = await fixture();
    expect(
      await projectSandboxStatus({ ...input, stored: { ...input.stored, physical: null } })
    ).toMatchObject({ status: 'unknown', estimatedSleepAt: null });
    expect(await projectSandboxStatus({ ...input, ownerId: null })).toMatchObject({
      status: 'unknown',
      estimatedSleepAt: null,
    });
    expect(
      await projectSandboxStatus({
        ...input,
        stored: { ...input.stored, physical: { ...physical, providerRef: null } },
      })
    ).toMatchObject({ status: 'unknown', estimatedSleepAt: null });
  });

  it('requires explicit fresh ready evidence, including false and exact expiry', async () => {
    const input = await fixture();
    const project = (connection: SandboxControlConnectionObservation) =>
      projectSandboxStatus({ ...input, connection });
    expect(await project({ state: 'unknown' })).toMatchObject({
      status: 'unknown',
      estimatedSleepAt: null,
    });
    expect(await project({ state: 'disconnected' })).toMatchObject({
      status: 'unreachable',
      detailCode: 'connection_unavailable',
      estimatedSleepAt: null,
    });
    expect(
      await project({
        ...input.connection,
        observation: { ...input.connection.observation, ready: false },
      })
    ).toMatchObject({ status: 'starting', detailCode: 'sandbox_starting', estimatedSleepAt: null });
    for (const ready of [true, false]) {
      expect(
        await project({
          ...input.connection,
          observation: { ready, receivedAt: now - DEADLINE_MS.heartbeatExpiry, idle: null },
        })
      ).toMatchObject({ status: 'unreachable', estimatedSleepAt: null });
    }
    expect(
      await project({
        ...input.connection,
        observation: { ready: true, receivedAt: now + 1, idle: null },
      })
    ).toMatchObject({ status: 'unknown', estimatedSleepAt: null });
    expect(
      await project({
        ...input.connection,
        observation: { ready: true, receivedAt: now - DEADLINE_MS.heartbeatExpiry + 1, idle: null },
      })
    ).toMatchObject({ status: 'active', estimatedSleepAt: null });
  });

  it('uses only the stored future deadline with coherent current-connection sandbox-wide idle evidence', async () => {
    const input = await fixture();
    const result = await projectSandboxStatus(input);
    expect(result).toEqual({
      status: 'active',
      detailCode: 'sandbox_ready',
      provider: 'Cloudflare',
      observedAt: now,
      inactivityTimeoutMs: DEADLINE_MS.idleStop,
      estimatedSleepAt: input.stored.deadlines.idleStop,
    });
    expect(SandboxStatusSnapshotSchema.safeParse(result).success).toBe(true);
    expect(await projectSandboxStatus({ ...input, provider: 'vercel' })).toMatchObject({
      provider: 'Vercel',
      estimatedSleepAt: input.stored.deadlines.idleStop,
    });
    expect(
      await projectSandboxStatus({ ...input, provider: 'private-provider-sentinel' })
    ).toMatchObject({ provider: 'Unknown' });
    expect(JSON.stringify(result)).not.toMatch(/instance_1|owner_1|workspace_1|kilo_1/);
  });

  it.each([
    null,
    {},
    { idleStop: now - 1 },
    { idleStop: now },
    { idleStop: now + DEADLINE_MS.idleStop + 1 },
    { idleStop: now - 20_000 + DEADLINE_MS.idleStop },
  ])('suppresses unsupported, expired, and inherited deadlines: %j', async deadlines => {
    const input = await fixture();
    expect(
      await projectSandboxStatus({ ...input, stored: { ...input.stored, deadlines } })
    ).toMatchObject({ status: 'active', estimatedSleepAt: null });
  });

  it('suppresses estimates when only readiness, not a current idle heartbeat, was received', async () => {
    const input = await fixture();
    input.connection.observation.idle = null;
    expect(await projectSandboxStatus(input)).toMatchObject({
      status: 'active',
      estimatedSleepAt: null,
    });
  });

  it.each([
    { lastState: 'active' },
    { lastState: 'finalizing' },
    { waitingOn: 'preparation' },
    { waitingOn: 'input' },
    { lastState: null },
    { lastStateAt: null },
    { lastStateAt: receivedAt - 1 },
    { lastStateAt: now + 1 },
    { idleForMs: null },
    { waitingOn: 'model' },
    { waitingOn: 'tool' },
    { waitingOn: 'finalizing' },
    { ownerId: 'other-owner' },
    { kiloSessionId: 'other-kilo' },
  ] satisfies Partial<SessionRoute>[])(
    'suppresses estimates for incomplete or contradictory route evidence: %j',
    async patch => {
      const input = await fixture();
      input.stored.routes[0] = { ...route, ...patch };
      expect(await projectSandboxStatus(input)).toMatchObject({
        status: 'active',
        estimatedSleepAt: null,
      });
    }
  );

  it('requires complete coverage of every shared-sandbox route', async () => {
    const input = await fixture();
    const sibling = {
      ...route,
      sessionId: 'workspace_2',
      kiloSessionId: 'kilo_2',
      directory: '/workspace/two',
    };
    input.stored.routes.push(sibling);
    expect(await projectSandboxStatus(input)).toMatchObject({ estimatedSleepAt: null });
    input.connection.observation.idle = await summarizeHeartbeatIdle({
      ...idleHeartbeat,
      sessions: [
        { kiloSessionId: 'kilo_2', state: 'idle', idleForMs: 0 },
        ...idleHeartbeat.sessions,
      ],
    });
    expect(await projectSandboxStatus(input)).toMatchObject({
      estimatedSleepAt: input.stored.deadlines.idleStop,
    });
    input.stored.routes[1] = { ...sibling, lastState: 'active' };
    expect(await projectSandboxStatus(input)).toMatchObject({ estimatedSleepAt: null });
    input.stored.routes[1] = { ...route };
    expect(await projectSandboxStatus(input)).toMatchObject({ estimatedSleepAt: null });
    expect(
      await projectSandboxStatus({ ...input, stored: { ...input.stored, routes: null } })
    ).toMatchObject({ estimatedSleepAt: null });
  });

  it('projects same-directory sibling roots only with coherent worktree ownership and idle evidence', async () => {
    const input = await fixture();
    const first = { ...route, worktreeId: 'worktree_shared' };
    const sibling = { ...first, sessionId: 'workspace_2', kiloSessionId: 'kilo_2' };
    const values = {
      physical_record: physical,
      deadlines: input.stored.deadlines,
      session_routes: [first, sibling],
    };
    const stored = await readSandboxControlState({
      get: async key => values[key as keyof typeof values],
    });
    input.connection.observation.idle = await summarizeHeartbeatIdle({
      ...idleHeartbeat,
      sessions: [
        ...idleHeartbeat.sessions,
        { kiloSessionId: 'kilo_2', state: 'idle', idleForMs: 0 },
      ],
    });
    expect(await projectSandboxStatus({ ...input, stored })).toMatchObject({
      status: 'active',
      estimatedSleepAt: input.stored.deadlines.idleStop,
    });
    for (const patch of [
      { worktreeId: 'worktree_other' },
      { worktreeId: undefined },
      { directory: '/workspace/other' },
      { ownerId: 'other-owner' },
      { waitingOn: 'input' },
      { waitingOn: 'preparation' },
    ] satisfies Partial<SessionRoute>[]) {
      expect(
        await projectSandboxStatus({
          ...input,
          stored: { ...stored, routes: [first, { ...sibling, ...patch }] },
        })
      ).toMatchObject({ status: 'active', estimatedSleepAt: null });
    }
  });

  it('does not report a tombstoned running allocation as active', async () => {
    const input = await fixture();
    input.stored.physical.stopTombstone = { reason: 'retired', attempts: 0, createdAt: now };
    expect(await projectSandboxStatus(input)).toMatchObject({
      status: 'stopping',
      estimatedSleepAt: null,
    });
  });

  it('permits an observed empty sandbox but not a missing route table', async () => {
    const input = await fixture();
    input.stored.routes = [];
    input.connection.observation.idle = await summarizeHeartbeatIdle({
      ...idleHeartbeat,
      sessions: [],
    });
    expect(await projectSandboxStatus(input)).toMatchObject({
      estimatedSleepAt: input.stored.deadlines.idleStop,
    });
    expect(
      await projectSandboxStatus({ ...input, stored: { ...input.stored, routes: null } })
    ).toMatchObject({ estimatedSleepAt: null });
  });
});

describe('bounded heartbeat idle summaries', () => {
  it.each([
    { state: 'active' },
    { state: 'finalizing' },
    { pendingMessages: undefined },
    { pendingMessages: 1 },
    { activeKiloSessions: 1 },
    { kilo: { ready: false } },
    { sessions: [{ kiloSessionId: 'kilo_1', state: 'active', idleForMs: 180_000 }] },
    { sessions: [{ kiloSessionId: 'kilo_1', state: 'finalizing', idleForMs: 0 }] },
    { sessions: [{ kiloSessionId: 'kilo_1', state: 'idle', idleForMs: 0, waitingOn: 'tool' }] },
    { sessions: [...idleHeartbeat.sessions, ...idleHeartbeat.sessions] },
  ] satisfies Partial<SandboxHeartbeatPayload>[])(
    'rejects busy or incomplete sandbox-wide evidence: %j',
    async patch => {
      expect(await summarizeHeartbeatIdle({ ...idleHeartbeat, ...patch })).toBeNull();
    }
  );
});

describe('validation-only control storage reads', () => {
  function storage(values: Record<string, unknown>) {
    return {
      get: vi.fn(async (key: string) => values[key]),
      put: vi.fn(),
      delete: vi.fn(),
    };
  }

  it('returns null instead of synthetic sleeping or repaired values', async () => {
    const target = storage({});
    expect(await readSandboxControlState(target)).toEqual({
      physical: null,
      routes: null,
      deadlines: null,
    });
    expect(target.put).not.toHaveBeenCalled();
    expect(target.delete).not.toHaveBeenCalled();
  });

  it.each([
    { physical_record: { state: 'stopped' } },
    { physical_record: { ...physical, state: 'unsupported' } },
    { physical_record: { ...physical, providerRef: 10 } },
    { physical_record: { ...physical, createIntent: { intentId: 'intent', createdAt: Infinity } } },
    { deadlines: { idleStop: NaN } },
    { deadlines: { idleStop: Infinity } },
    { deadlines: { idleStop: -1 } },
    { deadlines: { idleStop: 1.5 } },
    { deadlines: { idleStop: '1000000' } },
    { deadlines: { idleStop: 8_640_000_000_000_001 } },
    { session_routes: [{ ...route, lastStateAt: NaN }] },
    { session_routes: [{ ...route, worktreeId: 42 }] },
    { session_routes: {} },
  ])('does not accept or repair malformed stored evidence: %j', async values => {
    const target = storage(values);
    expect(await readSandboxControlState(target)).toEqual({
      physical: null,
      routes: null,
      deadlines: null,
    });
    expect(target.put).not.toHaveBeenCalled();
    expect(target.delete).not.toHaveBeenCalled();
  });

  it('preserves valid storage and strips unrelated fields from the projection inputs', async () => {
    const values = {
      physical_record: { ...physical, internal: 'private-value' },
      session_routes: [{ ...route, internal: 'private-value' }],
      deadlines: { idleStop: now + DEADLINE_MS.idleStop },
    };
    const before = structuredClone(values);
    const target = storage(values);
    expect(await readSandboxControlState(target)).toEqual({
      physical,
      routes: [route],
      deadlines: values.deadlines,
    });
    expect(values).toEqual(before);
    expect(target.put).not.toHaveBeenCalled();
    expect(target.delete).not.toHaveBeenCalled();
  });
});
