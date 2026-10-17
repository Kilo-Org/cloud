import { describe, it, expect, vi } from 'vitest';
import { dispatchAgent } from '../../src/dos/town/scheduling';
import type { SchedulingContext } from '../../src/dos/town/scheduling';
import type { Agent, Bead } from '../../src/types';

vi.mock('../../src/dos/town/container-dispatch', () => ({
  startAgentInContainer: vi.fn().mockResolvedValue({ started: false, containerFetchMs: 0 }),
  getLastStartError: vi.fn(),
  checkAgentContainerStatus: vi.fn(),
  ensureContainerToken: vi.fn(),
}));

function makeAgent(): Agent {
  return {
    id: 'agent-1',
    name: 'worker',
    role: 'worker',
    identity: 'worker-identity',
    rig_id: 'rig-1',
    status: 'idle',
    checkpoint: null,
  } as unknown as Agent;
}

function makeBead(): Bead {
  return {
    bead_id: 'bead-1',
    title: 'bead title',
    body: 'bead body',
    status: 'open',
  } as unknown as Bead;
}

function makeCtx(overrides: Partial<SchedulingContext> = {}): SchedulingContext {
  return {
    sql: {} as SchedulingContext['sql'],
    env: {} as SchedulingContext['env'],
    storage: {} as DurableObjectStorage,
    townId: 'town-1',
    getTownConfig: vi.fn(),
    getRigConfig: vi.fn(),
    resolveKilocodeToken: vi.fn(),
    emitEvent: vi.fn(),
    prepareContainerBilling: vi.fn().mockResolvedValue(undefined),
    containerStartsBlocked: () => false,
    ...overrides,
  };
}

describe('dispatchAgent container start gating', () => {
  it('returns false without touching state when starts are blocked', async () => {
    const prepareContainerBilling = vi.fn().mockResolvedValue(undefined);
    const getRigConfig = vi.fn();
    const emitEvent = vi.fn();
    const ctx = makeCtx({
      containerStartsBlocked: () => true,
      prepareContainerBilling,
      getRigConfig,
      emitEvent,
    });
    const result = await dispatchAgent(ctx, makeAgent(), makeBead());
    expect(result).toBe(false);
    // Gate closes before any billing or rig work happens.
    expect(prepareContainerBilling).not.toHaveBeenCalled();
    expect(getRigConfig).not.toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'agent.dispatch_failed', reason: 'container starts blocked' })
    );
  });

  it('proceeds past the gate when starts are not blocked', async () => {
    const ctx = makeCtx({
      // No rig config on purpose: the gate passes and dispatch fails later
      // for the documented "no rig config" reason, not the start gate.
      getRigConfig: vi.fn().mockResolvedValue(null),
    });
    const result = await dispatchAgent(ctx, makeAgent(), makeBead());
    expect(result).toBe(false);
    // Past the gate: the rig lookup ran and no gate event was emitted.
    expect(ctx.getRigConfig).toHaveBeenCalled();
    expect(ctx.emitEvent).not.toHaveBeenCalled();
  });
});
