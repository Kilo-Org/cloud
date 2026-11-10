import { describe, test, expect, jest } from '@jest/globals';
import { sql } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { resolveSnowflakeConfig } from '@/lib/snowflake';
import type { GET as RouteGet } from './route';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: {
    get: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
    set: jest.fn<() => Promise<string>>().mockResolvedValue('OK'),
  },
}));

jest.mock('@/lib/snowflake', () => ({
  resolveSnowflakeConfig: jest.fn(),
  executeSnowflakeStatement: jest.fn(),
}));

type SnowflakeConfig = ReturnType<typeof resolveSnowflakeConfig>;

const FAKE_CONFIG = {
  accountHost: 'test.snowflakecomputing.com',
  jwtAccountIdentifier: 'TEST_ACCOUNT',
  username: 'TEST_USER',
  role: 'TEST_ROLE',
  warehouse: 'TEST_WAREHOUSE',
  database: 'TEST_DATABASE',
  schema: 'TEST_SCHEMA',
  privateKeyPem: 'test-private-key',
  publicKeyFingerprint: 'SHA256:test-fingerprint',
} satisfies NonNullable<SnowflakeConfig>;

// The route builds a module-level in-process cache (1h TTL) at import time, so
// each test loads it in an isolated module registry to keep that cache from
// leaking between cases.
async function loadGet(opts: {
  config?: SnowflakeConfig;
  rows?: string[][];
  statementError?: Error;
}): Promise<typeof RouteGet> {
  let GET!: typeof RouteGet;
  await jest.isolateModulesAsync(async () => {
    const snowflake = await import('@/lib/snowflake');
    const config = opts.config === undefined ? FAKE_CONFIG : opts.config;
    jest.mocked(snowflake.resolveSnowflakeConfig).mockReturnValue(config);
    if (opts.statementError) {
      jest.mocked(snowflake.executeSnowflakeStatement).mockRejectedValue(opts.statementError);
    } else {
      jest.mocked(snowflake.executeSnowflakeStatement).mockResolvedValue(opts.rows ?? []);
    }
    ({ GET } = await import('./route'));
  });
  return GET;
}

describe('GET /api/public/leaderboard-provider-race', () => {
  test('returns 503 when Snowflake is not configured', async () => {
    const GET = await loadGet({ config: null });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  test('returns 502 when the Snowflake query fails (e.g. is_open_weights backfill not landed)', async () => {
    const GET = await loadGet({ statementError: new Error('invalid identifier IS_OPEN_WEIGHTS') });

    const response = await GET();

    expect(response.status).toBe(502);
  });

  test('maps explicit is_open_weights to booleans and NULL/unknown to null', async () => {
    const GET = await loadGet({
      rows: [
        ['2026-07-14', 'Anthropic', 'false', '12345'],
        ['2026-07-14', 'Alibaba', 'true', '6789'],
        // The SQL API returns NULL cells as null at runtime despite the
        // string[] row type; unmapped models land here.
        ['2026-07-14', 'other', null, '999'] as unknown as string[],
        // A future model_dim mapping gap must not be silently bucketed as closed.
        ['2026-07-14', 'Mystery', 'unexpected', '111'],
      ],
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { weekStart: '2026-07-14', provider: 'Anthropic', isOpenWeights: false, tokens: 12345 },
      { weekStart: '2026-07-14', provider: 'Alibaba', isOpenWeights: true, tokens: 6789 },
      { weekStart: '2026-07-14', provider: 'other', isOpenWeights: null, tokens: 999 },
      { weekStart: '2026-07-14', provider: 'Mystery', isOpenWeights: null, tokens: 111 },
    ]);
    expect(response.headers.get('Cache-Control')).toContain('public');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  test('returns 502 when a row is malformed', async () => {
    const GET = await loadGet({ rows: [['2026-07-14', 'Anthropic', 'true', 'not-a-number']] });

    const response = await GET();

    expect(response.status).toBe(502);
  });
});

describe('leaderboard Snowflake database and schema', () => {
  test.each([
    {
      route: 'leaderboard-model-usage',
      loadRoute: () => import('../leaderboard-model-usage/route'),
      table: 'microdollar_usage_daily',
    },
    {
      route: 'leaderboard-model-provider-usage',
      loadRoute: () => import('../leaderboard-model-provider-usage/route'),
      table: 'microdollar_usage_daily',
    },
    {
      route: 'leaderboard-provider-race',
      loadRoute: () => import('./route'),
      table: 'usage_daily',
    },
  ])('$route uses the configured database and schema', async ({ loadRoute, table }) => {
    await jest.isolateModulesAsync(async () => {
      const snowflake = await import('@/lib/snowflake');
      jest.mocked(snowflake.resolveSnowflakeConfig).mockReturnValue(FAKE_CONFIG);
      const executeStatement = jest.mocked(snowflake.executeSnowflakeStatement);
      executeStatement.mockReset().mockResolvedValue([]);
      const { GET } = await loadRoute();

      const response = await GET();

      expect(response.status).toBe(200);
      expect(executeStatement).toHaveBeenCalledTimes(1);
      expect(executeStatement).toHaveBeenCalledWith({
        config: FAKE_CONFIG,
        statement: expect.stringMatching(new RegExp(`\\bfrom\\s+${table}\\s+as\\b`, 'i')),
        timeoutSeconds: 30,
      });
    });
  });
});

describe('leaderboard model alias attribution', () => {
  test.each([
    {
      route: 'leaderboard-model-usage',
      loadRoute: () => import('../leaderboard-model-usage/route'),
    },
    {
      route: 'leaderboard-model-provider-usage',
      loadRoute: () => import('../leaderboard-model-provider-usage/route'),
    },
  ])('$route groups tilde aliases by the model that served each request', async ({ loadRoute }) => {
    await jest.isolateModulesAsync(async () => {
      const snowflake = await import('@/lib/snowflake');
      jest.mocked(snowflake.resolveSnowflakeConfig).mockReturnValue(FAKE_CONFIG);
      const executeStatement = jest.mocked(snowflake.executeSnowflakeStatement);
      executeStatement.mockReset().mockResolvedValue([]);
      const { GET } = await loadRoute();

      expect((await GET()).status).toBe(200);
      const statement = executeStatement.mock.calls[0][0].statement;
      const modelExpression = statement.match(
        /(case[\s\S]*?end|coalesce\(mu\.requested_model, mu\.model\)|mu\.requested_model) as "model"/
      )?.[1];
      if (!modelExpression) {
        throw new Error('Missing leaderboard model projection');
      }

      const usage = await db.execute<{ model: string; tokens: number }>(sql`
        select ${sql.raw(modelExpression)} as model, sum(mu.tokens)::integer as tokens
        from (values
          ('~deepseek/deepseek-pro-latest', 'deepseek/deepseek-v4-pro-0813', 6000000),
          ('deepseek/deepseek-v4-pro-0813', 'deepseek/deepseek-v4-pro-0813', 6000000),
          ('~deepseek/deepseek-pro-latest', 'deepseek/deepseek-v4-pro-1101', 12000000),
          ('deepseek/deepseek-v4-pro-0813:free', 'deepseek/deepseek-v4-pro-0813', 3000000),
          ('~deepseek/unresolved-latest', null, 2000000),
          ('acme/model~latest', 'upstream/model', 1000000)
        ) as mu(requested_model, model, tokens)
        group by 1
        order by 2 desc, 1
      `);

      expect(usage.rows).toEqual([
        { model: 'deepseek/deepseek-v4-pro-0813', tokens: 12000000 },
        { model: 'deepseek/deepseek-v4-pro-1101', tokens: 12000000 },
        { model: 'deepseek/deepseek-v4-pro-0813:free', tokens: 3000000 },
        { model: '~deepseek/unresolved-latest', tokens: 2000000 },
        { model: 'acme/model~latest', tokens: 1000000 },
      ]);
    });
  });
});

describe('public custom model leaderboard usage', () => {
  test.each([
    {
      loadRoute: () => import('../leaderboard-model-usage/route'),
      modelExpression: 'coalesce(mu.requested_model, mu.model)',
      rows: [['2026-11-01', 'acme/deleted-public-model', 'code', '12000000']],
      expected: [
        {
          usageDate: '2026-11-01',
          model: 'acme/deleted-public-model',
          mode: 'code',
          tokens: 12_000_000,
        },
      ],
    },
    {
      loadRoute: () => import('../leaderboard-model-provider-usage/route'),
      modelExpression: 'mu.requested_model',
      rows: [['acme/deleted-public-model', 'acme', '0', '12000000', '10000000', '0', '100', '0']],
      expected: [
        {
          model: 'deleted-public-model',
          provider: 'Acme',
          sumTokens: 12_000_000,
          costPerRequest: 0,
          costPerMillionTokens: 0,
          cacheRatio: 0,
          errorRate: 0,
          percentageOfModel: 100,
        },
      ],
    },
  ])(
    'returns public usage without consulting the custom model catalog ($modelExpression)',
    async ({ loadRoute, modelExpression, rows, expected }) => {
      await jest.isolateModulesAsync(async () => {
        const snowflake = await import('@/lib/snowflake');
        jest.mocked(snowflake.resolveSnowflakeConfig).mockReturnValue(FAKE_CONFIG);
        const executeStatement = jest.mocked(snowflake.executeSnowflakeStatement);
        executeStatement.mockReset().mockResolvedValue(rows);
        const { GET } = await loadRoute();

        const response = await GET();

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expected);
        const statement = executeStatement.mock.calls[0][0].statement.replace(/\s+/g, ' ');
        const providerFilter = `( mu.provider != 'custom' or ${modelExpression} = 'reflection/beam-free' or ${modelExpression} = 'stealth/glyph-cluster' )`;
        expect(statement).toContain(`and ${providerFilter}`);
        expect(statement).not.toContain('direct-byok');
        if (modelExpression === 'mu.requested_model') {
          expect(statement).toContain('and mu.is_user_byok = false');
        }

        const included = await db.execute<{ id: string }>(sql`
        select mu.id from (values
          ('historical-reflection', 'custom', 'reflection/beam-free', 'upstream/beam'),
          ('historical-stealth', 'custom', 'stealth/glyph-cluster', 'upstream/model'),
          ('historical-inclusionai', 'custom', 'inclusionai/ling', 'upstream/ling'),
          ('other-reflection-model', 'custom', 'reflection/beam', 'upstream/beam'),
          ('other-stealth-model', 'custom', 'stealth/model', 'upstream/model'),
          ('private', 'custom', 'private/model', 'upstream/model'),
          ('prefix-lookalike', 'custom', 'stealth-private/model', 'upstream/model'),
          ('embedded-prefix', 'custom', 'private/reflection/model', 'upstream/model'),
          ('private-upstream', 'custom', 'private/model', 'reflection/beam-free'),
          ('missing-requested', 'custom', null, 'reflection/beam-free'),
          ('public', 'custom-public', 'acme/deleted-public-model', 'upstream/model'),
          ('ordinary', 'openrouter', 'acme/model', 'upstream/model')
        ) as mu(id, provider, requested_model, model)
        where ${sql.raw(providerFilter)}
        order by mu.id
      `);
        expect(included.rows.map(row => row.id)).toEqual(
          [
            'historical-reflection',
            'historical-stealth',
            ...(modelExpression.startsWith('coalesce') ? ['missing-requested'] : []),
            'public',
            'ordinary',
          ].sort()
        );
      });
    }
  );
});

describe('GET /api/public/leaderboard-model-provider-usage', () => {
  test('aggregates Particle AI aliases before filtering by minimum tokens and calculating ratios', async () => {
    await jest.isolateModulesAsync(async () => {
      const snowflake = await import('@/lib/snowflake');
      jest.mocked(snowflake.resolveSnowflakeConfig).mockReturnValue(FAKE_CONFIG);
      jest.mocked(snowflake.executeSnowflakeStatement).mockResolvedValue([
        [
          'synthetic/alias-test-model',
          'Particle AI',
          '6000000',
          '6000000',
          '4000000',
          '1000000',
          '30',
          '0',
        ],
        [
          'synthetic/alias-test-model',
          'particle',
          '18000000',
          '6000000',
          '8000000',
          '2000000',
          '70',
          '0',
        ],
      ]);
      const { GET } = await import('../leaderboard-model-provider-usage/route');

      const response = await GET();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([
        {
          model: 'alias-test-model',
          provider: 'Particle AI',
          sumTokens: 12_000_000,
          costPerRequest: 0.24,
          costPerMillionTokens: 2,
          cacheRatio: 0.25,
          errorRate: 0,
          percentageOfModel: 100,
        },
      ]);
    });
  });

  test('keeps Claude Platform on AWS separate from Amazon Bedrock for the same model', async () => {
    await jest.isolateModulesAsync(async () => {
      const snowflake = await import('@/lib/snowflake');
      jest.mocked(snowflake.resolveSnowflakeConfig).mockReturnValue(FAKE_CONFIG);
      jest.mocked(snowflake.executeSnowflakeStatement).mockResolvedValue([
        ['synthetic/model', 'claudeaws', '0', '10000000', '8000000', '0', '100', '0'],
        ['synthetic/model', 'bedrock', '0', '10000000', '8000000', '0', '100', '0'],
      ]);
      const { GET } = await import('../leaderboard-model-provider-usage/route');

      const response = await GET();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([
        {
          model: 'model',
          provider: 'Amazon Bedrock',
          sumTokens: 10_000_000,
          costPerRequest: 0,
          costPerMillionTokens: 0,
          cacheRatio: 0,
          errorRate: 0,
          percentageOfModel: 50,
        },
        {
          model: 'model',
          provider: 'Claude Platform on AWS',
          sumTokens: 10_000_000,
          costPerRequest: 0,
          costPerMillionTokens: 0,
          cacheRatio: 0,
          errorRate: 0,
          percentageOfModel: 50,
        },
      ]);
    });
  });

  test('beautifies the Meituan inference provider', async () => {
    await jest.isolateModulesAsync(async () => {
      const snowflake = await import('@/lib/snowflake');
      jest.mocked(snowflake.resolveSnowflakeConfig).mockReturnValue(FAKE_CONFIG);
      jest
        .mocked(snowflake.executeSnowflakeStatement)
        .mockResolvedValue([
          ['meituan/longcat-flash-chat', 'meituan', '0', '12000000', '10000000', '0', '100', '0'],
        ]);
      const { GET } = await import('../leaderboard-model-provider-usage/route');

      const response = await GET();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([
        expect.objectContaining({
          model: 'longcat-flash-chat',
          provider: 'Meituan LongCat',
          sumTokens: 12_000_000,
        }),
      ]);
    });
  });
});

describe('OPTIONS /api/public/leaderboard-provider-race', () => {
  test('returns 204 with CORS headers', async () => {
    const { OPTIONS } = await import('./route');

    const response = OPTIONS();

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET');
  });
});
