import { describe, expect, it } from 'vitest';
import type { AllocationRecord, AllocationTarget } from '../sandbox-state/model/allocation.js';
import type { AcquireEvent, AllocationInputEvent } from '../sandbox-state/events.js';
import { ALLOCATION_KEY, type CanonicalStorage } from '../sandbox-state/persist/store.js';
import type { ControlEffectPort } from './control-effects.js';
import { createControlOrchestrator } from './control-orchestration.js';
import type { AllocationTransition } from './allocation-transition.js';

const NOW = 1_000_000;
const INTENT_ID = 'intent-1';
const INC = 'inc-1';

const TARGET: AllocationTarget = {
  provider: 'cloudflare',
  providerRef: null,
  allocationName: 'alloc-1',
  capabilities: { persistentWorkspace: false, destroysOnStop: true },
};

const ACQUIRE: AcquireEvent = {
  type: 'ACQUIRE',
  requestId: 'request-1',
  target: TARGET,
  createIntent: { intentId: INTENT_ID, createdAt: NOW },
  deliveryDeadlineAt: NOW + 60_000,
};

function memoryStorage(seed: AllocationRecord | undefined): {
  storage: CanonicalStorage;
  read: () => AllocationRecord | undefined;
} {
  const data = new Map<string, unknown>();
  if (seed !== undefined) data.set(ALLOCATION_KEY, seed);
  return {
    storage: {
      get: async <T>(key: string) => data.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => {
        data.set(key, value);
      },
    },
    read: () => data.get(ALLOCATION_KEY) as AllocationRecord | undefined,
  };
}

function fakePort(calls: string[]): ControlEffectPort {
  return {
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
    observe: async () => ({ outcome: 'absent', providerRef: null, incarnation: INC }),
    reconcile: async () => ({ outcome: 'succeeded', at: NOW, ready: true }),
    notifySession: async () => ({ outcome: 'delivered' }),
  };
}

describe('control orchestration — run step', () => {
  it('persists the decision on dispatch without running any effect', async () => {
    const { storage, read } = memoryStorage(undefined);
    const calls: string[] = [];
    const orchestrator = createControlOrchestrator({
      storage,
      effects: fakePort(calls),
      now: () => NOW,
    });

    const decision = await orchestrator.dispatch(ACQUIRE, NOW);

    expect(decision?.commands.map(command => command.kind)).toEqual(['Create']);
    expect(calls).toEqual([]);
    expect(read()?.state.kind).toBe('creating');
  });

  it('runs dispatched commands and feeds the result back so the machine settles', async () => {
    const { storage, read } = memoryStorage(undefined);
    const calls: string[] = [];
    const orchestrator = createControlOrchestrator({
      storage,
      effects: fakePort(calls),
      now: () => NOW,
    });

    const decision = await orchestrator.dispatch(ACQUIRE, NOW);
    // The interleave point: `creating` is already durable and the create effect
    // has not run, so a caller can prepare session credentials here.
    expect(read()?.state.kind).toBe('creating');
    expect(calls).toEqual([]);

    await orchestrator.run(decision?.commands ?? [], NOW);

    expect(calls).toEqual(['create', 'launch']);
    const state = read()?.state;
    expect(state?.kind).toBe('allocated');
    if (state?.kind === 'allocated') expect(state.health.incarnation).toBe(INC);
  });

  it('settle dispatches and runs in one call', async () => {
    const { storage, read } = memoryStorage(undefined);
    const calls: string[] = [];
    const orchestrator = createControlOrchestrator({
      storage,
      effects: fakePort(calls),
      now: () => NOW,
    });

    await orchestrator.settle(ACQUIRE, NOW);

    expect(calls).toEqual(['create', 'launch']);
    expect(read()?.state.kind).toBe('allocated');
  });

  it('run feeds effect results back and loops until the machine quiesces', async () => {
    const { storage, read } = memoryStorage({
      v: 2,
      resumable: false,
      state: {
        kind: 'allocated',
        target: { ...TARGET, providerRef: 'ref-1' },
        createIntent: { intentId: INTENT_ID, createdAt: NOW },
        health: {
          kind: 'healthy',
          incarnation: INC,
          lastHeartbeat: { incarnation: INC, at: NOW - 1_000, ready: true },
          deadlineAt: NOW + 60_000,
        },
        idleAt: null,
      },
    });
    const calls: string[] = [];
    const orchestrator = createControlOrchestrator({
      storage,
      effects: fakePort(calls),
      now: () => NOW,
    });

    const cancel: AllocationInputEvent = { type: 'CANCEL', scope: 'allocation', reason: 'idle' };
    const decision = await orchestrator.dispatch(cancel, NOW);
    expect(decision?.commands.length).toBeGreaterThan(0);
    expect(calls).toEqual([]);

    await orchestrator.run(decision?.commands ?? [], NOW);

    expect(calls).toContain('destroy');
    expect(read()?.state.kind).toBe('stopped');
  });

  it('reports each intermediate drain transition in order', async () => {
    const { storage } = memoryStorage(undefined);
    const calls: string[] = [];
    const transitions: AllocationTransition[] = [];
    const orchestrator = createControlOrchestrator({
      storage,
      effects: fakePort(calls),
      now: () => NOW,
      onTransition: transition => transitions.push(transition),
    });

    const decision = await orchestrator.dispatch(ACQUIRE, NOW);
    await orchestrator.run(decision?.commands ?? [], NOW);

    expect(calls).toEqual(['create', 'launch']);
    expect(transitions.map(transition => `${transition.from}->${transition.to}`)).toEqual([
      'stopped->creating',
      'creating->allocated.connecting',
    ]);
    expect(transitions.map(transition => transition.event)).toEqual([
      'acquire',
      'create_confirmed',
    ]);
  });
});
