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
 * One statement, one result set: the procedure issues exactly one Snowflake
 * query, so a fixture is the whole answer. Snowflake returns every cell as
 * text, so fixtures are strings too.
 *
 * Columns: pool, model, cost, request_count, pool_cost, pool_request_count,
 * pool_rank.
 */
function mockSnowflake(rows: SnowflakeRow[]) {
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
  mockExecuteSnowflakeStatement.mockResolvedValueOnce(rows);
}

/** One ranked model row; `poolRank` defaults to the first pool. */
function modelRow(
  pool: string,
  model: string,
  cost: string,
  requests: string,
  poolCost: string,
  poolRequests: string,
  poolRank = '1'
): SnowflakeRow {
  return [pool, model, cost, requests, poolCost, poolRequests, poolRank];
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
  it('returns an empty state from one statement when no pool matched', async () => {
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

  it('reads pools and their models from ONE statement', async () => {
    const id = poolId('user', 'my-pool');
    mockSnowflake([modelRow(id, 'model-a', '5000000', '3', '5000000', '3')]);
    await caller().getBenchmarkCharges(baseInput);

    // Two statements is exactly the defect: pool and model aggregates could
    // then see different row sets.
    expect(mockExecuteSnowflakeStatement).toHaveBeenCalledTimes(1);
    const [request] = mockExecuteSnowflakeStatement.mock.calls[0]!;
    expect(request.statement).toContain('project_id LIKE ?');
    expect(request.bindings).toContainEqual({ type: 'TEXT', value: 'Auto-routing benchmarks / %' });
    // Window sums/ranks compute before the transport cap.
    expect(request.statement).toContain('SUM(cost) OVER (PARTITION BY pool)');
    expect(request.statement).toContain('ROW_NUMBER() OVER (PARTITION BY pool');
    expect(request.statement).toContain('DENSE_RANK() OVER (ORDER BY pool_cost DESC, pool ASC)');
  });

  it('groups a pool with its concrete models and folds the remainder', async () => {
    const id = poolId('user', 'my-pool');
    const other = poolId('user', 'other-pool', OTHER_ROUTER_ID);
    const rows: SnowflakeRow[] = [];
    // 20 listed models of 200k each inside a 5M pool: the remaining 1M is the
    // folded remainder. A windowed pool total larger than the sum of the model
    // rows it was computed from cannot happen, which is the point of using one
    // statement.
    for (let i = 0; i < MAX_BENCHMARK_MODELS_PER_POOL; i++) {
      rows.push(modelRow(id, `model-${i}`, '200000', '1', '5000000', '24'));
    }
    // A second pool below the first in the ranking.
    rows.push(modelRow(other, 'model-x', '1000000', '1', '1000000', '1', '2'));

    mockSnowflake(rows);
    const result = await caller().getBenchmarkCharges(baseInput);

    expect(result.status).toBe('ok');
    expect(result.totalCostMicrodollars).toBe(6_000_000);
    expect(result.totalRequestCount).toBe(25);

    const [pool, second] = result.pools;
    expect(pool).toMatchObject({
      projectId: id,
      poolSlug: 'my-pool',
      routerId: ROUTER_ID,
      poolScope: 'user',
      costMicrodollars: 5_000_000,
      requestCount: 24,
    });
    expect(pool!.models).toHaveLength(MAX_BENCHMARK_MODELS_PER_POOL);
    // A real remainder: the pool total comes from the SAME snapshot as the
    // models, so listed + remainder is exactly the pool total and never
    // negative. Only one model row exists for `other`, so it lists one.
    const listedCost = pool!.models.reduce((sum, m) => sum + m.costMicrodollars, 0);
    const listedRequests = pool!.models.reduce((sum, m) => sum + m.requestCount, 0);
    expect(listedCost + pool!.otherModelsCostMicrodollars).toBe(5_000_000);
    expect(listedRequests + pool!.otherModelsRequestCount).toBe(24);
    expect(pool!.otherModelsCostMicrodollars).toBe(1_000_000);
    expect(pool!.otherModelsRequestCount).toBe(4);
    expect(second).toMatchObject({ costMicrodollars: 1_000_000, poolSlug: 'other-pool' });
    expect(second!.otherModelsCostMicrodollars).toBe(0);
  });

  it('takes the remainder from the same snapshot as the listed models', async () => {
    // The race symptom was a pool total summed from one query and its models
    // from another: listed cost could then exceed the pool total and render a
    // negative remainder. Both numbers now come from this single result row's
    // window total and model costs, so the remainder is their exact difference
    // and can never be negative for a consistent row.
    const id = poolId('user', 'my-pool');
    mockSnowflake([modelRow(id, 'model-a', '1000000', '1', '4000000', '2')]);

    const result = await caller().getBenchmarkCharges(baseInput);
    const [pool] = result.pools;
    expect(pool!.models).toEqual([
      { model: 'model-a', costMicrodollars: 1_000_000, requestCount: 1 },
    ]);
    expect(pool!.otherModelsCostMicrodollars).toBe(3_000_000);
    expect(pool!.otherModelsRequestCount).toBe(1);
    // Pool total equals listed models plus remainder: the invariant the old
    // two-statement version could break.
    expect(
      pool!.models.reduce((sum, m) => sum + m.costMicrodollars, 0) +
        pool!.otherModelsCostMicrodollars
    ).toBe(pool!.costMicrodollars);
  });

  it('ignores rows whose project id is not a complete benchmark pool id', async () => {
    mockSnowflake([
      modelRow('not-a-benchmark-project', 'model-a', '9000000', '9', '9000000', '9'),
      modelRow(`${BENCHMARK_PROJECT_PREFIX} / platform`, 'model-b', '1000000', '1', '1000000', '1'),
      modelRow(
        `${BENCHMARK_PROJECT_PREFIX} / org/broken`,
        'model-c',
        '1000000',
        '1',
        '1000000',
        '1'
      ),
      modelRow(
        `${BENCHMARK_PROJECT_PREFIX} / org/my-pool/not-a-uuid`,
        'model-d',
        '1000000',
        '1',
        '1000000',
        '1'
      ),
    ]);
    const result = await caller().getBenchmarkCharges(baseInput);
    expect(result.status).toBe('empty');
  });

  it('keeps two pools that share a slug distinct by router id', async () => {
    const first = poolId('org', 'shared', ROUTER_ID);
    const second = poolId('org', 'shared', OTHER_ROUTER_ID);
    mockSnowflake([
      modelRow(first, 'model-a', '2000000', '2', '2000000', '2', '1'),
      modelRow(second, 'model-b', '1000000', '1', '1000000', '1', '2'),
    ]);

    const result = await caller().getBenchmarkCharges({
      ...baseInput,
      organizationId: ORG,
      viewAs: 'org-wide',
    });

    expect(result.pools.map(p => p.projectId)).toEqual([first, second]);
    expect(new Set(result.pools.map(p => p.projectId)).size).toBe(2);
    expect(result.pools.every(p => p.poolSlug === 'shared')).toBe(true);
    expect(result.pools.map(p => p.routerId)).toEqual([ROUTER_ID, OTHER_ROUTER_ID]);
  });

  it('caps returned pools and says so when a later rank exists', async () => {
    const first = poolId('user', 'first');
    const second = poolId('user', 'second', OTHER_ROUTER_ID);
    mockSnowflake([
      modelRow(first, 'model-a', '3000000', '3', '3000000', '3', '1'),
      modelRow(second, 'model-b', '1000000', '1', '1000000', '1', '2'),
    ]);

    const result = await caller().getBenchmarkCharges({ ...baseInput, poolLimit: 1 });

    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]!.poolSlug).toBe('first');
    // The capped pool keeps its true total; the overflowed pool only sets the flag.
    expect(result.pools[0]!.costMicrodollars).toBe(3_000_000);
    expect(result.hasMorePools).toBe(true);
    expect(result.totalCostMicrodollars).toBe(3_000_000);
  });

  it('reports no extra pools when the ranking fits the cap', async () => {
    const id = poolId('user', 'only');
    mockSnowflake([modelRow(id, 'model-a', '2000000', '2', '2000000', '2')]);
    const result = await caller().getBenchmarkCharges({ ...baseInput, poolLimit: 5 });
    expect(result.hasMorePools).toBe(false);
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
