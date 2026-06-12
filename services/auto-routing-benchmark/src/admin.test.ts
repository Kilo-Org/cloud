import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BenchmarkConfig, RoutingTable } from '@kilocode/auto-routing-contracts';
import { app } from './index';
import type * as DbModule from './db';

const TEST_CONFIG: BenchmarkConfig = {
  classifierModels: ['google/gemini-2.5-flash-lite', 'google/gemini-2.5-flash'],
  deciderModels: [
    {
      id: 'google/gemini-2.5-flash-lite',
      supportedApiKinds: ['chat_completions'],
      reasoningEffort: null,
    },
    {
      id: 'anthropic/claude-sonnet-4.6',
      supportedApiKinds: ['chat_completions', 'messages', 'responses'],
      reasoningEffort: null,
    },
  ],
  minAccuracy: 0.7,
  switchCostFactor: 3,
  maxConcurrency: 4,
  benchmarkUserId: null,
  updatedAt: null,
  updatedBy: null,
};

// getConfigRows result that mapConfigRows resolves back to TEST_CONFIG.
const TEST_CONFIG_ROWS = {
  config: {
    id: 1 as const,
    min_accuracy: TEST_CONFIG.minAccuracy,
    switch_cost_factor: TEST_CONFIG.switchCostFactor,
    max_concurrency: TEST_CONFIG.maxConcurrency,
    benchmark_user_id: TEST_CONFIG.benchmarkUserId,
    updated_at: '2026-06-01T00:00:00.000Z',
    updated_by: null,
  },
  classifierModels: TEST_CONFIG.classifierModels,
  deciderModels: TEST_CONFIG.deciderModels.map(m => ({
    model: m.id,
    reasoning_effort: m.reasoningEffort ?? null,
    supports_chat_completions: m.supportedApiKinds.includes('chat_completions'),
    supports_messages: m.supportedApiKinds.includes('messages'),
    supports_responses: m.supportedApiKinds.includes('responses'),
  })),
};

// ---------------------------------------------------------------------------
// Stubs: the db module is mocked at its function boundary (drizzle generates
// the SQL, so statement-level stubbing would couple tests to its internals).
// ---------------------------------------------------------------------------

vi.mock('./db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    getConfigRows: vi.fn(),
    replaceConfig: vi.fn(),
    listRuns: vi.fn(),
    getLatestRoutingTable: vi.fn(),
    getClassifierWinner: vi.fn(),
    getLatestSummariesByModel: vi.fn(),
    insertRun: vi.fn(),
    markStaleRunsFailed: vi.fn(),
  };
});

import {
  getConfigRows,
  getClassifierWinner,
  getLatestRoutingTable,
  getLatestSummariesByModel,
  insertRun,
  listRuns,
  markStaleRunsFailed,
  replaceConfig,
} from './db';

const tokenGet = vi.fn<() => Promise<string>>();
const queueSendBatch = vi.fn();

const env = {
  INTERNAL_API_SECRET_PROD: { get: tokenGet },
  BENCH_DB: {} as D1Database,
  BENCH_QUEUE: { sendBatch: queueSendBatch },
  AUTO_ROUTING_CONFIG: { put: vi.fn(), get: vi.fn(), delete: vi.fn() },
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
  vi.mocked(getConfigRows).mockResolvedValue({
    config: null,
    classifierModels: [],
    deciderModels: [],
  });
  vi.mocked(replaceConfig).mockResolvedValue(undefined);
  vi.mocked(listRuns).mockResolvedValue([]);
  vi.mocked(getLatestRoutingTable).mockResolvedValue(null);
  vi.mocked(getClassifierWinner).mockResolvedValue(null);
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
  it('returns a null config when the DB rows are absent', async () => {
    // getConfigRows already returns null config by default
    const res = await authedGet('/admin/config');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ config: null });
  });

  it('returns the stored config when DB rows exist', async () => {
    const classifierModels = ['some/model'];
    const deciderModels = TEST_CONFIG.deciderModels.map(m => ({
      model: m.id,
      reasoning_effort: null,
      supports_chat_completions: m.supportedApiKinds.includes('chat_completions'),
      supports_messages: m.supportedApiKinds.includes('messages'),
      supports_responses: m.supportedApiKinds.includes('responses'),
    }));
    vi.mocked(getConfigRows).mockResolvedValueOnce({
      config: {
        id: 1,
        min_accuracy: 0.9,
        switch_cost_factor: 3,
        max_concurrency: 4,
        benchmark_user_id: null,
        updated_at: '2026-06-01T00:00:00.000Z',
        updated_by: 'admin@example.com',
      },
      classifierModels,
      deciderModels,
    });

    const res = await authedGet('/admin/config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: { minAccuracy: number; updatedBy: string | null };
    };
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
    expect(res.status).toBe(500);
  });

  it('returns 400 for a schema-invalid config', async () => {
    const res = await authedPut('/admin/config', { classifierModels: 'oops' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      error: 'Invalid benchmark config',
    });
    expect(replaceConfig).not.toHaveBeenCalled();
  });

  it('persists a valid config and returns it', async () => {
    const validConfig = {
      ...TEST_CONFIG,
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
    };
    expect(body.config.minAccuracy).toBe(0.85);
    expect(body.config.updatedBy).toBe('igor@kilocode.ai');
    expect(typeof body.config.updatedAt).toBe('string');

    expect(replaceConfig).toHaveBeenCalledOnce();
    const [, configArg] = vi.mocked(replaceConfig).mock.calls[0];
    expect(configArg.min_accuracy).toBe(0.85);
    expect(typeof configArg.updated_at).toBe('string');
    expect(configArg.updated_by).toBe('igor@kilocode.ai');
  });
});

// ---------------------------------------------------------------------------
// GET /admin/runs
// ---------------------------------------------------------------------------

describe('GET /admin/runs', () => {
  it('returns an empty runs array when the table is empty', async () => {
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

  it('rejects starting a run when no config has been saved', async () => {
    // getConfigRows already returns null config by default
    const res = await authedPost('/admin/runs', { kind: 'classifier' });
    expect(res.status).toBe(500);
    expect(insertRun).not.toHaveBeenCalled();
    expect(queueSendBatch).not.toHaveBeenCalled();
  });

  it('starts a classifier run and returns runId + enqueuedModels', async () => {
    // No prior summaries → every configured model is enqueued.
    vi.mocked(getConfigRows).mockResolvedValue(TEST_CONFIG_ROWS);
    const res = await authedPost('/admin/runs', { kind: 'classifier' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; enqueuedModels: number };
    expect(body.runId).toMatch(/^classifier-/);
    expect(body.enqueuedModels).toBe(TEST_CONFIG.classifierModels.length);
    expect(insertRun).toHaveBeenCalledOnce();
    // The run row snapshots the live config (mid-run edits must not skew results).
    const [, runArg] = vi.mocked(insertRun).mock.calls[0];
    expect(runArg.min_accuracy).toBe(TEST_CONFIG.minAccuracy);
    expect(runArg.switch_cost_factor).toBe(TEST_CONFIG.switchCostFactor);
    expect(queueSendBatch).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// GET /admin/routing-table
// ---------------------------------------------------------------------------

describe('GET /admin/routing-table', () => {
  it('returns {table: null, publishedAt: null} when no rows exist', async () => {
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
      switchCostFactor: 3,
      source: 'benchmark',
      tiers: { low: [candidate], medium: [candidate], high: [candidate] },
    };
    vi.mocked(getLatestRoutingTable).mockResolvedValueOnce({
      table: tableData as RoutingTable,
      publishedAt: '2026-06-01T10:00:00.000Z',
    });

    const res = await authedGet('/admin/routing-table');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      table: tableData,
      publishedAt: '2026-06-01T10:00:00.000Z',
    });
  });
});

// ---------------------------------------------------------------------------
// GET /admin/classifier-winner
// ---------------------------------------------------------------------------

describe('GET /admin/classifier-winner', () => {
  it('returns {winner: null} when no completed classifier run exists', async () => {
    const res = await authedGet('/admin/classifier-winner');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ winner: null });
  });

  it('returns the winner when a completed classifier run exists', async () => {
    const winner = {
      model: 'google/gemini-2.5-flash-lite',
      runId: 'classifier-2026-06-01T00-00-00-000Z',
      accuracy: 0.92,
      generatedAt: '2026-06-01T10:00:00.000Z',
    };
    vi.mocked(getClassifierWinner).mockResolvedValueOnce(winner);

    const res = await authedGet('/admin/classifier-winner');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ winner });
  });
});
