import type * as DrizzleModule from '@/lib/drizzle';

jest.mock('@/lib/drizzle', () => {
  const actual = jest.requireActual<typeof DrizzleModule>('@/lib/drizzle');
  return {
    ...actual,
    readDb: { ...actual.readDb, transaction: jest.fn(), execute: jest.fn() },
    get usesSeparateReplica() {
      return mockUsesSeparateReplica;
    },
  };
});
jest.mock('@/lib/admin/admin-access-log', () => ({ emitAdminAccessEvent: jest.fn() }));
jest.mock('@/lib/redis', () => ({ redisClient: {} }));

import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { microdollar_usage, microdollar_usage_metadata } from '@kilocode/db/schema';
import { db, readDb } from '@/lib/drizzle';
import { defineTestUser } from '@/tests/helpers/user.helper';
import { adminGatewayUsageRouter } from './gateway-usage-router';

let mockUsesSeparateReplica = true;
const mockTransaction = jest.mocked(readDb.transaction);
const mockReadExecute = jest.mocked(readDb.execute);
const mockExecute = jest.fn<Promise<{ rows: unknown[] }>, [SQL]>();
const INPUT = { date: '2026-09-15', model: 'anthropic/claude-opus-5' };
const ROW = {
  provider: 'provider-a',
  is_byok: false,
  users: '10',
  logged_in_users: '8',
  input_tokens: '100',
  output_tokens: '200',
  cache_read_tokens: '30',
  cache_write_tokens: '40',
  cost: '50.25',
  market_cost: '60.50',
};
const SANITIZED_ERROR = {
  code: 'INTERNAL_SERVER_ERROR',
  message: 'Gateway usage data temporarily unavailable',
};

function caller(isAdmin = true, signal?: AbortSignal) {
  return adminGatewayUsageRouter.createCaller(
    { user: defineTestUser({ is_admin: isAdmin }) },
    { signal }
  );
}

function executedQuery(index = 1) {
  return new PgDialect().sqlToQuery(mockExecute.mock.calls[index][0]);
}

beforeEach(() => {
  jest.replaceProperty(process, 'env', {
    ...process.env,
    NODE_ENV: 'test',
    USAGE_QUERY_TIMEOUT_ADMIN_MS: '',
  });
  mockUsesSeparateReplica = true;
  mockTransaction.mockReset();
  mockReadExecute.mockReset();
  mockExecute.mockReset().mockResolvedValue({ rows: [] });
  mockTransaction.mockImplementation(async callback => callback({ execute: mockExecute } as never));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('admin.gatewayUsage.getDailyUsage', () => {
  beforeEach(() => {
    jest.spyOn(db, 'transaction').mockRejectedValue(new Error('Unexpected primary transaction'));
    jest.spyOn(db, 'execute').mockRejectedValue(new Error('Unexpected primary query'));
  });

  afterEach(() => {
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
    expect(mockReadExecute).not.toHaveBeenCalled();
  });

  it('runs text aggregates and parameterized filters in a replica-only timed transaction', async () => {
    await caller().getDailyUsage(INPUT);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(executedQuery(0)).toMatchObject({
      sql: "SET LOCAL statement_timeout = '600000'",
      params: [],
    });
    expect(executedQuery().sql.replace(/\s+/g, ' ').trim()).toBe(
      'SELECT mu.provider, meta.is_byok, ' +
        'COUNT(DISTINCT mu.kilo_user_id)::text AS users, ' +
        "COUNT(DISTINCT CASE WHEN mu.kilo_user_id NOT ILIKE 'anon:%' THEN mu.kilo_user_id END)::text AS logged_in_users, " +
        'SUM(mu.input_tokens)::text AS input_tokens, SUM(mu.output_tokens)::text AS output_tokens, ' +
        'SUM(mu.cache_hit_tokens)::text AS cache_read_tokens, SUM(mu.cache_write_tokens)::text AS cache_write_tokens, ' +
        'SUM(mu.cost)::text AS cost, SUM(meta.market_cost)::text AS market_cost ' +
        'FROM microdollar_usage mu INNER JOIN microdollar_usage_metadata meta ON mu.id = meta.id ' +
        'WHERE mu.requested_model = $1 AND meta.is_user_byok = false AND mu.input_tokens > 0 ' +
        "AND mu.created_at >= ($2::date::timestamp AT TIME ZONE 'UTC') " +
        "AND mu.created_at < (($3::date + 1)::timestamp AT TIME ZONE 'UTC') " +
        'GROUP BY mu.provider, meta.is_byok ORDER BY mu.provider, meta.is_byok'
    );
    expect(executedQuery().params).toEqual([INPUT.model, INPUT.date, INPUT.date]);
  });

  it('waits for SET LOCAL to complete before issuing the aggregation', async () => {
    const started = Promise.withResolvers<void>();
    const timeout = Promise.withResolvers<{ rows: unknown[] }>();
    mockExecute.mockImplementationOnce(() => {
      started.resolve();
      return timeout.promise;
    });
    const result = caller().getDailyUsage(INPUT);
    await started.promise;
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(executedQuery(0).sql).toBe("SET LOCAL statement_timeout = '600000'");
    timeout.resolve({ rows: [] });
    await expect(result).resolves.toEqual([]);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it.each([
    '2000-01-01',
    '2000-02-29',
    '2024-02-28',
    '2024-02-29',
    '2026-02-28',
    '2026-03-08',
    '2026-04-30',
    '2026-11-01',
    '2026-12-31',
    '2100-02-28',
    '2400-02-29',
    '9999-12-31',
  ])(
    'binds valid calendar date %s and leaves next-day UTC arithmetic to PostgreSQL',
    async date => {
      mockExecute.mockResolvedValue({ rows: [ROW] });
      await expect(caller().getDailyUsage({ ...INPUT, date })).resolves.toEqual([{ ...ROW, date }]);
      expect(executedQuery().params).toEqual([INPUT.model, date, date]);
      expect(executedQuery().sql).toContain(">= ($2::date::timestamp AT TIME ZONE 'UTC')");
      expect(executedQuery().sql).toContain("< (($3::date + 1)::timestamp AT TIME ZONE 'UTC')");
    }
  );

  it('trims model input and binds it rather than interpolating SQL', async () => {
    const model = "model' OR 1=1 --";
    await caller().getDailyUsage({ ...INPUT, model: `  ${model}  ` });
    expect(executedQuery().params[0]).toBe(model);
    expect(executedQuery().sql).not.toContain(model);
  });

  it('accepts a model with exactly 256 characters', async () => {
    await expect(caller().getDailyUsage({ ...INPUT, model: 'a'.repeat(256) })).resolves.toEqual([]);
  });

  it.each([
    { date: '1999-12-31' },
    { date: '0000-01-01' },
    { date: '10000-01-01' },
    { date: '+010000-01-01' },
    { date: '2026-02-29' },
    { date: '2100-02-29' },
    { date: '2200-02-29' },
    { date: '2300-02-29' },
    { date: '2024-02-30' },
    { date: '2026-04-31' },
    { date: '2026-09-31' },
    { date: '2026-01-00' },
    { date: '2026-01-32' },
    { date: '2026-00-15' },
    { date: '2026-13-15' },
    { date: '2026-9-15' },
    { date: '2026-09-5' },
    { date: '26-09-15' },
    { date: '2026/09/15' },
    { date: '2026-09' },
    { date: '2026-09-15T00:00:00Z' },
    { date: '2026-09-15 00:00:00+00' },
    { date: ' 2026-09-15' },
    { date: '2026-09-15 ' },
    { date: '2026-09-15\n' },
    { date: "2026-09-15' OR 1=1 --" },
    { date: '' },
    { date: 'not-a-date' },
    { date: 20260915 },
    { date: new Date('2026-09-15T00:00:00Z') },
    { date: null },
    { date: undefined },
    { model: '' },
    { model: ' \t\n ' },
    { model: 'a'.repeat(257) },
    { model: null },
    { model: undefined },
  ])('rejects invalid input %p before opening a transaction', async invalid => {
    await expect(
      caller().getDailyUsage({ ...INPUT, ...invalid } as typeof INPUT)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('rejects the old monthly input without querying the database', async () => {
    await expect(
      caller().getDailyUsage({ year: 2026, month: 9, model: INPUT.model } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('attaches the queried date to every validated row without mutating SQL results', async () => {
    const rows = [ROW, { ...ROW, provider: 'provider-b', date: 'unexpected-database-date' }];
    mockExecute.mockResolvedValue({ rows });
    await expect(caller().getDailyUsage(INPUT)).resolves.toEqual([
      { ...ROW, date: INPUT.date },
      { ...ROW, provider: 'provider-b', date: INPUT.date },
    ]);
    expect(rows[0]).not.toHaveProperty('date');
    expect(rows[1]).toHaveProperty('date', 'unexpected-database-date');
  });

  it('preserves large numeric strings and decimal precision in microdollar costs', async () => {
    const row = {
      provider: 'provider-a',
      is_byok: true,
      users: '900719925474099312345',
      logged_in_users: '900719925474099300001',
      input_tokens: '123456789012345678901234567890',
      output_tokens: '234567890123456789012345678901',
      cache_read_tokens: '345678901234567890123456789012',
      cache_write_tokens: '456789012345678901234567890123',
      cost: '-12345678901234567890.123456789',
      market_cost: '23456789012345678901.987654321',
    };
    mockExecute.mockResolvedValue({ rows: [row] });
    await expect(caller().getDailyUsage(INPUT)).resolves.toEqual([{ ...row, date: INPUT.date }]);
  });

  it('keeps the existing nonnegative decimal token sum contract', async () => {
    const row = {
      ...ROW,
      input_tokens: '9007199254740993.000000000',
      output_tokens: '1.500000000',
      cache_read_tokens: '0.000000000',
      cache_write_tokens: '12345678901234567890.123456789',
    };
    mockExecute.mockResolvedValue({ rows: [row] });
    await expect(caller().getDailyUsage(INPUT)).resolves.toEqual([{ ...row, date: INPUT.date }]);
  });

  it('preserves null provider, BYOK and aggregates while keeping zero counts as strings', async () => {
    const row = {
      provider: null,
      is_byok: null,
      users: '0',
      logged_in_users: '0',
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      cost: null,
      market_cost: null,
    };
    mockExecute.mockResolvedValue({ rows: [row] });
    await expect(caller().getDailyUsage(INPUT)).resolves.toEqual([{ ...row, date: INPUT.date }]);
  });

  it.each([false, true])('preserves the PostgreSQL boolean %s', async is_byok => {
    mockExecute.mockResolvedValue({ rows: [{ ...ROW, is_byok }] });
    await expect(caller().getDailyUsage(INPUT)).resolves.toEqual([
      { ...ROW, is_byok, date: INPUT.date },
    ]);
  });

  it.each<[keyof typeof ROW, unknown]>([
    ['provider', 123],
    ['is_byok', 'false'],
    ['is_byok', 'true'],
    ['is_byok', '1'],
    ['users', null],
    ['users', '1.5'],
    ['users', '-1'],
    ['users', 10],
    ['logged_in_users', null],
    ['logged_in_users', 'NaN'],
    ['input_tokens', '-1'],
    ['output_tokens', '-1.5'],
    ['cache_read_tokens', '-0.01'],
    ['cache_write_tokens', '1.2.3'],
    ['cache_read_tokens', '1e3'],
    ['cache_write_tokens', ''],
    ['input_tokens', 100],
    ['cost', 'Infinity'],
    ['cost', '1e5'],
    ['market_cost', 'not-a-decimal'],
    ['market_cost', ' 1.25 '],
    ['market_cost', undefined],
  ])(
    'rejects malformed database column %s value %p with a generic error',
    async (column, value) => {
      mockExecute.mockResolvedValue({ rows: [{ ...ROW, [column]: value }] });
      await expect(caller().getDailyUsage(INPUT)).rejects.toMatchObject(SANITIZED_ERROR);
    }
  );

  it('accepts negative market costs and integer costs without conversion', async () => {
    const row = { ...ROW, cost: '0', market_cost: '-10.500000000' };
    mockExecute.mockResolvedValue({ rows: [row] });
    await expect(caller().getDailyUsage(INPUT)).resolves.toEqual([{ ...row, date: INPUT.date }]);
  });

  it('returns an empty array when PostgreSQL returns no rows', async () => {
    await expect(caller().getDailyUsage(INPUT)).resolves.toEqual([]);
  });

  it('requires admin access before opening a transaction', async () => {
    await expect(caller(false).getDailyUsage(INPUT)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it.each(['transaction', 'timeout', 'aggregation'])(
    'does not retry a failed %s on primary',
    async stage => {
      const error = new Error('database query failed');
      if (stage === 'transaction') {
        mockTransaction.mockRejectedValue(error);
      } else if (stage === 'timeout') {
        mockExecute.mockRejectedValueOnce(error);
      } else {
        mockExecute.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(error);
      }
      await expect(caller().getDailyUsage(INPUT)).rejects.toMatchObject({
        ...SANITIZED_ERROR,
        cause: undefined,
      });
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(mockExecute).toHaveBeenCalledTimes(
        stage === 'transaction' ? 0 : stage === 'timeout' ? 1 : 2
      );
    }
  );

  it.each([
    '20000',
    '0',
    '-1',
    'NaN',
    'Infinity',
    '2147483648',
    '720000.5',
    'invalid',
    '',
    '600000',
    '720001',
    '2147483647',
  ])('uses exactly ten minutes regardless of timeout configuration %p', async timeout => {
    process.env.USAGE_QUERY_TIMEOUT_ADMIN_MS = timeout;
    await caller().getDailyUsage(INPUT);
    expect(executedQuery(0).sql).toBe("SET LOCAL statement_timeout = '600000'");
  });

  it('sets exactly ten minutes in each daily transaction when no timeout is configured', async () => {
    delete process.env.USAGE_QUERY_TIMEOUT_ADMIN_MS;
    await caller().getDailyUsage(INPUT);
    await caller().getDailyUsage({ ...INPUT, date: '2026-09-16' });
    expect(mockTransaction).toHaveBeenCalledTimes(2);
    expect(mockExecute).toHaveBeenCalledTimes(4);
    expect(executedQuery(0).sql).toBe("SET LOCAL statement_timeout = '600000'");
    expect(executedQuery(2).sql).toBe("SET LOCAL statement_timeout = '600000'");
    expect(executedQuery(1).params).toEqual([INPUT.model, INPUT.date, INPUT.date]);
    expect(executedQuery(3).params).toEqual([INPUT.model, '2026-09-16', '2026-09-16']);
  });

  it('fails closed in production when readDb would fall back to primary', async () => {
    jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'production' });
    mockUsesSeparateReplica = false;
    await expect(caller().getDailyUsage(INPUT)).rejects.toMatchObject(SANITIZED_ERROR);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('allows a separately configured replica in production', async () => {
    jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'production' });
    await expect(caller().getDailyUsage(INPUT)).resolves.toEqual([]);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it.each(['development', 'test'] as const)(
    'allows the local readDb fallback in %s',
    async nodeEnv => {
      jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: nodeEnv });
      mockUsesSeparateReplica = false;
      await expect(caller().getDailyUsage(INPUT)).resolves.toEqual([]);
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    }
  );

  it('does not open a transaction for an already-aborted request', async () => {
    await expect(caller(true, AbortSignal.abort()).getDailyUsage(INPUT)).rejects.toMatchObject(
      SANITIZED_ERROR
    );
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe('admin.gatewayUsage.getDailyUsage PostgreSQL semantics', () => {
  let input: typeof INPUT;
  const singleUsage = {
    date: INPUT.date,
    provider: 'provider-a',
    is_byok: false,
    users: '1',
    logged_in_users: '1',
    input_tokens: '10',
    output_tokens: '20',
    cache_read_tokens: '3',
    cache_write_tokens: '4',
    cost: '100',
    market_cost: '200',
  };

  beforeEach(() => {
    input = { ...INPUT, model: `gateway-usage-test-${crypto.randomUUID()}` };
    mockUsesSeparateReplica = false;
    mockTransaction.mockImplementation(callback =>
      db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL TIME ZONE 'America/Los_Angeles'`);
        return callback(tx);
      })
    );
  });

  async function insertUsage(
    core: Partial<typeof microdollar_usage.$inferInsert> = {},
    metadata: Partial<typeof microdollar_usage_metadata.$inferInsert> | null = {}
  ) {
    const id = crypto.randomUUID();
    await db.insert(microdollar_usage).values({
      id,
      kilo_user_id: 'oauth/google/test-user',
      provider: 'provider-a',
      model: 'different-resolved-model',
      requested_model: input.model,
      created_at: `${input.date} 12:00:00+00`,
      input_tokens: 10,
      output_tokens: 20,
      cache_hit_tokens: 3,
      cache_write_tokens: 4,
      cost: 100,
      ...core,
    });
    if (metadata !== null) {
      await db.insert(microdollar_usage_metadata).values({
        id,
        message_id: id,
        created_at: '2026-08-01 00:00:00+00',
        is_byok: false,
        is_user_byok: false,
        market_cost: 200,
        ...metadata,
      });
    }
  }

  it('filters exact model and false user BYOK with an inner join and a half-open UTC day', async () => {
    await insertUsage({ created_at: '2026-09-15 00:00:00+00' });
    await insertUsage({ created_at: '2026-09-15 23:59:59.999999+00' });
    await insertUsage({ kilo_user_id: 'anon:lowercase' });
    await insertUsage({ kilo_user_id: 'AnOn:mixed-case' });
    await insertUsage({ kilo_user_id: 'ANON-without-colon' });
    await insertUsage({ created_at: '2026-09-14 23:59:59.999999+00' });
    await insertUsage({ created_at: '2026-09-16 00:00:00+00' });
    await insertUsage({ requested_model: 'different-requested-model', model: input.model });
    await insertUsage({ requested_model: null });
    await insertUsage({}, { is_user_byok: true });
    await insertUsage({}, { is_user_byok: null });
    await insertUsage({}, null);
    await db.insert(microdollar_usage_metadata).values({
      id: crypto.randomUUID(),
      message_id: 'orphan-metadata',
      is_user_byok: false,
      is_byok: false,
      market_cost: 1000,
    });

    await expect(caller().getDailyUsage(input)).resolves.toEqual([
      {
        ...singleUsage,
        users: '4',
        logged_in_users: '2',
        input_tokens: '50',
        output_tokens: '100',
        cache_read_tokens: '15',
        cache_write_tokens: '20',
        cost: '500',
        market_cost: '1000',
      },
    ]);
  });

  it.each<[string, string, string]>([
    ['2000-01-01', '1999-12-31', '2000-01-02'],
    ['2000-02-29', '2000-02-28', '2000-03-01'],
    ['2024-02-28', '2024-02-27', '2024-02-29'],
    ['2024-02-29', '2024-02-28', '2024-03-01'],
    ['2026-02-28', '2026-02-27', '2026-03-01'],
    ['2026-03-08', '2026-03-07', '2026-03-09'],
    ['2026-04-30', '2026-04-29', '2026-05-01'],
    ['2026-11-01', '2026-10-31', '2026-11-02'],
    ['2026-12-31', '2026-12-30', '2027-01-01'],
    ['2100-02-28', '2100-02-27', '2100-03-01'],
    ['2400-02-29', '2400-02-28', '2400-03-01'],
    ['9999-12-31', '9999-12-30', '10000-01-01'],
  ])('queries exactly UTC day %s in a non-UTC database session', async (date, previous, next) => {
    input = { ...input, date };
    await insertUsage({
      created_at: `${previous} 23:59:59.999999+00`,
      provider: 'excluded-before',
    });
    await insertUsage({ created_at: `${date} 00:00:00+00` });
    await insertUsage();
    await insertUsage({ created_at: `${date} 23:59:59.999999+00` });
    await insertUsage({ created_at: `${next} 00:00:00+00`, provider: 'excluded-after' });

    await expect(caller().getDailyUsage(input)).resolves.toEqual([
      {
        ...singleUsage,
        date,
        input_tokens: '30',
        output_tokens: '60',
        cache_read_tokens: '9',
        cache_write_tokens: '12',
        cost: '300',
        market_cost: '600',
      },
    ]);
  });

  it('reports adjacent days independently for the same provider and user', async () => {
    await insertUsage({ created_at: '2026-09-15 00:00:00+00' });
    await insertUsage({ created_at: '2026-09-15 23:59:59.999999+00' });
    await insertUsage({ created_at: '2026-09-16 00:00:00+00' });

    await expect(caller().getDailyUsage(input)).resolves.toEqual([
      {
        ...singleUsage,
        input_tokens: '20',
        output_tokens: '40',
        cache_read_tokens: '6',
        cache_write_tokens: '8',
        cost: '200',
        market_cost: '400',
      },
    ]);
    await expect(caller().getDailyUsage({ ...input, date: '2026-09-16' })).resolves.toEqual([
      { ...singleUsage, date: '2026-09-16' },
    ]);
  });

  it('excludes nonpositive input-token usage from counts, sums, and provider groups', async () => {
    await insertUsage({ input_tokens: 1 });
    await insertUsage({ input_tokens: 0, kilo_user_id: 'excluded-zero-input-user' });
    await insertUsage({ input_tokens: -1, kilo_user_id: 'excluded-negative-input-user' });
    await insertUsage({ input_tokens: 0, provider: 'excluded-provider' });

    await expect(caller().getDailyUsage(input)).resolves.toEqual([
      { ...singleUsage, input_tokens: '1' },
    ]);
  });

  it('groups provider and nullable real BYOK booleans without coalescing all-null market costs', async () => {
    await insertUsage({}, { market_cost: null });
    await insertUsage({}, { market_cost: null });
    await insertUsage({}, { is_byok: true, market_cost: 0 });
    await insertUsage({}, { is_byok: null, market_cost: -20 });
    await insertUsage({ provider: 'provider-b' });
    await insertUsage({ provider: null }, { is_byok: null });

    await expect(caller().getDailyUsage(input)).resolves.toEqual([
      {
        ...singleUsage,
        input_tokens: '20',
        output_tokens: '40',
        cache_read_tokens: '6',
        cache_write_tokens: '8',
        cost: '200',
        market_cost: null,
      },
      { ...singleUsage, is_byok: true, market_cost: '0' },
      { ...singleUsage, is_byok: null, market_cost: '-20' },
      { ...singleUsage, provider: 'provider-b' },
      { ...singleUsage, provider: null, is_byok: null },
    ]);
  });

  it('returns exact text sums beyond bigint and JavaScript integer ranges in microdollars', async () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const large = '9223372036854775807';
    await db.insert(microdollar_usage).values(
      ids.map(id => ({
        id,
        kilo_user_id: 'oauth/google/test-user',
        provider: 'provider-a',
        requested_model: input.model,
        created_at: `${input.date} 12:00:00+00`,
        input_tokens: sql`${large}::bigint`,
        output_tokens: sql`${large}::bigint`,
        cache_hit_tokens: sql`${large}::bigint`,
        cache_write_tokens: sql`${large}::bigint`,
        cost: sql`${`-${large}`}::bigint`,
      }))
    );
    await db.insert(microdollar_usage_metadata).values(
      ids.map(id => ({
        id,
        message_id: id,
        is_byok: true,
        is_user_byok: false,
        market_cost: sql`${large}::bigint`,
      }))
    );

    await expect(caller().getDailyUsage(input)).resolves.toEqual([
      {
        ...singleUsage,
        is_byok: true,
        input_tokens: '18446744073709551614',
        output_tokens: '18446744073709551614',
        cache_read_tokens: '18446744073709551614',
        cache_write_tokens: '18446744073709551614',
        cost: '-18446744073709551614',
        market_cost: '18446744073709551614',
      },
    ]);
  });
});
