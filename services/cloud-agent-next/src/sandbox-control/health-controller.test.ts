import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AllocationInputEvent } from '../sandbox-state/events.js';
import type { AllocationDecision } from './allocation-controller.js';
import { createHealthController, toAllocationEvent } from './health-controller.js';

const NOW = 1_000_000;
const INC = 'inc-1';

function collect() {
  const events: AllocationInputEvent[] = [];
  const dispatcher = {
    dispatch: async (event: AllocationInputEvent, _now?: number): Promise<AllocationDecision> => {
      events.push(event);
      return {
        state: { v: 2, resumable: false, state: { kind: 'stopped', summary: null } },
        commands: [],
        deadlineAt: null,
      };
    },
  };
  return { events, dispatcher };
}

describe('health controller — observation to event adapter', () => {
  it('maps a handshake to a provider-unknown health observation', () => {
    expect(toAllocationEvent({ kind: 'handshake', incarnation: INC, at: NOW })).toEqual({
      type: 'HEALTH_OBSERVED',
      incarnation: INC,
      at: NOW,
      providerState: 'unknown',
    });
  });

  it('maps ready to a ready CONNECTED event', () => {
    expect(toAllocationEvent({ kind: 'ready', incarnation: INC, at: NOW })).toEqual({
      type: 'CONNECTED',
      incarnation: INC,
      at: NOW,
      ready: true,
    });
  });

  it('maps heartbeat readiness through', () => {
    expect(
      toAllocationEvent({ kind: 'heartbeat', incarnation: INC, at: NOW, ready: true })
    ).toEqual({ type: 'HEARTBEAT', incarnation: INC, at: NOW, ready: true });
    expect(
      toAllocationEvent({ kind: 'heartbeat', incarnation: INC, at: NOW, ready: false })
    ).toMatchObject({ type: 'HEARTBEAT', ready: false });
  });

  it('maps a socket close to a provider-unknown health observation', () => {
    expect(toAllocationEvent({ kind: 'socket-closed', incarnation: INC, at: NOW })).toEqual({
      type: 'HEALTH_OBSERVED',
      incarnation: INC,
      at: NOW,
      providerState: 'unknown',
    });
  });

  it('maps unhealthy, check and observed directly', () => {
    expect(toAllocationEvent({ kind: 'unhealthy', verdict: 'unresponsive' })).toEqual({
      type: 'HEALTH_UNHEALTHY',
      verdict: 'unresponsive',
    });
    expect(toAllocationEvent({ kind: 'check' })).toEqual({ type: 'CHECK' });
    const fence = { operationId: 'observe:1', providerRef: 'ref-1', incarnation: INC };
    expect(toAllocationEvent({ kind: 'observed', fence, result: 'absent' })).toEqual({
      type: 'OBSERVED',
      fence,
      result: 'absent',
    });
  });

  it('dispatches the mapped event through the allocation controller and returns its decision', async () => {
    const { events, dispatcher } = collect();
    const controller = createHealthController(dispatcher);
    const decision = await controller.observe(
      { kind: 'heartbeat', incarnation: INC, at: NOW, ready: false },
      NOW
    );
    expect(events).toEqual([{ type: 'HEARTBEAT', incarnation: INC, at: NOW, ready: false }]);
    expect(decision?.state.state.kind).toBe('stopped');
  });

  it('holds no persistence and never calls the health reducer directly', () => {
    const source = readFileSync(join(__dirname, 'health-controller.ts'), 'utf-8');
    expect(source).not.toContain('sandbox-state/persist');
    expect(source).not.toContain('loadAllocation');
    expect(source).not.toContain('storeAllocation');
    expect(source).not.toContain('decideHealth(');
    expect(source).not.toContain('applyHealth(');
  });
});
