/**
 * Benchmark charges: the usage router procedure that groups the reserved
 * benchmark project namespace into pools and their concrete models.
 *
 * The mocks mirror `usage-analytics-router.test.ts` because both suites import
 * the same module, whose top-level imports pull in the tRPC init, Drizzle and
 * Snowflake clients.
 */
import {
  ensureOrganizationAccess,
  ensureOrganizationsAccess,
} from '@kilocode/web-shared/routers/organizations/utils';
jest.mock('@kilocode/web-shared/lib/trpc/init', () => {
  const { initTRPC } = jest.requireActual('@trpc/server');
  const t = initTRPC.create();
  return { baseProcedure: t.procedure, createTRPCRouter: t.router };
});
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({ readDb: {}, db: {} }));
jest.mock('@kilocode/web-shared/lib/dotenvx', () => ({ getEnvVariable: jest.fn() }));
jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
  ensureOrganizationsAccess: jest.fn(),
  getOrganizationsAccessRoles: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/redis', () => ({ redisClient: {} }));
jest.mock('@/lib/snowflake', () => ({
  resolveSnowflakeConfig: jest.fn(),
  executeSnowflakeStatement: jest.fn(),
}));

import { TRPCError } from '@trpc/server';
import {
  executeSnowflakeStatement,
  resolveSnowflakeConfig,
  type SnowflakeRow,
} from '@/lib/snowflake';
import { defineTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { BENCHMARK_PROJECT_PREFIX, benchmarkProjectId } from '@kilocode/auto-routing-contracts';
import {
  BenchmarkChargesInputSchema,
  MAX_BENCHMARK_MODELS_PER_POOL,
  usageAnalyticsRouter,
  UsageAnalyticsFiltersSchema,
  WhereBuilder,
} from './usage-analytics-router';

const mockResolveSnowflakeConfig = jest.mocked(resolveSnowflakeConfig);
const mockExecuteSnowflakeStatement = jest.mocked(executeSnowflakeStatement);
const mockEnsureOrganizationAccess = jest.mocked(ensureOrganizationAccess);
const mockEnsureOrganizationsAccess = jest.mocked(ensureOrganizationsAccess);

const CTX_USER = 'user-1';
const ORG = '11111111-1111-4111-8111-111111111111';
const ROUTER_ID = '0f3c2b1a-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const OTHER_ROUTER_ID = 'aa11bb22-cc33-4d44-8e55-ff6677889900';

const baseInput = {
  startDate: '2026-06-04T00:00:00.000Z',
  endDate: '2026-06-05T00:00:00.000Z',
  granularity: 'day' as const,
};

function caller(userId = CTX_USER) {
  return usageAnalyticsRouter.createCaller({ user: defineTestUser({ id: userId }) });
}

function poolId(scope: 'user' | 'org', slug: string, routerId = ROUTER_ID): string {
  return benchmarkProjectId({ scope, slug, routerId });
}

/**
 * Pool query then model query, in the order the procedure issues them.
 * Snowflake returns every cell as text, so fixtures are strings too.
 */
function mockSnowflake(poolRows: SnowflakeRow[], modelRows: SnowflakeRow[] = []) {
  mockResolveSnowflakeConfig.mockReturnValue({
    accountHost: 'account.snowflakecomputing.com',
    jwtAccountIdentifier: 'ACCOUNT',
    username: 'user',
    role: 'role',
    warehouse: 'warehouse',
    database: 'database',
    schema: 'schema',
    privateKeyPem: 'key',
    publicKeyFingerprint: 'SHA256:fingerprint',
  });
  mockExecuteSnowflakeStatement.mockResolvedValueOnce(poolRows).mockResolvedValueOnce(modelRows);
}

beforeEach(() => {
  // `clearAllMocks` leaves queued `mockResolvedValueOnce` implementations in
  // place, which would leak one test's Snowflake rows into the next.
  jest.resetAllMocks();
  mockEnsureOrganizationAccess.mockResolvedValue('owner');
  mockEnsureOrganizationsAccess.mockResolvedValue(undefined);
});

describe('benchmark project attribution filter', () => {
  it('is off by default so ordinary usage queries are unchanged', () => {
    expect(UsageAnalyticsFiltersSchema.parse(baseInput).benchmarkProjects).toBeUndefined();
  });

  it('binds the namespace pattern instead of interpolating it', () => {
    const where = new WhereBuilder();
    where.addLike('project_id', `${BENCHMARK_PROJECT_PREFIX} / %`);
    expect(where.sql()).toBe('project_id LIKE ?');
    expect(where.bindings).toEqual([{ type: 'TEXT', value: 'Auto-routing benchmarks / %' }]);
  });
});

describe('getBenchmarkCharges', () => {
  it('returns an empty state without a second query when no pool matched', async () => {
    mockSnowflake([]);
    const result = await caller().getBenchmarkCharges(baseInput);

    expect(result).toEqual({
      status: 'empty',
      totalCostMicrodollars: 0,
      totalRequestCount: 0,
      pools: [],
      hasMorePools: false,
    });
    expect(mockExecuteSnowflakeStatement).toHaveBeenCalledTimes(1);
  });

  it('always scopes the query to the benchmark namespace', async () => {
    mockSnowflake([[poolId('user', 'my-pool'), '5000000', '3']]);
    await caller().getBenchmarkCharges(baseInput);

    const [request] = mockExecuteSnowflakeStatement.mock.calls[0]!;
    expect(request.statement).toContain('project_id LIKE ?');
    expect(request.bindings).toContainEqual({
      type: 'TEXT',
      value: 'Auto-routing benchmarks / %',
    });
  });

  it('groups a pool with its concrete models and folds the remainder', async () => {
    const id = poolId('user', 'my-pool');
    const models = Array.from({ length: MAX_BENCHMARK_MODELS_PER_POOL + 2 }, (_, i) => [
      id,
      `model-${i}`,
      '1000000',
      '1',
    ]);
    mockSnowflake(
      [
        [id, '5000000', '4'],
        [poolId('user', 'other-pool', OTHER_ROUTER_ID), '1000000', '1'],
      ],
      models
    );

    const result = await caller().getBenchmarkCharges(baseInput);

    expect(result.status).toBe('ok');
    expect(result.totalCostMicrodollars).toBe(6_000_000);
    expect(result.totalRequestCount).toBe(5);

    const [pool, other] = result.pools;
    expect(pool).toMatchObject({
      projectId: id,
      poolSlug: 'my-pool',
      routerId: ROUTER_ID,
      poolScope: 'user',
      costMicrodollars: 5_000_000,
      requestCount: 4,
    });
    expect(pool!.models).toHaveLength(MAX_BENCHMARK_MODELS_PER_POOL);
    // The listed models plus the folded remainder reconstruct the pool total.
    const listedCost = pool!.models.reduce((s, m) => s + m.costMicrodollars, 0);
    expect(listedCost + pool!.otherModelsCostMicrodollars).toBe(5_000_000);
    const listedRequests = pool!.models.reduce((s, m) => s + m.requestCount, 0);
    expect(listedRequests + pool!.otherModelsRequestCount).toBe(4);

    // A pool with no model rows still reports its own totals.
    expect(other).toMatchObject({ costMicrodollars: 1_000_000, models: [] });
    expect(other!.otherModelsCostMicrodollars).toBe(1_000_000);
  });

  it('ignores pool rows whose project id is not a complete benchmark identifier', async () => {
    mockSnowflake([
      ['not-a-benchmark-project', '9000000', '9'],
      [`${BENCHMARK_PROJECT_PREFIX} / org/broken`, '1000000', '1'],
      [`${BENCHMARK_PROJECT_PREFIX} / org/my-pool/not-a-uuid`, '1000000', '1'],
    ]);
    const result = await caller().getBenchmarkCharges(baseInput);
    expect(result.status).toBe('empty');
  });

  it('keeps two pools that share a slug distinct by router id', async () => {
    const first = poolId('org', 'shared', ROUTER_ID);
    const second = poolId('org', 'shared', OTHER_ROUTER_ID);
    mockSnowflake(
      [
        [first, '2000000', '2'],
        [second, '1000000', '1'],
      ],
      []
    );

    const result = await caller().getBenchmarkCharges({
      ...baseInput,
      organizationId: ORG,
      viewAs: 'org-wide',
    });

    expect(result.pools.map(p => p.projectId)).toEqual([first, second]);
    expect(new Set(result.pools.map(p => p.projectId)).size).toBe(2);
    expect(result.pools.every(p => p.poolSlug === 'shared')).toBe(true);
  });

  it('reports when more pools exist than the returned page', async () => {
    mockSnowflake([
      [poolId('user', 'first'), '3000000', '3'],
      [poolId('user', 'second', OTHER_ROUTER_ID), '1000000', '1'],
    ]);

    const result = await caller().getBenchmarkCharges({
      ...baseInput,
      poolLimit: 1,
    });

    expect(result.pools).toHaveLength(1);
    expect(result.hasMorePools).toBe(true);
    expect(result.pools[0]!.poolSlug).toBe('first');
  });

  it('rejects another user personal filter like every other usage query', async () => {
    await expect(
      caller().getBenchmarkCharges({ ...baseInput, userIds: ['someone-else'] })
    ).rejects.toThrow(TRPCError);
    expect(mockExecuteSnowflakeStatement).not.toHaveBeenCalled();
  });

  it('requires org billing access for an org-wide benchmark view', async () => {
    mockEnsureOrganizationAccess.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    await expect(
      caller().getBenchmarkCharges({
        ...baseInput,
        organizationId: ORG,
        viewAs: 'org-wide',
      })
    ).rejects.toThrow(TRPCError);
    expect(mockExecuteSnowflakeStatement).not.toHaveBeenCalled();
  });
});

describe('BenchmarkChargesInputSchema', () => {
  it('bounds the pool limit and defaults it to the maximum', () => {
    expect(BenchmarkChargesInputSchema.parse(baseInput).poolLimit).toBe(100);
    expect(BenchmarkChargesInputSchema.safeParse({ ...baseInput, poolLimit: 0 }).success).toBe(
      false
    );
    expect(BenchmarkChargesInputSchema.safeParse({ ...baseInput, poolLimit: 101 }).success).toBe(
      false
    );
  });

  it('does not accept a client-supplied benchmarkProjects flag', () => {
    const parsed = BenchmarkChargesInputSchema.parse({ ...baseInput, benchmarkProjects: false });
    expect('benchmarkProjects' in parsed).toBe(false);
  });
});
