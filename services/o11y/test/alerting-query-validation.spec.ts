import { describe, it, expect, vi } from 'vitest';
import { Hono, type Hono as HonoType } from 'hono';
import {
  ModelIdSchema,
  parseModelId,
  queryErrorRateBaseline,
  queryTtfbBaseline,
} from '../src/alerting/query';
import { registerAlertingConfigRoutes } from '../src/alerting/config-routes';
import type { AeQueryEnv } from '../src/alerting/query';
import type { Env } from '../src/index';

function makeAeEnv(): AeQueryEnv {
  return {
    O11Y_CF_ACCOUNT_ID: 'test-account-id',
    O11Y_CF_AE_API_TOKEN: { get: async () => 'test-ae-token' },
  } as unknown as AeQueryEnv;
}

let lastSqlBody = '';

function mockAeResponse(data: unknown[]): ReturnType<typeof vi.fn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    lastSqlBody = String(init?.body ?? '');
    return new Response(JSON.stringify({ data }), { status: 200 });
  });
}

describe('model id validation', () => {
  it('accepts a normal model slug', () => {
    expect(parseModelId('anthropic/claude-sonnet-4.5')).toBe('anthropic/claude-sonnet-4.5');
    expect(ModelIdSchema.safeParse('openai/gpt-4o-mini').success).toBe(true);
    expect(ModelIdSchema.safeParse('~vendor/family-latest').success).toBe(true);
  });

  it('rejects a model id with a backslash', () => {
    expect(() => parseModelId('x\\')).toThrow();
    expect(ModelIdSchema.safeParse('a\\b').success).toBe(false);
  });

  it('rejects a model id with a quote', () => {
    expect(() => parseModelId("o'brien")).toThrow();
    expect(ModelIdSchema.safeParse("'").success).toBe(false);
  });

  it('rejects a model id with whitespace inside', () => {
    expect(ModelIdSchema.safeParse('model with space').success).toBe(false);
    expect(ModelIdSchema.safeParse('model\ttab').success).toBe(false);
  });

  it('rejects an over-long model id', () => {
    expect(ModelIdSchema.safeParse('a'.repeat(201)).success).toBe(false);
    expect(ModelIdSchema.safeParse('a'.repeat(200)).success).toBe(true);
  });

  it('rejects an empty id', () => {
    expect(ModelIdSchema.safeParse('').success).toBe(false);
    expect(ModelIdSchema.safeParse('   ').success).toBe(false);
  });
});

describe('baseline query builders', () => {
  it('queryErrorRateBaseline throws for an id with a backslash', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(queryErrorRateBaseline('x\\', makeAeEnv())).rejects.toThrow('Invalid model id');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('queryTtfbBaseline throws for an id with a quote', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(queryTtfbBaseline("x'", makeAeEnv())).rejects.toThrow('Invalid model id');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('queryErrorRateBaseline sends SQL containing the model id for a normal slug', async () => {
    const fetchSpy = mockAeResponse([]);
    const row = await queryErrorRateBaseline('anthropic/claude-sonnet-4.5', makeAeEnv());

    expect(row).toBeNull();
    expect(lastSqlBody).toContain("'anthropic/claude-sonnet-4.5'");
    fetchSpy.mockRestore();
  });

  it('queryTtfbBaseline sends SQL containing the model id for a normal slug', async () => {
    const fetchSpy = mockAeResponse([
      { p50_ttfb: 100, p95_ttfb: 200, p99_ttfb: 300, weighted_total: 5 },
    ]);
    const row = await queryTtfbBaseline('openai/gpt-4o-mini', makeAeEnv());

    expect(row.p50_ttfb_3d).toBe(100);
    expect(lastSqlBody).toContain("'openai/gpt-4o-mini'");
    fetchSpy.mockRestore();
  });
});

describe('baseline route validation', () => {
  function makeApp(): HonoType<{ Bindings: Env }> {
    const app = new Hono<{ Bindings: Env }>();
    registerAlertingConfigRoutes(app);
    return app;
  }

  function makeRouteEnv(): Env {
    return {
      O11Y_KILO_GATEWAY_CLIENT_SECRET: {
        get: async () => 'test-admin-token',
      },
      O11Y_CF_ACCOUNT_ID: 'test-account-id',
      O11Y_CF_AE_API_TOKEN: { get: async () => 'test-ae-token' },
    } as unknown as Env;
  }

  async function get(url: string): Promise<Response> {
    const app = makeApp();
    return app.request(
      url,
      {
        headers: { 'X-O11Y-ADMIN-TOKEN': 'test-admin-token' },
      },
      makeRouteEnv()
    );
  }

  it('returns 400 for a model with a backslash on the baseline route', async () => {
    const response = await get('/alerting/baseline?model=' + encodeURIComponent('x\\'));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false });
  });

  it('returns 400 for a model with a quote on the ttfb-baseline route', async () => {
    const response = await get('/alerting/ttfb-baseline?model=' + encodeURIComponent("x'"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false });
  });

  it('returns 400 for a model with whitespace', async () => {
    const response = await get(
      '/alerting/baseline?model=' + encodeURIComponent('model with space')
    );
    expect(response.status).toBe(400);
  });

  it('returns 400 for an over-long model', async () => {
    const response = await get('/alerting/baseline?model=' + 'a'.repeat(201));
    expect(response.status).toBe(400);
  });

  it('returns 400 for a missing model', async () => {
    const response = await get('/alerting/ttfb-baseline');
    expect(response.status).toBe(400);
  });

  it('runs the query for a normal slug on the baseline route', async () => {
    const fetchSpy = mockAeResponse([
      {
        weighted_total_1d: 10,
        weighted_errors_1d: 1,
        weighted_total_3d: 20,
        weighted_errors_3d: 2,
        weighted_total_7d: 30,
        weighted_errors_7d: 3,
      },
    ]);
    const response = await get('/alerting/baseline?model=anthropic%2Fclaude-sonnet-4.5');

    expect(response.status).toBe(200);
    const json = (await response.json()) as { baseline: { model: string } | null };
    expect(json.baseline?.model).toBe('anthropic/claude-sonnet-4.5');
    expect(lastSqlBody).toContain("'anthropic/claude-sonnet-4.5'");
    fetchSpy.mockRestore();
  });
});
