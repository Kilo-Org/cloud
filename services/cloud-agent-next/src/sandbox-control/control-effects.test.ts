import { describe, expect, it } from 'vitest';
import type { AllocationRecord, AllocationTarget } from '../sandbox-state/model/allocation.js';
import {
  operationId,
  type Command,
  type CreateCommand,
  type DestroyCommand,
  type NotifySessionCommand,
  type ObserveCommand,
  type ReconcileCommand,
  type StopCommand,
} from '../sandbox-state/commands.js';
import { decideAllocation } from '../sandbox-state/allocation/reduce.js';
import { POLICY } from '../sandbox-state/schedule.js';
import { ALLOCATION_KEY, type CanonicalStorage } from '../sandbox-state/persist/store.js';
import { createAllocationController } from './allocation-controller.js';
import {
  executeCommand,
  runCommands,
  type ControlEffectPort,
  type ReconcileEffectResult,
  type StopEffectResult,
} from './control-effects.js';

const NOW = 1_000_000;
const INC = 'inc-1';
const EPISODE_ID = '11111111-1111-4111-8111-111111111111';
const EPISODE = NOW + POLICY.recoveryDeadlineMs;

const CF_CAPS: AllocationTarget['capabilities'] = {
  persistentWorkspace: false,
  destroysOnStop: true,
};
const VERCEL_CAPS: AllocationTarget['capabilities'] = {
  persistentWorkspace: true,
  destroysOnStop: false,
};

const CF_TARGET: AllocationTarget = {
  provider: 'cloudflare',
  providerRef: 'ref-1',
  capabilities: CF_CAPS,
};
const VERCEL_TARGET: AllocationTarget = {
  provider: 'vercel',
  providerRef: 'vercel-ref-1',
  capabilities: VERCEL_CAPS,
};

const CREATE: CreateCommand = {
  kind: 'Create',
  operationId: 'create:intent-1',
  target: CF_TARGET,
  intentId: 'intent-1',
};
const STOP: StopCommand = {
  kind: 'Stop',
  operationId: 'stop:1',
  target: CF_TARGET,
  reason: 'idle',
  incarnation: INC,
};
const DESTROY: DestroyCommand = {
  kind: 'Destroy',
  operationId: 'stop:1',
  target: CF_TARGET,
  reason: 'idle',
  incarnation: INC,
};
const OBSERVE: ObserveCommand = {
  kind: 'Observe',
  operationId: 'observe:1',
  target: CF_TARGET,
};
const RECONCILE: ReconcileCommand = {
  kind: 'Reconcile',
  operationId: operationId('reconcile', INC, EPISODE_ID, 1),
  incarnation: INC,
  attempt: 1,
  deadlineAt: EPISODE,
  recovery: {
    episodeId: EPISODE_ID,
    cause: 'activation_pending',
    startedAt: NOW,
    deadlineAt: EPISODE,
    attempt: 1,
  },
  phase: 'ready',
};
const NOTIFY: NotifySessionCommand = {
  kind: 'NotifySession',
  operationId: 'notify:1',
  reason: 'idle',
};

type PortOverrides = Partial<ControlEffectPort>;
type PortCalls = Array<
  'create' | 'launch' | 'stop' | 'destroy' | 'observe' | 'reconcile' | 'notify'
>;
type FakePort = ControlEffectPort & { calls: PortCalls };

function fakePort(overrides: PortOverrides = {}): FakePort {
  const calls: PortCalls = [];
  return {
    calls,
    create: async () => {
      calls.push('create');
      return { outcome: 'confirmed', providerRef: 'ref-1', incarnation: INC };
    },
    launch: async () => {
      calls.push('launch');
      return { outcome: 'confirmed' };
    },
    stop: async () => {
      calls.push('stop');
      return { outcome: 'terminal', incarnation: INC };
    },
    destroy: async () => {
      calls.push('destroy');
      return { outcome: 'terminal', incarnation: INC };
    },
    observe: async () => {
      calls.push('observe');
      return { outcome: 'present', providerRef: 'ref-1', incarnation: INC };
    },
    reconcile: async () => {
      calls.push('reconcile');
      return { outcome: 'succeeded', at: NOW, ready: true };
    },
    notifySession: async () => {
      calls.push('notify');
      return { outcome: 'delivered' };
    },
    ...overrides,
  };
}

function allocatedRecord(): AllocationRecord {
  return {
    v: 2,
    resumable: true,
    state: {
      kind: 'allocated',
      target: CF_TARGET,
      createIntent: { intentId: 'intent-1', createdAt: NOW - 5_000 },
      health: {
        kind: 'healthy',
        incarnation: INC,
        lastHeartbeat: { incarnation: INC, at: NOW - 1_000, ready: true },
        deadlineAt: NOW + 90_000,
      },
      idleAt: null,
    },
  };
}

function controllerWith(record: AllocationRecord) {
  const data = new Map<string, unknown>([[ALLOCATION_KEY, record]]);
  const storage: CanonicalStorage = {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      data.set(key, value);
    },
  };
  return createAllocationController({ storage, now: () => NOW });
}

function stoppingCommands(): { record: AllocationRecord; commands: Command[] } {
  const decision = decideAllocation(allocatedRecord(), { type: 'IDLE', idleAt: NOW - 1 }, NOW);
  if (decision === undefined) throw new Error('expected a stop decision');
  return { record: decision.state, commands: decision.commands };
}

function checkRequiredRecord(): AllocationRecord {
  return {
    v: 2,
    resumable: true,
    state: {
      kind: 'stopping',
      target: CF_TARGET,
      createIntent: { intentId: 'intent-1', createdAt: NOW - 5_000 },
      stopIntent: { reason: 'idle', createdAt: NOW - 1_000, incarnation: INC },
      step: 'check_required',
      attempts: 5,
    },
  };
}

function withStopIncarnation(record: AllocationRecord, incarnation: string): AllocationRecord {
  if (record.state.kind !== 'stopping') throw new Error('expected a stopping record');
  return {
    ...record,
    state: { ...record.state, stopIntent: { ...record.state.stopIntent, incarnation } },
  };
}

describe('control effects — command to event runner', () => {
  it('maps a confirmed create to CREATE_CONFIRMED with the fence and containment', async () => {
    const port = fakePort({
      create: async () => ({
        outcome: 'confirmed',
        providerRef: 'ref-1',
        incarnation: INC,
        resolvedContainment: { kilocode: true, github: true, providerRef: 'ref-1' },
      }),
    });
    const event = await executeCommand(port, CREATE, NOW);
    expect(event).toEqual({
      type: 'CREATE_CONFIRMED',
      fence: { operationId: 'create:intent-1', providerRef: 'ref-1', incarnation: INC },
      providerRef: 'ref-1',
      incarnation: INC,
      at: NOW,
      resolvedContainment: { kilocode: true, github: true, providerRef: 'ref-1' },
    });
  });

  it('maps a proven-absent create to CREATE_FAILED', async () => {
    const port = fakePort({ create: async () => ({ outcome: 'failed', reason: 'no' }) });
    expect(await executeCommand(port, CREATE, NOW)).toEqual({
      type: 'CREATE_FAILED',
      fence: { operationId: 'create:intent-1', providerRef: 'ref-1', incarnation: null },
      reason: 'no',
      at: NOW,
    });
  });

  it('maps an uncertain or thrown create to CREATE_UNKNOWN', async () => {
    const unknown = await executeCommand(
      fakePort({ create: async () => ({ outcome: 'unknown', reason: 'lost' }) }),
      CREATE,
      NOW
    );
    expect(unknown).toMatchObject({ type: 'CREATE_UNKNOWN', reason: 'lost' });
    const thrown = await executeCommand(
      fakePort({
        create: async () => {
          throw new Error('network');
        },
      }),
      CREATE,
      NOW
    );
    expect(thrown).toMatchObject({ type: 'CREATE_UNKNOWN', reason: 'network' });
  });

  it('maps a terminal destroy to DESTROY_CONFIRMED on the destroy port', async () => {
    const port = fakePort();
    const event = await executeCommand(port, DESTROY, NOW);
    expect(port.calls).toEqual(['destroy']);
    expect(event).toMatchObject({
      type: 'DESTROY_CONFIRMED',
      fence: { operationId: 'stop:1', providerRef: 'ref-1', incarnation: INC },
      proof: {
        effect: 'destroy',
        providerRef: 'ref-1',
        incarnation: INC,
        reason: 'idle',
      },
    });
  });

  it('maps a persistent provider stop to a stop-effect proof on the stop port', async () => {
    const stop: StopCommand = { ...STOP, target: VERCEL_TARGET };
    const port = fakePort();
    const event = await executeCommand(port, stop, NOW);
    expect(port.calls).toEqual(['stop']);
    expect(event).toMatchObject({ type: 'DESTROY_CONFIRMED', proof: { effect: 'stop' } });
  });

  it('preserves the originating incarnation on a retryable or thrown stop', async () => {
    const retryable = await executeCommand(
      fakePort({ stop: async () => ({ outcome: 'retryable', detail: 'busy' }) }),
      STOP,
      NOW
    );
    expect(retryable).toEqual({
      type: 'DESTROY_NOT_CONFIRMED',
      fence: { operationId: 'stop:1', providerRef: 'ref-1', incarnation: INC },
      detail: 'busy',
    });
    const thrown = await executeCommand(
      fakePort({
        stop: async () => {
          throw new Error('boom');
        },
      }),
      STOP,
      NOW
    );
    expect(thrown).toMatchObject({
      type: 'DESTROY_NOT_CONFIRMED',
      fence: { incarnation: INC },
      detail: 'boom',
    });
  });

  it('maps an observation to OBSERVED and drops a failed observation', async () => {
    expect(await executeCommand(fakePort(), OBSERVE, NOW)).toEqual({
      type: 'OBSERVED',
      fence: { operationId: 'observe:1', providerRef: 'ref-1', incarnation: INC },
      result: 'present',
    });
    const failed = await executeCommand(
      fakePort({
        observe: async () => {
          throw new Error('timeout');
        },
      }),
      OBSERVE,
      NOW
    );
    expect(failed).toBeUndefined();
  });

  it('maps reconcile outcomes on the command fence', async () => {
    const succeeded = await executeCommand(fakePort(), RECONCILE, NOW);
    expect(succeeded).toEqual({
      type: 'RECOVERY_SUCCEEDED',
      fence: {
        incarnation: INC,
        episodeId: EPISODE_ID,
        attempt: 1,
        operationId: RECONCILE.operationId,
      },
      at: NOW,
      ready: true,
    });
    const stepped = await executeCommand(
      fakePort({ reconcile: async () => ({ outcome: 'step', step: 'reconnect_wrapper' }) }),
      RECONCILE,
      NOW
    );
    expect(stepped).toEqual({
      type: 'RECOVERY_STEP',
      fence: {
        incarnation: INC,
        episodeId: EPISODE_ID,
        attempt: 1,
        operationId: RECONCILE.operationId,
      },
      step: 'reconnect_wrapper',
    });
    const result: ReconcileEffectResult = { outcome: 'attempt-failed' };
    const failed = await executeCommand(
      fakePort({ reconcile: async () => result }),
      RECONCILE,
      NOW
    );
    expect(failed).toMatchObject({ type: 'RECOVERY_ATTEMPT_FAILED' });
    const thrown = await executeCommand(
      fakePort({
        reconcile: async () => {
          throw new Error('nope');
        },
      }),
      RECONCILE,
      NOW
    );
    expect(thrown).toMatchObject({ type: 'RECOVERY_ATTEMPT_FAILED' });
  });

  it('defers reconcile without attempting it while recovery is deferred', async () => {
    let attempts = 0;
    const port = fakePort({
      reconcile: async () => {
        attempts += 1;
        return { outcome: 'attempt-failed' };
      },
    });

    // The runner owns the deferral decision: no attempt and no event, so the
    // episode and its absolute deadline stay intact for the next alarm.
    expect(await runCommands(port, [RECONCILE], NOW, () => true)).toEqual([]);
    expect(attempts).toBe(0);

    expect(await runCommands(port, [RECONCILE], NOW, () => false)).toMatchObject([
      { type: 'RECOVERY_ATTEMPT_FAILED' },
    ]);
    expect(attempts).toBe(1);
  });

  it('executes notification without producing a result event', async () => {
    let called = 0;
    const port = fakePort({
      notifySession: async () => {
        called += 1;
        return { outcome: 'delivered' };
      },
    });
    expect(await executeCommand(port, NOTIFY, NOW)).toBeUndefined();
    expect(called).toBe(1);
  });

  it('runs commands in order and collects only events', async () => {
    const events = await runCommands(fakePort(), [CREATE, OBSERVE, NOTIFY], NOW);
    expect(events.map(event => event.type)).toEqual(['CREATE_CONFIRMED', 'OBSERVED']);
  });

  it('advances the stop retry budget from a retryable and a thrown result', async () => {
    const { record, commands } = stoppingCommands();
    const effect = commands.find(command => command.kind === 'Destroy' || command.kind === 'Stop');
    if (effect === undefined || (effect.kind !== 'Stop' && effect.kind !== 'Destroy')) {
      throw new Error('expected an effect command');
    }
    expect(effect.incarnation).toBe(INC);

    const ports: ControlEffectPort[] = [
      fakePort({ destroy: async () => ({ outcome: 'retryable', detail: 'busy' }) }),
      fakePort({
        destroy: async () => {
          throw new Error('boom');
        },
      }),
    ];
    for (const port of ports) {
      const [event] = await runCommands(port, commands, NOW);
      expect(event).toMatchObject({
        type: 'DESTROY_NOT_CONFIRMED',
        fence: { incarnation: INC },
      });
      const decision = await controllerWith(record).dispatch(event!, NOW);
      expect(decision).toBeDefined();
      const stopping = decision!.state.state;
      expect(stopping.kind).toBe('stopping');
      expect(stopping.kind === 'stopping' && stopping.attempts).toBe(1);
      expect(
        decision!.commands.some(command => command.kind === 'Destroy' || command.kind === 'Stop')
      ).toBe(true);
    }

    const superseded = {
      type: 'DESTROY_NOT_CONFIRMED',
      fence: {
        operationId: effect.operationId,
        providerRef: effect.target.providerRef,
        incarnation: 'inc-2',
      },
    } as const;
    expect(await controllerWith(record).dispatch(superseded, NOW)).toBeUndefined();
  });

  it('dispatches notification independently of a deferred destroy', async () => {
    const { commands } = stoppingCommands();
    expect(commands.map(command => command.kind)).toEqual(['Destroy', 'NotifySession']);

    let notified = false;
    let resolveDestroy!: (result: StopEffectResult) => void;
    const destroyPromise = new Promise<StopEffectResult>(resolve => {
      resolveDestroy = resolve;
    });
    const port = fakePort({
      destroy: () => destroyPromise,
      notifySession: async () => {
        notified = true;
        return { outcome: 'delivered' };
      },
    });

    const run = runCommands(port, commands, NOW);
    await Promise.resolve();
    expect(notified).toBe(true);

    resolveDestroy({ outcome: 'terminal', incarnation: INC });
    const events = await run;
    expect(events.map(event => event.type)).toEqual(['DESTROY_CONFIRMED']);
  });

  it('labels the proof from the command kind even when capabilities say destroy', async () => {
    // The Cloudflare target destroys on stop, so a capability-derived proof
    // would be `destroy`; the executed command is `Stop`, so the proof is `stop`.
    const port = fakePort();
    const event = await executeCommand(port, STOP, NOW);
    expect(port.calls).toEqual(['stop']);
    expect(event).toMatchObject({ type: 'DESTROY_CONFIRMED', proof: { effect: 'stop' } });
  });

  it('rejects a destroy confirmation that reports a foreign incarnation', async () => {
    const { record, commands } = stoppingCommands();
    const port = fakePort({
      destroy: async () => ({ outcome: 'terminal', incarnation: 'inc-2' }),
    });
    const [event] = await runCommands(port, commands, NOW);
    expect(event).toMatchObject({
      type: 'DESTROY_CONFIRMED',
      fence: { incarnation: 'inc-2' },
      proof: { incarnation: 'inc-2' },
    });
    expect(await controllerWith(record).dispatch(event!, NOW)).toBeUndefined();
  });

  it('rejects an observation that reports a foreign incarnation', async () => {
    const decision = decideAllocation(checkRequiredRecord(), { type: 'CHECK' }, NOW);
    if (decision === undefined) throw new Error('expected a check decision');
    const observe = decision.commands.find(command => command.kind === 'Observe');
    if (observe === undefined || observe.kind !== 'Observe') {
      throw new Error('expected an observe command');
    }
    expect(observe.incarnation).toBe(INC);

    const port = fakePort({
      observe: async () => ({ outcome: 'absent', providerRef: 'ref-1', incarnation: 'inc-2' }),
    });
    const [event] = await runCommands(port, [observe], NOW);
    expect(event).toMatchObject({ type: 'OBSERVED', fence: { incarnation: 'inc-2' } });
    expect(await controllerWith(decision.state).dispatch(event!, NOW)).toBeUndefined();
  });

  it('rejects an old command result against a superseding allocation', async () => {
    const { record, commands } = stoppingCommands();
    const effect = commands.find(command => command.kind === 'Destroy' || command.kind === 'Stop');
    if (effect === undefined) throw new Error('expected an effect command');

    const port = fakePort();
    const [event] = await runCommands(port, [effect], NOW);
    expect(event).toMatchObject({
      type: 'DESTROY_CONFIRMED',
      fence: { operationId: effect.operationId },
    });
    const superseded = withStopIncarnation(record, 'inc-2');
    expect(await controllerWith(superseded).dispatch(event!, NOW)).toBeUndefined();
  });
});
