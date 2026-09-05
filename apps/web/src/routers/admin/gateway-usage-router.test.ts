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
const INPUT = { date: '2026-09-15', hour: 12, model: 'anthropic/claude-opus-5' };
const HOUR_START = '2026-09-15T12:00:00.000Z';
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

describe('admin.gatewayUsage.getHourlyUsage', () => {
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
    await caller().getHourlyUsage(INPUT);

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
        'AND mu.created_at >= $2::timestamptz ' +
        "AND mu.created_at < ($3::timestamptz + interval '1 hour') " +
        'GROUP BY mu.provider, meta.is_byok ORDER BY mu.provider, meta.is_byok'
    );
    expect(executedQuery().params).toEqual([INPUT.model, HOUR_START, HOUR_START]);
  });

  it('waits for SET LOCAL to complete before issuing the aggregation', async () => {
    const started = Promise.withResolvers<void>();
    const timeout = Promise.withResolvers<{ rows: unknown[] }>();
    mockExecute.mockImplementationOnce(() => {
      started.resolve();
      return timeout.promise;
    });
    const result = caller().getHourlyUsage(INPUT);
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
    'binds the final hour of valid calendar date %s and leaves rollover to PostgreSQL',
    async date => {
      const hourStart = `${date}T23:00:00.000Z`;
      mockExecute.mockResolvedValue({ rows: [ROW] });
      await expect(caller().getHourlyUsage({ ...INPUT, date, hour: 23 })).resolves.toEqual([
        { ...ROW, hour_start: hourStart },
      ]);
      expect(executedQuery().params).toEqual([INPUT.model, hourStart, hourStart]);
      expect(executedQuery().sql).toContain('>= $2::timestamptz');
      expect(executedQuery().sql).toContain("< ($3::timestamptz + interval '1 hour')");
    }
  );

  it.each(Array.from({ length: 24 }, (_, hour) => hour))(
    'binds hour %i as a canonical UTC timestamp',
    async hour => {
      const hourStart = `${INPUT.date}T${hour.toString().padStart(2, '0')}:00:00.000Z`;
      mockExecute.mockResolvedValue({ rows: [ROW] });
      await expect(caller().getHourlyUsage({ ...INPUT, hour })).resolves.toEqual([
        { ...ROW, hour_start: hourStart },
      ]);
      expect(executedQuery().params).toEqual([INPUT.model, hourStart, hourStart]);
    }
  );

  it('trims model input and binds it rather than interpolating SQL', async () => {
    const model = "model' OR 1=1 --";
    await caller().getHourlyUsage({ ...INPUT, model: `  ${model}  ` });
    expect(executedQuery().params[0]).toBe(model);
    expect(executedQuery().sql).not.toContain(model);
  });

  it('accepts a model with exactly 256 characters', async () => {
    await expect(caller().getHourlyUsage({ ...INPUT, model: 'a'.repeat(256) })).resolves.toEqual(
      []
    );
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
    { hour: -1 },
    { hour: 24 },
    { hour: 0.5 },
    { hour: 23.5 },
    { hour: NaN },
    { hour: Infinity },
    { hour: -Infinity },
    { hour: '0' },
    { hour: '12' },
    { hour: '' },
    { hour: true },
    { hour: null },
    { hour: undefined },
    { hour: [] },
    { hour: {} },
    { model: '' },
    { model: ' \t\n ' },
    { model: 'a'.repeat(257) },
    { model: null },
    { model: undefined },
  ])('rejects invalid input %p before opening a transaction', async invalid => {
    await expect(
      caller().getHourlyUsage({ ...INPUT, ...invalid } as typeof INPUT)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it.each([
    { year: 2026, month: 9, model: INPUT.model },
    { date: INPUT.date, model: INPUT.model },
  ])('rejects legacy input %p without querying the database', async input => {
    await expect(caller().getHourlyUsage(input as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('attaches only the queried hour to every validated row without mutating SQL results', async () => {
    const rows = [
      ROW,
      {
        ...ROW,
        provider: 'provider-b',
        date: 'unexpected-database-date',
        hour_start: '2026-09-15 11:00:00+00',
      },
    ];
    mockExecute.mockResolvedValue({ rows });
    await expect(caller().getHourlyUsage(INPUT)).resolves.toEqual([
      { ...ROW, hour_start: HOUR_START },
      { ...ROW, provider: 'provider-b', hour_start: HOUR_START },
    ]);
    expect(rows[0]).not.toHaveProperty('hour_start');
    expect(rows[1]).toHaveProperty('date', 'unexpected-database-date');
    expect(rows[1]).toHaveProperty('hour_start', '2026-09-15 11:00:00+00');
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
    await expect(caller().getHourlyUsage(INPUT)).resolves.toEqual([
      { ...row, hour_start: HOUR_START },
    ]);
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
    await expect(caller().getHourlyUsage(INPUT)).resolves.toEqual([
      { ...row, hour_start: HOUR_START },
    ]);
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
    await expect(caller().getHourlyUsage(INPUT)).resolves.toEqual([
      { ...row, hour_start: HOUR_START },
    ]);
  });

  it.each([false, true])('preserves the PostgreSQL boolean %s', async is_byok => {
    mockExecute.mockResolvedValue({ rows: [{ ...ROW, is_byok }] });
    await expect(caller().getHourlyUsage(INPUT)).resolves.toEqual([
      { ...ROW, is_byok, hour_start: HOUR_START },
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
      await expect(caller().getHourlyUsage(INPUT)).rejects.toMatchObject(SANITIZED_ERROR);
    }
  );

  it('accepts negative market costs and integer costs without conversion', async () => {
    const row = { ...ROW, cost: '0', market_cost: '-10.500000000' };
    mockExecute.mockResolvedValue({ rows: [row] });
    await expect(caller().getHourlyUsage(INPUT)).resolves.toEqual([
      { ...row, hour_start: HOUR_START },
    ]);
  });

  it('returns an empty array when PostgreSQL returns no rows', async () => {
    await expect(caller().getHourlyUsage(INPUT)).resolves.toEqual([]);
  });

  it('requires admin access before opening a transaction', async () => {
    await expect(caller(false).getHourlyUsage(INPUT)).rejects.toMatchObject({ code: 'FORBIDDEN' });
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
      await expect(caller().getHourlyUsage(INPUT)).rejects.toMatchObject({
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
    await caller().getHourlyUsage(INPUT);
    expect(executedQuery(0).sql).toBe("SET LOCAL statement_timeout = '600000'");
  });

  it('sets exactly ten minutes in each hourly transaction when no timeout is configured', async () => {
    delete process.env.USAGE_QUERY_TIMEOUT_ADMIN_MS;
    await caller().getHourlyUsage(INPUT);
    await caller().getHourlyUsage({ ...INPUT, hour: 13 });
    expect(mockTransaction).toHaveBeenCalledTimes(2);
    expect(mockExecute).toHaveBeenCalledTimes(4);
    expect(executedQuery(0).sql).toBe("SET LOCAL statement_timeout = '600000'");
    expect(executedQuery(2).sql).toBe("SET LOCAL statement_timeout = '600000'");
    expect(executedQuery(1).params).toEqual([INPUT.model, HOUR_START, HOUR_START]);
    expect(executedQuery(3).params).toEqual([
      INPUT.model,
      '2026-09-15T13:00:00.000Z',
      '2026-09-15T13:00:00.000Z',
    ]);
  });

  it('fails closed in production when readDb would fall back to primary', async () => {
    jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'production' });
    mockUsesSeparateReplica = false;
    await expect(caller().getHourlyUsage(INPUT)).rejects.toMatchObject(SANITIZED_ERROR);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('allows a separately configured replica in production', async () => {
    jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'production' });
    await expect(caller().getHourlyUsage(INPUT)).resolves.toEqual([]);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it.each(['development', 'test'] as const)(
    'allows the local readDb fallback in %s',
    async nodeEnv => {
      jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: nodeEnv });
      mockUsesSeparateReplica = false;
      await expect(caller().getHourlyUsage(INPUT)).resolves.toEqual([]);
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    }
  );

  it('does not open a transaction for an already-aborted request', async () => {
    await expect(caller(true, AbortSignal.abort()).getHourlyUsage(INPUT)).rejects.toMatchObject(
      SANITIZED_ERROR
    );
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('skips aggregation when aborted while waiting for a transaction connection', async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const connection = Promise.withResolvers<void>();
    mockTransaction.mockImplementation(async callback => {
      started.resolve();
      await connection.promise;
      return callback({ execute: mockExecute } as never);
    });

    const result = caller(true, controller.signal).getHourlyUsage(INPUT);
    await started.promise;
    expect(mockExecute).not.toHaveBeenCalled();
    controller.abort();
    connection.resolve();

    await expect(result).rejects.toMatchObject({ ...SANITIZED_ERROR, cause: undefined });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(executedQuery(0).sql).toBe("SET LOCAL statement_timeout = '600000'");
  });

  it('skips aggregation when aborted while SET LOCAL is pending', async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const timeout = Promise.withResolvers<{ rows: unknown[] }>();
    mockExecute.mockImplementationOnce(() => {
      started.resolve();
      return timeout.promise;
    });

    const result = caller(true, controller.signal).getHourlyUsage(INPUT);
    await started.promise;
    controller.abort();
    timeout.resolve({ rows: [] });

    await expect(result).rejects.toMatchObject({ ...SANITIZED_ERROR, cause: undefined });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it.each(['aggregation', 'transaction completion'])(
    'discards the awaited result when aborted during %s',
    async stage => {
      const controller = new AbortController();
      const started = Promise.withResolvers<void>();
      const completion = Promise.withResolvers<{ rows: unknown[] }>();
      if (stage === 'aggregation') {
        mockExecute.mockResolvedValueOnce({ rows: [] }).mockImplementationOnce(() => {
          started.resolve();
          return completion.promise;
        });
      } else {
        mockExecute.mockResolvedValue({ rows: [ROW] });
        mockTransaction.mockImplementation(async callback => {
          const rows = await callback({ execute: mockExecute } as never);
          started.resolve();
          await completion.promise;
          return rows;
        });
      }

      const result = caller(true, controller.signal).getHourlyUsage(INPUT);
      await started.promise;
      controller.abort();
      completion.resolve({ rows: [ROW] });

      await expect(result).rejects.toMatchObject({ ...SANITIZED_ERROR, cause: undefined });
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(mockExecute).toHaveBeenCalledTimes(2);
    }
  );
});

describe('admin.gatewayUsage.getHourlyUsage PostgreSQL semantics', () => {
  let input: typeof INPUT;
  const singleUsage = {
    hour_start: HOUR_START,
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
      created_at: `${input.date} ${input.hour.toString().padStart(2, '0')}:30:00+00`,
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

  it('filters exact model and false user BYOK with an inner join and a half-open UTC hour', async () => {
    await insertUsage({ created_at: '2026-09-15 12:00:00+00' });
    await insertUsage({ created_at: '2026-09-15 12:59:59.999999+00' });
    await insertUsage({ kilo_user_id: 'anon:lowercase' });
    await insertUsage({ kilo_user_id: 'AnOn:mixed-case' });
    await insertUsage({ kilo_user_id: 'ANON-without-colon' });
    await insertUsage({ created_at: '2026-09-15 11:59:59.999999+00' });
    await insertUsage({ created_at: '2026-09-15 13:00:00+00' });
    await insertUsage({ requested_model: 'different-requested-model', model: input.model });
    await insertUsage({ requested_model: input.model.toUpperCase() });
    await insertUsage({ requested_model: `${input.model}-suffix` });
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

    await expect(caller().getHourlyUsage(input)).resolves.toEqual([
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

  it.each<[string, string]>([
    ['2000-01-01', '2000-01-02'],
    ['2000-02-29', '2000-03-01'],
    ['2024-02-28', '2024-02-29'],
    ['2024-02-29', '2024-03-01'],
    ['2026-02-28', '2026-03-01'],
    ['2026-03-08', '2026-03-09'],
    ['2026-04-30', '2026-05-01'],
    ['2026-11-01', '2026-11-02'],
    ['2026-12-31', '2027-01-01'],
    ['2100-02-28', '2100-03-01'],
    ['2400-02-29', '2400-03-01'],
    ['9999-12-31', '10000-01-01'],
  ])('queries hour 23 of %s ending at %s in a non-UTC database session', async (date, next) => {
    input = { ...input, date, hour: 23 };
    await insertUsage({
      created_at: `${date} 22:59:59.999999+00`,
      provider: 'excluded-before',
    });
    await insertUsage({ created_at: `${date} 23:00:00+00` });
    await insertUsage();
    await insertUsage({ created_at: `${date} 23:59:59.999999+00` });
    await insertUsage({ created_at: `${next} 00:00:00+00`, provider: 'excluded-after' });

    await expect(caller().getHourlyUsage(input)).resolves.toEqual([
      {
        ...singleUsage,
        hour_start: `${date}T23:00:00.000Z`,
        input_tokens: '30',
        output_tokens: '60',
        cache_read_tokens: '9',
        cache_write_tokens: '12',
        cost: '300',
        market_cost: '600',
      },
    ]);
  });

  it('queries hour zero at the minimum supported date without including the previous year', async () => {
    input = { ...input, date: '2000-01-01', hour: 0 };
    await insertUsage({ created_at: '1999-12-31 23:59:59.999999+00', provider: 'excluded-before' });
    await insertUsage({ created_at: '2000-01-01 00:00:00+00' });
    await insertUsage({ created_at: '2000-01-01 00:59:59.999999+00' });
    await insertUsage({ created_at: '2000-01-01 01:00:00+00', provider: 'excluded-after' });

    await expect(caller().getHourlyUsage(input)).resolves.toEqual([
      {
        ...singleUsage,
        hour_start: '2000-01-01T00:00:00.000Z',
        input_tokens: '20',
        output_tokens: '40',
        cache_read_tokens: '6',
        cache_write_tokens: '8',
        cost: '200',
        market_cost: '400',
      },
    ]);
  });

  it.each<[string, number, string, string, string, number]>([
    ['2026-09-15', 12, '2026-09-15T12:00:00.000Z', '2026-09-15T13:00:00.000Z', '2026-09-15', 13],
    ['2026-09-15', 23, '2026-09-15T23:00:00.000Z', '2026-09-16T00:00:00.000Z', '2026-09-16', 0],
    ['2026-03-08', 9, '2026-03-08T09:00:00.000Z', '2026-03-08T10:00:00.000Z', '2026-03-08', 10],
    ['2026-11-01', 8, '2026-11-01T08:00:00.000Z', '2026-11-01T09:00:00.000Z', '2026-11-01', 9],
  ])(
    'reports adjacent hours independently from %s hour %i for the same provider and user',
    async (date, hour, start, end, nextDate, nextHour) => {
      input = { ...input, date, hour };
      await insertUsage({ created_at: start });
      await insertUsage();
      await insertUsage({ created_at: end });

      await expect(caller().getHourlyUsage(input)).resolves.toEqual([
        {
          ...singleUsage,
          hour_start: start,
          input_tokens: '20',
          output_tokens: '40',
          cache_read_tokens: '6',
          cache_write_tokens: '8',
          cost: '200',
          market_cost: '400',
        },
      ]);
      await expect(
        caller().getHourlyUsage({ ...input, date: nextDate, hour: nextHour })
      ).resolves.toEqual([{ ...singleUsage, hour_start: end }]);
    }
  );

  it('counts arbitrary user IDs distinctly per group while summing every qualifying row', async () => {
    const userIds = [
      'oauth/google/arbitrary-user',
      'plain-user',
      crypto.randomUUID(),
      'anon:repeated',
      'AnOn:mixed-case',
      'ANON-without-colon',
      'prefix-anon:embedded',
      '',
    ];
    for (const kilo_user_id of userIds) {
      await insertUsage({ kilo_user_id });
      await insertUsage({ kilo_user_id });
    }
    await insertUsage({ provider: 'provider-b', kilo_user_id: 'anon:repeated' });
    await insertUsage(
      { provider: 'provider-b', kilo_user_id: 'anon:repeated' },
      { market_cost: null }
    );

    await expect(caller().getHourlyUsage(input)).resolves.toEqual([
      {
        ...singleUsage,
        users: '8',
        logged_in_users: '6',
        input_tokens: '160',
        output_tokens: '320',
        cache_read_tokens: '48',
        cache_write_tokens: '64',
        cost: '1600',
        market_cost: '3200',
      },
      {
        ...singleUsage,
        provider: 'provider-b',
        logged_in_users: '0',
        input_tokens: '20',
        output_tokens: '40',
        cache_read_tokens: '6',
        cache_write_tokens: '8',
        cost: '200',
      },
    ]);
  });

  it('excludes nonpositive input-token usage from counts, sums, and provider groups', async () => {
    await insertUsage({ input_tokens: 1 });
    await insertUsage({ input_tokens: 0, kilo_user_id: 'excluded-zero-input-user' });
    await insertUsage({ input_tokens: -1, kilo_user_id: 'excluded-negative-input-user' });
    await insertUsage({ input_tokens: 0, provider: 'excluded-provider' });

    await expect(caller().getHourlyUsage(input)).resolves.toEqual([
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

    await expect(caller().getHourlyUsage(input)).resolves.toEqual([
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
        created_at: `${input.date} ${input.hour.toString().padStart(2, '0')}:30:00+00`,
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

    await expect(caller().getHourlyUsage(input)).resolves.toEqual([
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
