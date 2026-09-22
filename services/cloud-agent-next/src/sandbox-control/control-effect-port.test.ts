import { describe, expect, it } from 'vitest';
import type {
  AllocationRecord,
  AllocationTarget,
  StopProof,
} from '../sandbox-state/model/allocation.js';
import {
  operationId,
  type CreateCommand,
  type DestroyCommand,
  type LaunchCommand,
  type NotifySessionCommand,
  type ObserveCommand,
  type ReconcileCommand,
  type StopCommand,
} from '../sandbox-state/commands.js';
import type { ReconcilePhase, ReconcilePort } from '../sandbox-state/ports/reconcile.js';
import type { SandboxRecovery } from '../shared/sandbox-control-protocol.js';
import { POLICY } from '../sandbox-state/schedule.js';
import { ALLOCATION_KEY, type CanonicalStorage } from '../sandbox-state/persist/store.js';
import { executeCommand } from './control-effects.js';
import { createAllocationController } from './allocation-controller.js';
import {
  createControlEffectPort,
  type ControlEffectProvider,
  type NotifySessionPort,
} from './control-effect-port.js';

const NOW = 1_000_000;
const INC = 'inc-1';
const EPISODE_ID = '11111111-1111-4111-8111-111111111111';
const EPISODE = NOW + POLICY.recoveryDeadlineMs;

const CF_CAPS: AllocationTarget['capabilities'] = {
  persistentWorkspace: false,
  destroysOnStop: true,
};
const TARGET: AllocationTarget = {
  provider: 'cloudflare',
  providerRef: 'ref-1',
  capabilities: CF_CAPS,
};

const PROOF: StopProof = {
  effect: 'destroy',
  at: NOW,
  providerRef: 'ref-1',
  incarnation: INC,
  reason: 'idle',
};

const CREATE: CreateCommand = {
  kind: 'Create',
  operationId: 'create:intent-1',
  target: TARGET,
  intentId: 'intent-1',
};
const LAUNCH: LaunchCommand = {
  kind: 'Launch',
  operationId: 'launch:intent-1',
  target: TARGET,
  incarnation: INC,
};
const STOP: StopCommand = {
  kind: 'Stop',
  operationId: 'stop:1',
  target: TARGET,
  reason: 'idle',
  incarnation: INC,
};
const DESTROY: DestroyCommand = {
  kind: 'Destroy',
  operationId: 'stop:1',
  target: TARGET,
  reason: 'idle',
  incarnation: INC,
};
const OBSERVE: ObserveCommand = {
  kind: 'Observe',
  operationId: 'observe:1',
  target: TARGET,
  incarnation: INC,
};
const RECOVERY: SandboxRecovery = {
  episodeId: EPISODE_ID,
  cause: 'activation_pending',
  startedAt: NOW,
  deadlineAt: EPISODE,
  attempt: 1,
};
const RECONCILE: ReconcileCommand = {
  kind: 'Reconcile',
  operationId: operationId('reconcile', INC, EPISODE_ID, 1),
  incarnation: INC,
  attempt: 1,
  deadlineAt: EPISODE,
  recovery: RECOVERY,
  phase: 'ready',
};
const NOTIFY: NotifySessionCommand = {
  kind: 'NotifySession',
  operationId: 'notify:1',
  reason: 'idle',
  stopProof: PROOF,
};

type ProviderOverrides = Partial<ControlEffectProvider>;

function fakeProvider(
  overrides: ProviderOverrides = {}
): ControlEffectProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    create: async () => {
      calls.push('create');
      return { providerRef: 'ref-1', incarnation: INC };
    },
    launch: async () => {
      calls.push('launch');
    },
    stop: async () => {
      calls.push('stop');
      return { result: 'terminal', incarnation: INC };
    },
    destroy: async () => {
      calls.push('destroy');
      return { result: 'terminal', incarnation: INC };
    },
    observe: async () => {
      calls.push('observe');
      return { status: 'active', providerRef: 'ref-1', incarnation: INC };
    },
    ...overrides,
  };
}

function fakeNotify(overrides: Partial<NotifySessionPort> = {}): NotifySessionPort {
  return {
    notifyStopped: async () => ({ outcome: 'delivered' }),
    ...overrides,
  };
}

/**
 * A fake that reproduces the wrapper's exact attempt fence
 * (`wrapper/src/control/sandbox-control-client.ts:600–647`, pinned by
 * `sandbox-control-client.test.ts:534–638`): a `drain` records the active
 * attempt tuple, every other phase is rejected unless it matches the recorded or
 * committed tuple, and `probeReady` stays false until a `ready` phase for the
 * matching tuple is accepted. The fence compares the payload's `recovery.*`
 * (never only the envelope) and rejects a payload whose envelope disagrees with
 * its own descriptor. The wrapper reads `Date.now()`; the fake takes the clock as
 * a parameter so tests stay deterministic.
 */
function wrapperReconcile(clock: () => number = () => NOW): {
  port: ReconcilePort;
  attempts: string[][];
  payloads: Array<{ phase: ReconcilePhase; recovery: SandboxRecovery }>;
} {
  const attempts: string[][] = [];
  const payloads: Array<{ phase: ReconcilePhase; recovery: SandboxRecovery }> = [];
  let active: SandboxRecovery | undefined;
  let committed: SandboxRecovery | undefined;
  let readyAccepted = false;
  return {
    attempts,
    payloads,
    port: {
      async sendPhase({ episodeId, attempt, deadlineAt, phase, recovery }) {
        // The port must send one descriptor: the payload's `recovery.*` is the
        // fence, and the envelope tuple must be that same descriptor, never a
        // second derivation.
        if (
          recovery.episodeId !== episodeId ||
          recovery.attempt !== attempt ||
          recovery.deadlineAt !== deadlineAt
        ) {
          throw new Error('Recovery authority changed');
        }
        const matchesCommitted =
          phase === 'commit' &&
          committed?.episodeId === recovery.episodeId &&
          committed.attempt === recovery.attempt &&
          committed.deadlineAt === recovery.deadlineAt;
        const matchesActive =
          active?.episodeId === recovery.episodeId &&
          active.attempt === recovery.attempt &&
          active.deadlineAt === recovery.deadlineAt;
        if (!matchesCommitted && (clock() >= deadlineAt || (phase !== 'drain' && !matchesActive))) {
          throw new Error('Recovery authority changed');
        }
        payloads.push({ phase, recovery });
        if (matchesCommitted) return;
        if (phase === 'drain') {
          active = recovery;
          committed = undefined;
          readyAccepted = false;
          attempts.push(['drain']);
          return;
        }
        attempts.at(-1)?.push(phase);
        if (phase === 'ready') readyAccepted = true;
        if (phase === 'commit') {
          committed = recovery;
          active = undefined;
        }
      },
      async probeReady() {
        return readyAccepted;
      },
    },
  };
}

function staticReconcile(overrides: Partial<ReconcilePort> = {}): ReconcilePort {
  return {
    sendPhase: async () => {},
    probeReady: async () => true,
    ...overrides,
  };
}

function port(
  overrides: {
    provider?: ProviderOverrides;
    notifySession?: NotifySessionPort;
    reconcile?: ReconcilePort;
  } = {}
) {
  return createControlEffectPort({
    provider: fakeProvider(overrides.provider),
    notifySession: overrides.notifySession ?? fakeNotify(),
    reconcile: overrides.reconcile ?? staticReconcile(),
    now: () => NOW,
  });
}

function allocatedRecord(): AllocationRecord {
  return {
    v: 2,
    resumable: true,
    state: {
      kind: 'allocated',
      target: TARGET,
      createIntent: { intentId: 'intent-1', createdAt: NOW - 5_000 },
      health: {
        kind: 'healthy',
        incarnation: INC,
        lastHeartbeat: { incarnation: INC, at: NOW - 1_000, ready: true },
        deadlineAt: NOW + POLICY.heartbeatExpiryMs,
      },
      idleAt: null,
    },
  };
}

function seededController() {
  const data = new Map<string, unknown>([[ALLOCATION_KEY, allocatedRecord()]]);
  const storage: CanonicalStorage = {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      data.set(key, value);
    },
  };
  return createAllocationController({
    storage,
    now: () => NOW,
    mintEpisodeId: () => EPISODE_ID,
  });
}

describe('control effect port — create', () => {
  it('creates and returns the confirmed evidence without launching', async () => {
    const provider = fakeProvider();
    const effect = await port({ provider }).create(CREATE);
    expect(provider.calls).toEqual(['create']);
    expect(effect).toEqual({ outcome: 'confirmed', providerRef: 'ref-1', incarnation: INC });
  });

  it('passes the resolved containment through', async () => {
    const effect = await port({
      provider: {
        create: async () => ({
          providerRef: 'ref-9',
          incarnation: 'inc-9',
          resolvedContainment: { kilocode: true, github: true, providerRef: 'ref-9' },
        }),
      },
    }).create(CREATE);
    expect(effect).toEqual({
      outcome: 'confirmed',
      providerRef: 'ref-9',
      incarnation: 'inc-9',
      resolvedContainment: { kilocode: true, github: true, providerRef: 'ref-9' },
    });
  });

  it('maps an unresolved create to unknown', async () => {
    const effect = await port({ provider: { create: async () => ({ unresolved: true }) } }).create(
      CREATE
    );
    expect(effect).toEqual({ outcome: 'unknown', reason: 'create_unresolved' });
  });

  it('maps a thrown create to unknown', async () => {
    const thrownCreate = await port({
      provider: {
        create: async () => {
          throw new Error('network');
        },
      },
    }).create(CREATE);
    expect(thrownCreate).toEqual({ outcome: 'unknown', reason: 'network' });
  });
});

describe('control effect port — launch', () => {
  it('launches the confirmed provider reference', async () => {
    const provider = fakeProvider();
    const effect = await port({ provider }).launch(LAUNCH);
    expect(provider.calls).toEqual(['launch']);
    expect(effect).toEqual({ outcome: 'confirmed' });
  });

  it('maps a thrown launch to a failed result', async () => {
    const effect = await port({
      provider: {
        launch: async () => {
          throw new Error('launch failed');
        },
      },
    }).launch(LAUNCH);
    expect(effect).toEqual({ outcome: 'failed', reason: 'launch failed' });
  });

  it('fails without invoking the provider when the target has no reference', async () => {
    const provider = fakeProvider();
    const effect = await port({ provider }).launch({
      ...LAUNCH,
      target: { ...TARGET, providerRef: null },
    });
    expect(effect).toEqual({ outcome: 'failed', reason: 'launch_without_provider_ref' });
    expect(provider.calls).toEqual([]);
  });
});

describe('control effect port — stop and destroy', () => {
  it('dispatches to the matching provider effect and returns the observed incarnation', async () => {
    const provider = fakeProvider();
    const effect = port({ provider });
    expect(await effect.stop(STOP)).toEqual({ outcome: 'terminal', incarnation: INC });
    expect(await effect.destroy(DESTROY)).toEqual({ outcome: 'terminal', incarnation: INC });
    expect(provider.calls).toEqual(['stop', 'destroy']);
  });

  it('returns the observed wrapper when the provider reports one', async () => {
    const effect = port({
      provider: {
        stop: async () => ({ result: 'terminal', incarnation: 'inc-2', wrapper: 'w-2' }),
      },
    });
    expect(await effect.stop(STOP)).toEqual({
      outcome: 'terminal',
      incarnation: 'inc-2',
      wrapper: 'w-2',
    });
  });

  it('maps a retryable or thrown stop to retryable', async () => {
    expect(
      await port({
        provider: { stop: async () => ({ result: 'retryable', incarnation: INC }) },
      }).stop(STOP)
    ).toEqual({ outcome: 'retryable' });

    const thrown = await port({
      provider: {
        stop: async () => {
          throw new Error('boom');
        },
      },
    }).stop(STOP);
    expect(thrown).toEqual({ outcome: 'retryable', detail: 'boom' });
  });

  it('maps a thrown destroy to retryable', async () => {
    const thrown = await port({
      provider: {
        destroy: async () => {
          throw new Error('gone');
        },
      },
    }).destroy(DESTROY);
    expect(thrown).toEqual({ outcome: 'retryable', detail: 'gone' });
  });
});

describe('control effect port — observe', () => {
  it('maps active to present and terminal to absent', async () => {
    const active = await port({
      provider: {
        observe: async () => ({ status: 'active', providerRef: 'ref-1', incarnation: INC }),
      },
    }).observe(OBSERVE);
    expect(active).toEqual({ outcome: 'present', providerRef: 'ref-1', incarnation: INC });

    const absent = await port({
      provider: {
        observe: async () => ({ status: 'terminal', providerRef: null, incarnation: INC }),
      },
    }).observe(OBSERVE);
    expect(absent).toEqual({ outcome: 'absent', providerRef: null, incarnation: INC });

    const resolvedContainment = { kilocode: true, github: false, providerRef: 'ref-1' };
    const recoverable = await port({
      provider: {
        observe: async () => ({
          status: 'active',
          providerRef: 'ref-1',
          incarnation: INC,
          recoverable: true,
          resolvedContainment,
        }),
      },
    }).observe(OBSERVE);
    expect(recoverable).toEqual({
      outcome: 'present',
      providerRef: 'ref-1',
      incarnation: INC,
      recoverable: true,
      resolvedContainment,
    });
  });

  it('rejects an inconclusive observation and drops it in the runner', async () => {
    const effectPort = port({
      provider: {
        observe: async () => ({ status: 'unknown', providerRef: null, incarnation: INC }),
      },
    });
    await expect(effectPort.observe(OBSERVE)).rejects.toThrow('observation_inconclusive');
    expect(await executeCommand(effectPort, OBSERVE, NOW)).toBeUndefined();
  });
});

describe('control effect port — reconcile full attempt', () => {
  it('runs drain → step → drain/ready/commit → succeeded through the reducer', async () => {
    const controller = seededController();

    // Enter recovery through the allocation controller: the impure boundary mints
    // the episode id exactly once, and attempt 1 executes the `check_sandbox` rung.
    const entered = await controller.dispatch(
      { type: 'HEARTBEAT', incarnation: INC, at: NOW, ready: false },
      NOW
    );
    const first = entered?.commands.find(command => command.kind === 'Reconcile');
    if (first === undefined || first.kind !== 'Reconcile') throw new Error('expected a Reconcile');
    expect(first.phase).toBe('drain');
    expect(first.attempt).toBe(1);
    expect(first.recovery).toEqual(RECOVERY);

    const wrapper = wrapperReconcile();
    const effectPort = createControlEffectPort({
      provider: fakeProvider(),
      notifySession: fakeNotify(),
      reconcile: wrapper.port,
      now: () => NOW,
    });

    // Attempt 1: drain establishes the tuple, the probe is not ready → step.
    const stepEvent = await executeCommand(effectPort, first, NOW);
    expect(stepEvent).toMatchObject({ type: 'RECOVERY_STEP', step: 'reconnect_wrapper' });
    const stepped = await controller.dispatch(stepEvent!, NOW);
    const second = stepped?.commands.find(command => command.kind === 'Reconcile');
    if (second === undefined || second.kind !== 'Reconcile') throw new Error('expected attempt 2');
    expect(second.phase).toBe('ready');
    expect(second.attempt).toBe(2);

    // The descriptor is episode-stable and the attempt strictly increases; the
    // pre-success recovering state has not spent the exhaustion budget.
    expect(second.recovery.episodeId).toBe(first.recovery.episodeId);
    expect(second.recovery.deadlineAt).toBe(first.recovery.deadlineAt);
    expect(second.recovery.startedAt).toBe(first.recovery.startedAt);
    expect(second.recovery.cause).toBe(first.recovery.cause);
    expect(second.recovery.attempt).toBeGreaterThan(first.recovery.attempt);
    const beforeSuccess = stepped?.state.state;
    expect(
      beforeSuccess?.kind === 'allocated' &&
        beforeSuccess.health.kind === 'recovering' &&
        beforeSuccess.health.attempts
    ).toBeLessThan(POLICY.recoveryMaxAttempts);

    // Attempt 2: drain re-establishes attempt 2's tuple, then ready, probe and commit.
    const succeeded = await executeCommand(effectPort, second, NOW);
    expect(succeeded).toMatchObject({ type: 'RECOVERY_SUCCEEDED', ready: true });
    expect([stepEvent?.type, succeeded?.type]).toEqual(['RECOVERY_STEP', 'RECOVERY_SUCCEEDED']);
    const healthy = await controller.dispatch(succeeded!, NOW);
    expect(healthy?.state.state.kind === 'allocated' && healthy.state.state.health.kind).toBe(
      'healthy'
    );

    expect(wrapper.attempts).toEqual([['drain'], ['drain', 'ready', 'commit']]);
    for (const payload of wrapper.payloads) {
      expect(payload.recovery.episodeId).toBe(EPISODE_ID);
      expect(payload.recovery.deadlineAt).toBe(EPISODE);
    }
  });

  it('maps a not-ready ready phase or a thrown wire call to attempt-failed', async () => {
    const notReady = await port({
      reconcile: staticReconcile({ probeReady: async () => false }),
    }).reconcile(RECONCILE);
    expect(notReady).toEqual({ outcome: 'attempt-failed' });

    const thrown = await port({
      reconcile: staticReconcile({
        sendPhase: async () => {
          throw new Error('wire');
        },
      }),
    }).reconcile(RECONCILE);
    expect(thrown).toEqual({ outcome: 'attempt-failed' });
  });

  it('maps a completed drain rung that is not ready to a step', async () => {
    const drain: ReconcileCommand = { ...RECONCILE, phase: 'drain' };
    const result = await port({
      reconcile: staticReconcile({ probeReady: async () => false }),
    }).reconcile(drain);
    expect(result).toEqual({ outcome: 'step', step: 'reconnect_wrapper' });
  });
});

describe('control effect port — notify', () => {
  it('forwards the proof and reason and maps a failure', async () => {
    const seen: Array<{ stopProof: StopProof | undefined; reason: string }> = [];
    const delivered = await port({
      notifySession: fakeNotify({
        notifyStopped: async input => {
          seen.push(input);
          return { outcome: 'delivered' };
        },
      }),
    }).notifySession(NOTIFY);
    expect(delivered).toEqual({ outcome: 'delivered' });
    expect(seen).toEqual([{ stopProof: PROOF, reason: 'idle' }]);

    const failed = await port({
      notifySession: fakeNotify({
        notifyStopped: async () => {
          throw new Error('stub down');
        },
      }),
    }).notifySession(NOTIFY);
    expect(failed).toEqual({ outcome: 'failed', reason: 'stub down' });
  });
});
