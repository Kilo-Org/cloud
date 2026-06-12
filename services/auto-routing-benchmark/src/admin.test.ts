import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BENCHMARK_CONFIG } from './config';
import { app } from './index';

// ---------------------------------------------------------------------------
// Env / binding stubs
// ---------------------------------------------------------------------------

const tokenGet = vi.fn<() => Promise<string>>();
const dbFirst = vi.fn();
const dbAll = vi.fn();
const dbRun = vi.fn();
const dbBind = vi.fn();
const dbPrepare = vi.fn();
const queueSendBatch = vi.fn();

// Minimal chainable D1 stub.
// prepare() → { bind() → { first(), all(), run() } }
function makeD1Stub() {
  const stmt = {
    bind: (..._args: unknown[]) => {
      dbBind(..._args);
      return stmt;
    },
    first: dbFirst,
    all: dbAll,
    run: dbRun,
  };
  dbPrepare.mockReturnValue(stmt);
  return {
    prepare: (sql: string) => {
      dbPrepare(sql);
      return stmt;
    },
    batch: vi.fn().mockResolvedValue([]),
  } as unknown as D1Database;
}

const env = {
  INTERNAL_API_SECRET_PROD: { get: tokenGet },
  BENCH_DB: null as unknown as D1Database,
  BENCH_QUEUE: { sendBatch: queueSendBatch },
  AUTO_ROUTING_CONFIG: { put: vi.fn(), get: vi.fn() },
} as unknown as Env;

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function request(path: string, init: RequestInit = {}) {
  return app.request(`https://bench.example.com${path}`, init, env, executionCtx);
}

function authedGet(path: string) {
  return request(path, { headers: { authorization: 'Bearer bench-token' } });
}

function authedPost(path: string, body: unknown) {
  return request(path, {
    method: 'POST',
    headers: { authorization: 'Bearer bench-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function authedPut(path: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  return request(path, {
    method: 'PUT',
    headers: {
      authorization: 'Bearer bench-token',
      'content-type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  tokenGet.mockResolvedValue('bench-token');
  dbFirst.mockResolvedValue(null);
  dbAll.mockResolvedValue({ results: [] });
  dbRun.mockResolvedValue({ meta: { changes: 0 } });
  queueSendBatch.mockResolvedValue(undefined);

  // Rebuild the D1 stub each test so prepare/bind point to fresh mocks.
  (env as unknown as Record<string, unknown>).BENCH_DB = makeD1Stub();
});

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------

describe('auth middleware', () => {
  it('rejects requests without a bearer token', async () => {
    const res = await request('/admin/config');
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('rejects requests with the wrong bearer token', async () => {
    const res = await request('/admin/config', {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /admin/config
// ---------------------------------------------------------------------------

describe('GET /admin/config', () => {
  it('returns defaults when the DB row is absent', async () => {
    // dbFirst already returns null by default
    const res = await authedGet('/admin/config');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      config: DEFAULT_BENCHMARK_CONFIG,
      defaults: DEFAULT_BENCHMARK_CONFIG,
    });
  });

  it('returns the stored config when a DB row exists', async () => {
    const storedConfig = {
      ...DEFAULT_BENCHMARK_CONFIG,
      minAccuracy: 0.9,
      updatedAt: '2026-06-01T00:00:00.000Z',
      updatedBy: 'admin@example.com',
    };
    dbFirst.mockResolvedValueOnce({ config_json: JSON.stringify(storedConfig) });

    const res = await authedGet('/admin/config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: typeof storedConfig };
    expect(body.config.minAccuracy).toBe(0.9);
    expect(body.config.updatedBy).toBe('admin@example.com');
  });
});

// ---------------------------------------------------------------------------
// PUT /admin/config
// ---------------------------------------------------------------------------

describe('PUT /admin/config', () => {
  it('rejects a non-JSON body', async () => {
    const res = await request('/admin/config', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer bench-token',
        'content-type': 'application/json',
      },
      body: 'not json {{{',
    });
    // Malformed JSON surfaces via the framework error handler (same behavior
    // as the other zodJsonValidator-based services).
    expect(res.status).toBe(500);
  });

  it('returns 400 for a schema-invalid config', async () => {
    const res = await authedPut('/admin/config', { classifierModels: 'oops' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      error: 'Invalid benchmark config',
    });
    expect(dbRun).not.toHaveBeenCalled();
  });

  it('persists a valid config and returns it with defaults', async () => {
    const validConfig = {
      ...DEFAULT_BENCHMARK_CONFIG,
      minAccuracy: 0.85,
      updatedAt: null,
      updatedBy: null,
    };

    const res = await authedPut('/admin/config', validConfig, {
      'x-updated-by': 'igor@kilocode.ai',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: { minAccuracy: number; updatedBy: string | null; updatedAt: string | null };
      defaults: typeof DEFAULT_BENCHMARK_CONFIG;
    };
    // Returned config carries the stamped fields.
    expect(body.config.minAccuracy).toBe(0.85);
    expect(body.config.updatedBy).toBe('igor@kilocode.ai');
    expect(typeof body.config.updatedAt).toBe('string');
    expect(body.defaults).toEqual(DEFAULT_BENCHMARK_CONFIG);

    // The INSERT was actually executed (dbRun was called on the saveConfigRow stmt).
    expect(dbRun).toHaveBeenCalled();
    // The SQL should be an INSERT OR REPLACE into benchmark_config.
    const insertCall = dbPrepare.mock.calls.find(
      (args: unknown[]) =>
        typeof args[0] === 'string' && (args[0] as string).includes('benchmark_config')
    );
    expect(insertCall).toBeDefined();
    // The updatedBy value was forwarded via bind.
    const bindCalls: unknown[][] = dbBind.mock.calls;
    const foundUpdatedBy = bindCalls.some(args => args.includes('igor@kilocode.ai'));
    expect(foundUpdatedBy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /admin/runs
// ---------------------------------------------------------------------------

describe('GET /admin/runs', () => {
  it('returns an empty runs array when the table is empty', async () => {
    // dbAll returns { results: [] } by default
    const res = await authedGet('/admin/runs');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ runs: [] });
  });
});

// ---------------------------------------------------------------------------
// POST /admin/runs
// ---------------------------------------------------------------------------

describe('POST /admin/runs', () => {
  it('rejects a non-JSON body', async () => {
    const res = await request('/admin/runs', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bench-token',
        'content-type': 'application/json',
      },
      body: '<<<',
    });
    // Malformed JSON surfaces via the framework error handler (same behavior
    // as the other zodJsonValidator-based services).
    expect(res.status).toBe(500);
  });

  it('returns 400 for an invalid kind', async () => {
    const res = await authedPost('/admin/runs', { kind: 'turbo' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      error: 'Invalid run request',
    });
    expect(queueSendBatch).not.toHaveBeenCalled();
  });

  it('starts a classifier run and returns runId + enqueuedModels', async () => {
    // markStaleRunsFailed → run (UPDATE), getBenchmarkConfig → first (null → defaults),
    // insertRun → run, then sendBatch.
    const res = await authedPost('/admin/runs', { kind: 'classifier' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; enqueuedModels: number };
    expect(body.runId).toMatch(/^classifier-/);
    expect(body.enqueuedModels).toBe(DEFAULT_BENCHMARK_CONFIG.classifierModels.length);
    expect(queueSendBatch).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// GET /admin/routing-table
// ---------------------------------------------------------------------------

describe('GET /admin/routing-table', () => {
  it('returns {table: null, publishedAt: null} when no rows exist', async () => {
    // dbFirst already returns null by default
    const res = await authedGet('/admin/routing-table');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ table: null, publishedAt: null });
  });

  it('returns the parsed table and publishedAt when a row exists', async () => {
    const candidate = {
      model: 'm',
      accuracy: 1,
      avgCostUsd: 0.1,
      meetsThreshold: true,
      supportedApiKinds: ['chat_completions'],
    };
    const tableData = {
      version: 'test-v1',
      generatedAt: '2026-06-01T10:00:00.000Z',
      minAccuracy: 0.7,
      source: 'benchmark',
      tiers: { low: [candidate], medium: [candidate], high: [candidate] },
    };
    dbFirst.mockResolvedValueOnce({
      run_id: 'run-123',
      published_at: '2026-06-01T10:00:00.000Z',
      table_json: JSON.stringify(tableData),
    });

    const res = await authedGet('/admin/routing-table');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      table: tableData,
      publishedAt: '2026-06-01T10:00:00.000Z',
    });
  });
});
