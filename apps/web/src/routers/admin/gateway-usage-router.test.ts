jest.mock('@/lib/snowflake', () => ({
  resolveSnowflakeConfig: jest.fn(),
  executeSnowflakeStatement: jest.fn(),
}));
jest.mock('@/lib/admin/admin-access-log', () => ({ emitAdminAccessEvent: jest.fn() }));
jest.mock('@/lib/redis', () => ({ redisClient: {} }));

import {
  executeSnowflakeStatement,
  resolveSnowflakeConfig,
  type SnowflakeConfig,
  type SnowflakeRow,
} from '@/lib/snowflake';
import { defineTestUser } from '@/tests/helpers/user.helper';
import { adminGatewayUsageRouter } from './gateway-usage-router';

const mockResolveConfig = jest.mocked(resolveSnowflakeConfig);
const mockExecute = jest.mocked(executeSnowflakeStatement);
const CONFIG = {
  accountHost: 'account.snowflakecomputing.com',
  jwtAccountIdentifier: 'ACCOUNT',
  username: 'user',
  role: 'role',
  warehouse: 'warehouse',
  database: 'database',
  schema: 'schema',
  privateKeyPem: 'key',
  publicKeyFingerprint: 'SHA256:fingerprint',
} satisfies SnowflakeConfig;
const INPUT = { year: 2026, month: 9, model: 'anthropic/claude-opus-5' };
const ROW = ['provider-a', 'false', '10', '8', '100', '200', '30', '40', '50.25', '60.50'];
const SANITIZED_ERROR = {
  code: 'INTERNAL_SERVER_ERROR',
  message: 'Gateway usage data temporarily unavailable',
};
const originalTimeout = process.env.USAGE_QUERY_TIMEOUT_ADMIN_MS;

function caller(isAdmin = true, signal?: AbortSignal) {
  return adminGatewayUsageRouter.createCaller(
    { user: defineTestUser({ is_admin: isAdmin }) },
    { signal }
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  delete process.env.USAGE_QUERY_TIMEOUT_ADMIN_MS;
  mockResolveConfig.mockReturnValue(CONFIG);
  mockExecute.mockResolvedValue([]);
});

afterEach(() => {
  if (originalTimeout === undefined) {
    delete process.env.USAGE_QUERY_TIMEOUT_ADMIN_MS;
  } else {
    process.env.USAGE_QUERY_TIMEOUT_ADMIN_MS = originalTimeout;
  }
  jest.useRealTimers();
});

describe('admin.gatewayUsage.getMonthlyUsage', () => {
  it('uses the exact warehouse filters, aggregate columns and grouping without joins or rollups', async () => {
    await caller().getMonthlyUsage(INPUT);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const request = mockExecute.mock.calls[0][0];
    expect(request.statement.replace(/\s+/g, ' ').trim()).toBe(
      'SELECT provider, is_byok, ' +
        'COUNT(DISTINCT kilo_user_id) AS users, ' +
        "COUNT(DISTINCT CASE WHEN kilo_user_id NOT ILIKE 'anon:%' THEN kilo_user_id END) AS logged_in_users, " +
        'SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, ' +
        'SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens, ' +
        'SUM(cost) AS cost, SUM(market_cost) AS market_cost ' +
        'FROM microdollar_usage WHERE requested_model = ? AND is_user_byok = false ' +
        'AND usage_date >= TO_DATE(?) AND usage_date < TO_DATE(?) ' +
        'GROUP BY provider, is_byok ORDER BY provider, is_byok'
    );
    expect(request).toMatchObject({
      config: CONFIG,
      bindings: [
        { type: 'TEXT', value: INPUT.model },
        { type: 'TEXT', value: '2026-09-01' },
        { type: 'TEXT', value: '2026-10-01' },
      ],
      timeoutSeconds: 600,
      pollTimeoutMs: 630_000,
    });
    expect(request.signal?.aborted).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each<[number, number, string, string]>([
    [2024, 2, '2024-02-01', '2024-03-01'],
    [2026, 12, '2026-12-01', '2027-01-01'],
    [2000, 1, '2000-01-01', '2000-02-01'],
    [9999, 12, '9999-12-01', '10000-01-01'],
  ])('uses calendar month bounds for %s-%s', async (year, month, start, end) => {
    await caller().getMonthlyUsage({ ...INPUT, year, month });
    expect(mockExecute.mock.calls[0][0].bindings?.map(binding => binding.value)).toEqual([
      INPUT.model,
      start,
      end,
    ]);
  });

  it('trims model input and binds it rather than interpolating SQL', async () => {
    const model = "model' OR 1=1 --";
    await caller().getMonthlyUsage({ ...INPUT, model: `  ${model}  ` });
    const request = mockExecute.mock.calls[0][0];
    expect(request.bindings?.[0]).toEqual({ type: 'TEXT', value: model });
    expect(request.statement).not.toContain(model);
  });

  it('accepts a model with exactly 256 characters', async () => {
    await expect(caller().getMonthlyUsage({ ...INPUT, model: 'a'.repeat(256) })).resolves.toEqual(
      []
    );
  });

  it.each([
    { year: 1999 },
    { year: 10000 },
    { year: 2026.5 },
    { year: '2026' },
    { month: 0 },
    { month: 13 },
    { month: 1.5 },
    { month: '9' },
    { model: '' },
    { model: ' \t\n ' },
    { model: 'a'.repeat(257) },
    { model: null },
  ])('rejects invalid input %p before querying Snowflake', async invalid => {
    await expect(
      caller().getMonthlyUsage({ ...INPUT, ...invalid } as typeof INPUT)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockResolveConfig).not.toHaveBeenCalled();
  });

  it('preserves numeric strings, decimal precision and negative costs in raw warehouse units', async () => {
    mockExecute.mockResolvedValue([
      [
        'provider-a',
        'true',
        '900719925474099312345',
        '900719925474099300001',
        '123456789012345678901234567890',
        '234567890123456789012345678901',
        '345678901234567890123456789012',
        '456789012345678901234567890123',
        '-12345678901234567890.123456789',
        '23456789012345678901.987654321',
      ],
    ]);

    await expect(caller().getMonthlyUsage(INPUT)).resolves.toEqual([
      {
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
      },
    ]);
  });

  it('preserves nonnegative decimal token sums from scaled NUMBER columns', async () => {
    mockExecute.mockResolvedValue([
      [
        ...ROW.slice(0, 4),
        '9007199254740993.000000000',
        '1.500000000',
        '0.000000000',
        '12345678901234567890.123456789',
        ...ROW.slice(8),
      ],
    ]);

    await expect(caller().getMonthlyUsage(INPUT)).resolves.toEqual([
      expect.objectContaining({
        input_tokens: '9007199254740993.000000000',
        output_tokens: '1.500000000',
        cache_read_tokens: '0.000000000',
        cache_write_tokens: '12345678901234567890.123456789',
      }),
    ]);
  });

  it('preserves null provider, BYOK and aggregate values while keeping zero counts as strings', async () => {
    mockExecute.mockResolvedValue([
      [null, null, '0', '0', null, null, null, null, null, null],
    ] as SnowflakeRow[]);

    await expect(caller().getMonthlyUsage(INPUT)).resolves.toEqual([
      {
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
      },
    ]);
  });

  it.each<[string, boolean]>([
    ['false', false],
    ['true', true],
    ['FALSE', false],
    ['TRUE', true],
  ])('validates and maps Snowflake boolean %s', async (raw, expected) => {
    mockExecute.mockResolvedValue([[ROW[0], raw, ...ROW.slice(2)]]);
    await expect(caller().getMonthlyUsage(INPUT)).resolves.toEqual([
      expect.objectContaining({ is_byok: expected }),
    ]);
  });

  it.each<[number, unknown]>([
    [0, 123],
    [1, 'not-a-boolean'],
    [1, '1'],
    [2, null],
    [2, '1.5'],
    [2, '-1'],
    [3, null],
    [3, 'NaN'],
    [4, '-1'],
    [5, '-1.5'],
    [6, '-0.01'],
    [7, '1.2.3'],
    [6, '1e3'],
    [7, ''],
    [4, 100],
    [8, 'Infinity'],
    [8, '1e5'],
    [9, 'not-a-decimal'],
    [9, ' 1.25 '],
  ])(
    'rejects malformed warehouse column %s value %p with a sanitized error',
    async (column, value) => {
      const row: unknown[] = [...ROW];
      row[column] = value;
      mockExecute.mockResolvedValue([row] as SnowflakeRow[]);

      await expect(caller().getMonthlyUsage(INPUT)).rejects.toMatchObject(SANITIZED_ERROR);
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  it.each([{ row: ROW.slice(0, -1) }, { row: [...ROW, 'extra'] }])(
    'rejects incorrect row widths: %p',
    async ({ row }) => {
      mockExecute.mockResolvedValue([row]);
      await expect(caller().getMonthlyUsage(INPUT)).rejects.toMatchObject(SANITIZED_ERROR);
    }
  );

  it('accepts negative market costs and integer costs without conversion', async () => {
    mockExecute.mockResolvedValue([[...ROW.slice(0, 8), '0', '-10.500000000']]);
    await expect(caller().getMonthlyUsage(INPUT)).resolves.toEqual([
      expect.objectContaining({ cost: '0', market_cost: '-10.500000000' }),
    ]);
  });

  it('returns an empty array when Snowflake returns no rows', async () => {
    await expect(caller().getMonthlyUsage(INPUT)).resolves.toEqual([]);
  });

  it('requires admin access before resolving config or querying Snowflake', async () => {
    await expect(caller(false).getMonthlyUsage(INPUT)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockResolveConfig).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('sanitizes missing Snowflake configuration', async () => {
    mockResolveConfig.mockReturnValue(null);
    await expect(caller().getMonthlyUsage(INPUT)).rejects.toMatchObject(SANITIZED_ERROR);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not expose upstream errors or their causes', async () => {
    mockExecute.mockRejectedValue(new Error('secret upstream statement and credentials'));
    await expect(caller().getMonthlyUsage(INPUT)).rejects.toMatchObject({
      ...SANITIZED_ERROR,
      cause: undefined,
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['20000', '0', '-1', 'NaN', 'Infinity', '2147483648', ''])(
    'enforces a ten-minute minimum for timeout configuration %p',
    async timeout => {
      process.env.USAGE_QUERY_TIMEOUT_ADMIN_MS = timeout;
      await caller().getMonthlyUsage(INPUT);
      expect(mockExecute.mock.calls[0][0]).toMatchObject({
        timeoutSeconds: 600,
        pollTimeoutMs: 630_000,
      });
    }
  );

  it('honors larger valid admin timeouts and rounds the SQL timeout up to seconds', async () => {
    process.env.USAGE_QUERY_TIMEOUT_ADMIN_MS = '720001';
    await caller().getMonthlyUsage(INPUT);
    expect(mockExecute.mock.calls[0][0]).toMatchObject({
      timeoutSeconds: 721,
      pollTimeoutMs: 750_001,
    });
  });

  it('aborts at the query timeout plus 30 seconds and clears its timer', async () => {
    mockExecute.mockImplementation(({ signal }) => {
      if (!signal) throw new Error('Expected query signal');
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const result = caller().getMonthlyUsage(INPUT);
    const rejected = expect(result).rejects.toMatchObject(SANITIZED_ERROR);

    await jest.advanceTimersByTimeAsync(629_999);
    expect(mockExecute.mock.calls[0][0].signal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await rejected;

    expect(mockExecute.mock.calls[0][0].signal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('combines the procedure request signal with its timeout controller', async () => {
    const controller = new AbortController();
    mockExecute.mockImplementation(({ signal }) => {
      if (!signal) throw new Error('Expected query signal');
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const result = caller(true, controller.signal).getMonthlyUsage(INPUT);
    const rejected = expect(result).rejects.toMatchObject(SANITIZED_ERROR);

    await jest.advanceTimersByTimeAsync(0);
    controller.abort(new Error('request canceled'));
    await rejected;

    expect(mockExecute.mock.calls[0][0].signal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not submit a query for an already-aborted procedure request', async () => {
    await expect(caller(true, AbortSignal.abort()).getMonthlyUsage(INPUT)).rejects.toMatchObject(
      SANITIZED_ERROR
    );
    expect(mockExecute).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
