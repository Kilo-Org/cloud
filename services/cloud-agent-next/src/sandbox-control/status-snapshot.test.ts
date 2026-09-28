import { describe, expect, it } from 'vitest';
import {
  SandboxStatusSnapshotSchema,
  type SandboxStatusSnapshot,
} from '../shared/sandbox-status.js';
import type { AllocationRecord, AllocationTarget } from '../sandbox-state/model/allocation.js';
import { allocationRecordSchema } from '../sandbox-state/model/allocation.js';
import { POLICY } from '../sandbox-state/schedule.js';
import type { SessionRoute } from './session-routes.js';
import type { SandboxControlConnectionObservation } from './socket.js';
import { projectStatusSnapshot } from './status-snapshot.js';
import { sha256Hex } from '../utils/sha256.js';

const NOW = 1_000_000;
const INC = 'inc-1';
const OWNER = 'owner-1';

const CAPS: AllocationTarget['capabilities'] = {
  persistentWorkspace: false,
  destroysOnStop: true,
};
const TARGET: AllocationTarget = {
  provider: 'cloudflare',
  providerRef: 'ref-1',
  capabilities: CAPS,
};
const INTENT_ID = 'intent-1';
const INTENT = { intentId: INTENT_ID, createdAt: NOW - 5_000 };

const CONNECTED: SandboxControlConnectionObservation = {
  state: 'connected',
  acceptedAt: NOW - 10_000,
  observation: { ready: true, receivedAt: NOW - 1_000, idle: null },
};

function stopped(): AllocationRecord {
  return { v: 2, resumable: true, state: { kind: 'stopped', summary: null } };
}

function creating(): AllocationRecord {
  return {
    v: 2,
    resumable: true,
    state: {
      kind: 'creating',
      requestId: 'req-1',
      target: TARGET,
      createIntent: INTENT,
      attempt: 1,
      deadlineAt: NOW + POLICY.createDeadlineMs,
    },
  };
}

function allocated(
  health: Extract<AllocationRecord['state'], { kind: 'allocated' }>['health'],
  idleAt: number | null = null
): AllocationRecord {
  return {
    v: 2,
    resumable: true,
    state: { kind: 'allocated', target: TARGET, createIntent: INTENT, health, idleAt },
  };
}

function healthy(overrides: { deadlineAt?: number; ready?: boolean } = {}) {
  return {
    kind: 'healthy' as const,
    incarnation: INC,
    lastHeartbeat: { incarnation: INC, at: NOW - 1_000, ready: overrides.ready ?? true },
    deadlineAt: overrides.deadlineAt ?? NOW + POLICY.heartbeatExpiryMs,
  };
}

function stoppingDestroying(): AllocationRecord {
  return {
    v: 2,
    resumable: true,
    state: {
      kind: 'stopping',
      target: TARGET,
      createIntent: INTENT,
      stopIntent: { reason: 'idle', createdAt: NOW - 1_000, incarnation: INC },
      step: 'destroying',
      attempts: 0,
      deadlineAt: NOW + POLICY.stopDeadlineMs,
    },
  };
}

/** `check_required` carries no deadline field (`stoppingCheckRequiredStateSchema`). */
function stoppingCheckRequired(): AllocationRecord {
  return {
    v: 2,
    resumable: true,
    state: {
      kind: 'stopping',
      target: TARGET,
      createIntent: INTENT,
      stopIntent: { reason: 'idle', createdAt: NOW - 1_000, incarnation: INC },
      step: 'check_required',
      attempts: 5,
    },
  };
}

function unknown(): AllocationRecord {
  return {
    v: 2,
    resumable: true,
    state: {
      kind: 'unknown',
      target: TARGET,
      createIntent: INTENT,
      stopIntent: null,
      attempts: 0,
      reason: 'lost',
      deadlineAt: NOW + POLICY.observeDeadlineMs,
    },
  };
}

async function project(
  allocation: AllocationRecord | null,
  options: {
    ownerId?: string | null;
    connection?: SandboxControlConnectionObservation;
    routes?: readonly SessionRoute[] | null;
    now?: number;
  } = {}
): Promise<SandboxStatusSnapshot> {
  return projectStatusSnapshot({
    allocation,
    ownerId: options.ownerId === undefined ? OWNER : options.ownerId,
    provider: 'cloudflare',
    routes: options.routes ?? null,
    connection: options.connection ?? CONNECTED,
    now: options.now ?? NOW,
  });
}

describe('status snapshot — valid public projection', () => {
  it('projects every canonical state to a schema-valid snapshot', async () => {
    const records: AllocationRecord[] = [
      stopped(),
      creating(),
      stoppingDestroying(),
      stoppingCheckRequired(),
      unknown(),
      allocated({
        kind: 'connecting',
        incarnation: INC,
        deadlineAt: NOW + POLICY.connectingDeadlineMs,
      }),
      allocated({
        kind: 'recovering',
        incarnation: INC,
        step: 'check_sandbox',
        attempts: 1,
        deadlineAt: NOW + POLICY.recoveryDeadlineMs,
        episodeId: '11111111-1111-4111-8111-111111111111',
        cause: 'activation_pending',
      }),
      allocated({
        kind: 'recovering',
        incarnation: INC,
        step: 'reconnect_wrapper',
        attempts: 2,
        deadlineAt: NOW + POLICY.recoveryDeadlineMs,
        episodeId: '11111111-1111-4111-8111-111111111111',
        cause: 'activation_pending',
      }),
      allocated(healthy()),
      allocated({ kind: 'unhealthy', incarnation: INC, verdict: 'absent' }),
      allocated({ kind: 'unhealthy', incarnation: INC, verdict: 'unresponsive' }),
    ];
    for (const record of records) {
      expect(() => allocationRecordSchema.parse(record)).not.toThrow();
      const snapshot = await project(record);
      expect(() => SandboxStatusSnapshotSchema.parse(snapshot)).not.toThrow();
    }
    const nullSnapshot = await project(null);
    expect(() => SandboxStatusSnapshotSchema.parse(nullSnapshot)).not.toThrow();
  });

  it('maps lifecycle states to their public label/detail pair', async () => {
    await expect(project(stopped())).resolves.toMatchObject({
      status: 'sleeping',
      detailCode: 'sandbox_stopped',
    });
    await expect(project(creating())).resolves.toMatchObject({
      status: 'starting',
      detailCode: 'sandbox_starting',
    });
    await expect(project(stoppingDestroying())).resolves.toMatchObject({
      status: 'stopping',
      detailCode: 'sandbox_stopping',
    });
    await expect(project(unknown())).resolves.toMatchObject({
      status: 'unknown',
      detailCode: 'insufficient_evidence',
    });
  });

  it('reports a healthy connected allocation as active', async () => {
    const snapshot = await project(allocated(healthy()));
    expect(snapshot).toMatchObject({
      status: 'active',
      detailCode: 'sandbox_ready',
      provider: 'Cloudflare',
      observedAt: NOW,
      inactivityTimeoutMs: POLICY.idleStopMs,
    });
  });

  it('reports connecting and recovering allocations as starting and unreachable', async () => {
    await expect(
      project(
        allocated({
          kind: 'connecting',
          incarnation: INC,
          deadlineAt: NOW + POLICY.connectingDeadlineMs,
        })
      )
    ).resolves.toMatchObject({ status: 'starting', detailCode: 'sandbox_starting' });
    await expect(
      project(
        allocated({
          kind: 'recovering',
          incarnation: INC,
          step: 'check_sandbox',
          attempts: 1,
          deadlineAt: NOW + POLICY.recoveryDeadlineMs,
          episodeId: '11111111-1111-4111-8111-111111111111',
          cause: 'activation_pending',
        })
      )
    ).resolves.toMatchObject({ status: 'unreachable', detailCode: 'connection_unavailable' });
  });

  it('maps the unhealthy verdicts to failure and stopping', async () => {
    await expect(
      project(allocated({ kind: 'unhealthy', incarnation: INC, verdict: 'absent' }))
    ).resolves.toMatchObject({ status: 'error', detailCode: 'sandbox_failed' });
    await expect(
      project(allocated({ kind: 'unhealthy', incarnation: INC, verdict: 'unresponsive' }))
    ).resolves.toMatchObject({ status: 'stopping', detailCode: 'sandbox_stopping' });
  });

  it('treats a disconnected connection as unreachable', async () => {
    await expect(
      project(allocated(healthy()), { connection: { state: 'disconnected' } })
    ).resolves.toMatchObject({ status: 'unreachable', detailCode: 'connection_unavailable' });
  });

  it('emits canonical check_needed once the health deadline has passed', async () => {
    await expect(project(allocated(healthy({ deadlineAt: NOW - 1 })))).resolves.toMatchObject({
      status: 'unreachable',
      detailCode: 'check_needed',
    });
  });

  it('reports unknown without an owner or an allocation', async () => {
    await expect(project(allocated(healthy()), { ownerId: null })).resolves.toMatchObject({
      status: 'unknown',
      detailCode: 'insufficient_evidence',
    });
    await expect(project(null)).resolves.toMatchObject({ status: 'unknown' });
  });

  it('arms the sleep estimate from authoritative idle evidence', async () => {
    const idleAt = NOW + 60_000;
    const idleArmedAt = idleAt - POLICY.idleStopMs;
    const receivedAt = NOW - 1_000;
    const route: SessionRoute = {
      sessionId: 'sess-1',
      kiloSessionId: 'kilo-1',
      directory: '/work',
      worktreeId: 'wt-1',
      ownerId: OWNER,
      lastState: 'idle',
      lastStateAt: receivedAt,
      idleForMs: 1_000,
      waitingOn: null,
    };
    const sessionIdsHash = await sha256Hex(JSON.stringify([route.kiloSessionId]));
    const connection: SandboxControlConnectionObservation = {
      state: 'connected',
      acceptedAt: idleArmedAt - 1,
      observation: { ready: true, receivedAt, idle: { sessionCount: 1, sessionIdsHash } },
    };
    const snapshot = await project(allocated(healthy(), idleAt), {
      connection,
      routes: [route],
    });
    expect(snapshot).toMatchObject({ status: 'active', estimatedSleepAt: idleAt });
  });

  it('does not arm the sleep estimate from an inactive route', async () => {
    const idleAt = NOW + 60_000;
    const receivedAt = NOW - 1_000;
    const route: SessionRoute = {
      sessionId: 'sess-1',
      kiloSessionId: 'kilo-1',
      directory: '/work',
      ownerId: OWNER,
      lastState: 'active',
      lastStateAt: receivedAt,
      idleForMs: null,
      waitingOn: 'model',
    };
    const sessionIdsHash = await sha256Hex(JSON.stringify([route.kiloSessionId]));
    const connection: SandboxControlConnectionObservation = {
      state: 'connected',
      acceptedAt: idleAt - POLICY.idleStopMs - 1,
      observation: { ready: true, receivedAt, idle: { sessionCount: 1, sessionIdsHash } },
    };
    const snapshot = await project(allocated(healthy(), idleAt), {
      connection,
      routes: [route],
    });
    expect(snapshot.estimatedSleepAt).toBeNull();
  });
});
