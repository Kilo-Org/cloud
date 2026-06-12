import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BENCHMARK_CONFIG } from './config';
import { app } from './index';
import type * as DbModule from './db';

// ---------------------------------------------------------------------------
// Stubs: the db module is mocked at its function boundary (drizzle generates
// the SQL, so statement-level stubbing would couple tests to its internals).
// ---------------------------------------------------------------------------

vi.mock('./db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    getConfigRow: vi.fn(),
    saveConfigRow: vi.fn(),
    listRuns: vi.fn(),
    getLatestRoutingTable: vi.fn(),
    getLatestSummariesByModel: vi.fn(),
    insertRun: vi.fn(),
    markStaleRunsFailed: vi.fn(),
  };
});

import {
  getConfigRow,
  getLatestRoutingTable,
  getLatestSummariesByModel,
  insertRun,
  listRuns,
  markStaleRunsFailed,
  saveConfigRow,
} from './db';

const tokenGet = vi.fn<() => Promise<string>>();
const queueSendBatch = vi.fn();

const env = {
  INTERNAL_API_SECRET_PROD: { get: tokenGet },
  BENCH_DB: {} as D1Database,
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
  vi.clearAllMocks();
  tokenGet.mockResolvedValue('bench-token');
  vi.mocked(getConfigRow).mockResolvedValue(null);
  vi.mocked(saveConfigRow).mockResolvedValue(undefined);
  vi.mocked(listRuns).mockResolvedValue([]);
  vi.mocked(getLatestRoutingTable).mockResolvedValue(null);
  vi.mocked(getLatestSummariesByModel).mockResolvedValue(new Map());
  vi.mocked(insertRun).mockResolvedValue(undefined);
  vi.mocked(markStaleRunsFailed).mockResolvedValue(undefined);
  queueSendBatch.mockResolvedValue(undefined);
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
    // getConfigRow already returns null by default
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
    vi.mocked(getConfigRow).mockResolvedValueOnce({
      config_json: JSON.stringify(storedConfig),
      updated_at: '2026-06-01T00:00:00.000Z',
      updated_by: 'admin@example.com',
    });

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
    expect(saveConfigRow).not.toHaveBeenCalled();
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

    // The row was persisted with the stamped config and updatedBy.
    expect(saveConfigRow).toHaveBeenCalledOnce();
    const [, configJson, updatedAt, updatedBy] = vi.mocked(saveConfigRow).mock.calls[0];
    expect(JSON.parse(configJson).minAccuracy).toBe(0.85);
    expect(typeof updatedAt).toBe('string');
    expect(updatedBy).toBe('igor@kilocode.ai');
  });
});

// ---------------------------------------------------------------------------
// GET /admin/runs
// ---------------------------------------------------------------------------

describe('GET /admin/runs', () => {
  it('returns an empty runs array when the table is empty', async () => {
    // listRuns returns [] by default
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
    // No prior summaries → every configured model is enqueued.
    const res = await authedPost('/admin/runs', { kind: 'classifier' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; enqueuedModels: number };
    expect(body.runId).toMatch(/^classifier-/);
    expect(body.enqueuedModels).toBe(DEFAULT_BENCHMARK_CONFIG.classifierModels.length);
    expect(insertRun).toHaveBeenCalledOnce();
    expect(queueSendBatch).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// GET /admin/routing-table
// ---------------------------------------------------------------------------

describe('GET /admin/routing-table', () => {
  it('returns {table: null, publishedAt: null} when no rows exist', async () => {
    // getLatestRoutingTable already returns null by default
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
    vi.mocked(getLatestRoutingTable).mockResolvedValueOnce({
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
