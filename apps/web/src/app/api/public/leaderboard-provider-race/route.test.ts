import { describe, test, expect, jest } from '@jest/globals';
import type * as SnowflakeModule from '@/lib/snowflake';
import type { GET as RouteGet } from './route';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

jest.mock('@/lib/redis', () => ({
  redisClient: {
    get: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  },
}));

jest.mock('@/lib/snowflake', () => ({
  resolveSnowflakeConfig: jest.fn(),
  executeSnowflakeStatement: jest.fn(),
}));

const FAKE_CONFIG = { accountHost: 'test.snowflakecomputing.com' };

// The route builds a module-level in-process cache (1h TTL) at import time, so
// each test loads it in an isolated module registry to keep that cache from
// leaking between cases.
async function loadGet(opts: {
  config?: unknown;
  rows?: string[][];
  statementError?: Error;
}): Promise<typeof RouteGet> {
  let GET!: typeof RouteGet;
  await jest.isolateModulesAsync(async () => {
    const snowflake = (await import('@/lib/snowflake')) as SnowflakeModule;
    const config = opts.config === undefined ? FAKE_CONFIG : opts.config;
    jest
      .mocked(snowflake.resolveSnowflakeConfig)
      .mockReturnValue(config as ReturnType<SnowflakeModule['resolveSnowflakeConfig']>);
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

describe('OPTIONS /api/public/leaderboard-provider-race', () => {
  test('returns 204 with CORS headers', async () => {
    const { OPTIONS } = await import('./route');

    const response = OPTIONS();

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET');
  });
});
