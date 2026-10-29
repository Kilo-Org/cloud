jest.mock('@kilocode/web-shared/lib/redis', () => ({ redisClient: {} }));
jest.mock('@/lib/snowflake', () => ({
  resolveSnowflakeConfig: jest.fn(),
  executeSnowflakeStatement: jest.fn(),
}));

import {
  executeSnowflakeStatement,
  resolveSnowflakeConfig,
  type SnowflakeConfig,
  type SnowflakeRow,
} from '@/lib/snowflake';
import { defineTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  AI_REQUESTS_PAGE_SIZE,
  ListAiRequestsInputSchema,
  buildAiRequestsQuery,
  parseAiRequestRow,
  toKeySource,
  userAiRequestsRouter,
} from './user-ai-requests-router';

const mockResolveSnowflakeConfig = jest.mocked(resolveSnowflakeConfig);
const mockExecute = jest.mocked(executeSnowflakeStatement);

const CTX_USER = 'user-ctx';
const SNOWFLAKE_CONFIG = {
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

const range = {
  startDate: '2026-10-20T00:00:00.000Z',
  endDate: '2026-10-27T00:00:00.000Z',
};

function caller() {
  return userAiRequestsRouter.createCaller({ user: defineTestUser({ id: CTX_USER }) });
}

function row(index: number, overrides: Partial<Record<number, string | null>> = {}): SnowflakeRow {
  const base: (string | null)[] = [
    `00000000-0000-4000-8000-${String(1000 - index).padStart(12, '0')}`,
    `2026-10-26T12:00:${String(59 - (index % 60)).padStart(2, '0')}.000000Z`,
    'anthropic/claude-sonnet-4.5',
    'anthropic/claude-sonnet-4.5',
    'anthropic',
    'vscode-extension',
    '1200',
    '340',
    '0',
    '800',
    '0',
    'true',
    'false',
  ];
  for (const [key, value] of Object.entries(overrides)) base[Number(key)] = value ?? null;
  return base as SnowflakeRow;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockResolveSnowflakeConfig.mockReturnValue(SNOWFLAKE_CONFIG);
});

describe('buildAiRequestsQuery', () => {
  it('scopes to the backend user id and personal usage with bounded, deterministic ordering', () => {
    const input = ListAiRequestsInputSchema.parse(range);
    const { statement, bindings } = buildAiRequestsQuery('T', CTX_USER, input);
    expect(statement).toContain('ORIGINAL_KILO_USER_ID = ?');
    expect(statement).not.toMatch(/(^|[^_])KILO_USER_ID = \?/);
    expect(statement).toContain("(ORGANIZATION_ID IS NULL OR ORGANIZATION_ID = '')");
    expect(statement).toContain('ORDER BY CREATED_AT DESC, ID DESC');
    expect(statement).toContain(`LIMIT ${AI_REQUESTS_PAGE_SIZE + 1}`);
    expect(bindings.map(b => b.value)).toEqual([CTX_USER, range.startDate, range.endDate]);
  });

  it('never selects prompt, IP or session payload columns', () => {
    const { statement } = buildAiRequestsQuery(
      'T',
      CTX_USER,
      ListAiRequestsInputSchema.parse(range)
    );
    const selectList = statement.slice('SELECT '.length, statement.indexOf('\nFROM'));
    expect(selectList).toBe(
      [
        'ID',
        `TO_VARCHAR(CREATED_AT, 'YYYY-MM-DD"T"HH24:MI:SS.FF6"Z"')`,
        'MODEL',
        'REQUESTED_MODEL',
        'COALESCE(INFERENCE_PROVIDER, PROVIDER)',
        'FEATURE',
        'INPUT_TOKENS',
        'OUTPUT_TOKENS',
        'CACHE_WRITE_TOKENS',
        'CACHE_HIT_TOKENS',
        'COST',
        'IS_USER_BYOK',
        'HAS_ERROR',
      ].join(', ')
    );
    for (const column of ['PROMPT', 'HTTP_IP', 'SESSION_ID', 'MACHINE_ID', 'COUNTRY']) {
      expect(statement).not.toContain(column);
    }
  });

  it('binds the keyset cursor instead of interpolating it', () => {
    const cursor = {
      createdAt: '2026-10-26T12:00:00.123456Z',
      id: '00000000-0000-4000-8000-000000000001',
    };
    const { statement, bindings } = buildAiRequestsQuery(
      'T',
      CTX_USER,
      ListAiRequestsInputSchema.parse({ ...range, cursor })
    );
    expect(statement).toContain('(CREATED_AT < ? OR (CREATED_AT = ? AND ID < ?))');
    expect(statement).not.toContain(cursor.id);
    expect(bindings.slice(3).map(b => b.value)).toEqual([
      cursor.createdAt,
      cursor.createdAt,
      cursor.id,
    ]);
  });

  it('filters on the recorded user-key flag only', () => {
    const byok = buildAiRequestsQuery(
      'T',
      CTX_USER,
      ListAiRequestsInputSchema.parse({ ...range, keySource: 'user_byok' })
    );
    expect(byok.statement).toContain('IS_USER_BYOK = TRUE');
    const kilo = buildAiRequestsQuery(
      'T',
      CTX_USER,
      ListAiRequestsInputSchema.parse({ ...range, keySource: 'kilo' })
    );
    expect(kilo.statement).toContain('IS_USER_BYOK = FALSE');
    expect(kilo.statement).not.toContain('COST =');
  });
});

describe('ListAiRequestsInputSchema', () => {
  it('rejects ranges longer than 31 days and inverted ranges', () => {
    expect(
      ListAiRequestsInputSchema.safeParse({
        startDate: '2026-09-01T00:00:00.000Z',
        endDate: '2026-10-03T00:00:00.000Z',
      }).success
    ).toBe(false);
    expect(
      ListAiRequestsInputSchema.safeParse({ startDate: range.endDate, endDate: range.startDate })
        .success
    ).toBe(false);
  });

  it('rejects malformed cursors and client-supplied identity fields have no effect', () => {
    expect(
      ListAiRequestsInputSchema.safeParse({
        ...range,
        cursor: { createdAt: "x' OR 1=1 --", id: 'nope' },
      }).success
    ).toBe(false);
    const parsed = ListAiRequestsInputSchema.parse({ ...range, userId: 'someone-else' });
    expect(parsed).not.toHaveProperty('userId');
  });
});

describe('row mapping', () => {
  it('maps the recorded flag without inferring from cost', () => {
    expect(toKeySource('true')).toBe('user_byok');
    expect(toKeySource('false')).toBe('kilo');
    expect(toKeySource(null)).toBe('unknown');
    expect(parseAiRequestRow(row(0, { 10: '0', 11: null })).keySource).toBe('unknown');
    expect(parseAiRequestRow(row(0, { 10: '0', 11: 'false' })).keySource).toBe('kilo');
  });

  it('keeps microdollar amounts exact as integer strings', () => {
    const parsed = parseAiRequestRow(row(0, { 10: '9007199254740993', 11: 'false' }));
    expect(parsed.costMicrodollars).toBe('9007199254740993');
    expect(parsed.inputTokens).toBe(1200);
    expect(parsed.cacheHitTokens).toBe(800);
  });

  it('rejects non-integer microdollar values rather than rounding', () => {
    expect(() => parseAiRequestRow(row(0, { 10: '12.5' }))).toThrow();
  });
});

describe('userAiRequests.list', () => {
  it('uses the authenticated user id for scoping', async () => {
    mockExecute.mockResolvedValue([row(0)]);
    await caller().list(range);
    const call = mockExecute.mock.calls[0]?.[0];
    expect(call?.bindings?.[0]).toEqual({ type: 'TEXT', value: CTX_USER });
  });

  it('returns a next cursor only when more rows exist', async () => {
    const rows = Array.from({ length: AI_REQUESTS_PAGE_SIZE + 1 }, (_, i) => row(i));
    mockExecute.mockResolvedValue(rows);
    const page = await caller().list(range);
    expect(page.items).toHaveLength(AI_REQUESTS_PAGE_SIZE);
    const last = page.items.at(-1);
    expect(page.nextCursor).toEqual({ createdAt: last?.createdAt, id: last?.id });

    mockExecute.mockResolvedValue([row(0)]);
    expect((await caller().list(range)).nextCursor).toBeNull();
  });

  it('returns an empty page without a cursor', async () => {
    mockExecute.mockResolvedValue([]);
    await expect(caller().list(range)).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('surfaces Snowflake failures as a generic error without leaking details', async () => {
    mockExecute.mockRejectedValue(new Error('Snowflake statement failed (500): secret detail'));
    await expect(caller().list(range)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Usage data temporarily unavailable',
    });
  });

  it('fails closed when Snowflake is not configured', async () => {
    mockResolveSnowflakeConfig.mockReturnValue(null);
    await expect(caller().list(range)).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('ignores a client-supplied user id and still scopes to the caller', async () => {
    mockExecute.mockResolvedValue([]);
    await caller().list({ ...range, userId: 'victim' } as typeof range);
    const values = mockExecute.mock.calls[0]?.[0].bindings?.map(b => b.value);
    expect(values).toContain(CTX_USER);
    expect(values).not.toContain('victim');
  });

  it('rejects future end dates before querying', async () => {
    const future = new Date(Date.now() + 3 * 86_400_000);
    await expect(
      caller().list({
        startDate: new Date(future.getTime() - 86_400_000).toISOString(),
        endDate: future.toISOString(),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
