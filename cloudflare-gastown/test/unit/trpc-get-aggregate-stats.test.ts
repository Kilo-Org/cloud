import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TRPCContext } from '../../src/trpc/init';

const getWorkerDb = vi.fn();

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb,
}));

vi.mock('../../src/dos/Town.do', () => ({
  getTownDOStub: vi.fn(),
}));

vi.mock('../../src/dos/TownContainer.do', () => ({
  getTownContainerStub: vi.fn(),
}));

vi.mock('../../src/dos/GastownUser.do', () => ({
  getGastownUserStub: vi.fn(),
}));

vi.mock('../../src/dos/GastownOrg.do', () => ({
  getGastownOrgStub: vi.fn(),
}));

function createCtx(overrides: Partial<TRPCContext> = {}): TRPCContext {
  return {
    env: {
      HYPERDRIVE: {
        connectionString: 'postgres://test-host/db',
      },
    } as Env,
    userId: 'user-1',
    isAdmin: false,
    apiTokenPepper: null,
    gastownAccess: true,
    orgMemberships: [],
    ...overrides,
  };
}

describe('trpc gastown.getAggregateStats', () => {
  beforeEach(() => {
    getWorkerDb.mockReset();
  });

  it('returns aggregated stats with numeric formatting', async () => {
    const where = vi.fn().mockResolvedValue([{ totalCost: '12345.67', totalTokens: '890' }]);
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    getWorkerDb.mockReturnValue({ select });

    const { wrappedGastownRouter } = await import('../../src/trpc/router');
    const caller = wrappedGastownRouter.createCaller(createCtx());
    const result = await caller.gastown.getAggregateStats();

    expect(result).toEqual({ totalCost: 12345.67, totalTokens: 890 });
    expect(getWorkerDb).toHaveBeenCalledWith('postgres://test-host/db', {
      statement_timeout: 5_000,
    });
  });

  it('returns zero defaults when aggregate query returns nulls', async () => {
    const where = vi.fn().mockResolvedValue([{ totalCost: null, totalTokens: null }]);
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    getWorkerDb.mockReturnValue({ select });

    const { wrappedGastownRouter } = await import('../../src/trpc/router');
    const caller = wrappedGastownRouter.createCaller(createCtx());
    const result = await caller.gastown.getAggregateStats();

    expect(result).toEqual({ totalCost: 0, totalTokens: 0 });
  });

  it('throws INTERNAL_SERVER_ERROR when aggregation query fails', async () => {
    const where = vi.fn().mockRejectedValue(new Error('db timeout'));
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    getWorkerDb.mockReturnValue({ select });

    const { wrappedGastownRouter } = await import('../../src/trpc/router');
    const caller = wrappedGastownRouter.createCaller(createCtx());

    await expect(caller.gastown.getAggregateStats()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to load aggregate stats',
    });
  });

  it('throws INTERNAL_SERVER_ERROR when HYPERDRIVE is missing', async () => {
    const { wrappedGastownRouter } = await import('../../src/trpc/router');
    const caller = wrappedGastownRouter.createCaller(
      createCtx({
        env: {} as Env,
      })
    );

    await expect(caller.gastown.getAggregateStats()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'HYPERDRIVE binding not configured',
    });
  });
});
