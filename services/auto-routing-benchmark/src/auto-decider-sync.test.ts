import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbModule from './db';
import { syncAutoDeciderModels } from './auto-decider-sync';

vi.mock('./db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    getConfigRows: vi.fn(),
    replaceAutoDeciderModels: vi.fn(),
    getRunningRun: vi.fn(),
    getLatestSummariesByModel: vi.fn(),
    insertRun: vi.fn(),
    markStaleRunsFailed: vi.fn(),
  };
});

import {
  getConfigRows,
  getLatestSummariesByModel,
  getRunningRun,
  insertRun,
  markStaleRunsFailed,
  replaceAutoDeciderModels,
} from './db';

const tokenGet = vi.fn<() => Promise<string>>();
const queueSendBatch = vi.fn();
const fetchImpl = vi.fn<typeof fetch>();

const env = {
  INTERNAL_API_SECRET_PROD: { get: tokenGet },
  BENCH_DB: {} as D1Database,
  BENCH_QUEUE: { sendBatch: queueSendBatch },
  AUTO_ROUTING_CONFIG: { delete: vi.fn() },
  KILO_WEB_API_BASE_URL: 'https://app.test',
  KILO_CLI_API_URL: 'https://api.test',
} as unknown as Env;

const config = {
  id: 1 as const,
  min_accuracy: 0.7,
  switch_cost_factor: 3,
  max_concurrency: 100,
  benchmark_user_id: 'user-123',
  benchmark_org_id: null,
  classifier_repetitions: 1,
  decider_repetitions: 1,
  classifier_max_p95_latency_ms: 1000,
  auto_decider_min_cost_usd: 12,
  auto_decider_max_cost_usd: 24,
  updated_at: '2026-06-01T00:00:00.000Z',
  updated_by: null,
};

describe('syncAutoDeciderModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tokenGet.mockResolvedValue('secret');
    fetchImpl.mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            { id: 'auto/existing', avgAttemptCostUsd: 18 },
            { id: 'auto/new', avgAttemptCostUsd: 21.75 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.mocked(getConfigRows).mockResolvedValue({
      config,
      classifierModels: ['classifier/model'],
      deciderModels: [{ model: 'manual/model', reasoning_effort: null }],
      autoDeciderModels: [
        {
          model: 'auto/existing',
          reasoning_effort: 'high',
          avg_attempt_cost_usd: 18,
          synced_at: '2026-06-01T00:00:00.000Z',
        },
      ],
      excludedAutoDeciderModels: [],
    });
    vi.mocked(replaceAutoDeciderModels).mockResolvedValue(undefined);
    vi.mocked(markStaleRunsFailed).mockResolvedValue(undefined);
    vi.mocked(getRunningRun).mockResolvedValue(undefined);
    vi.mocked(getLatestSummariesByModel).mockResolvedValue(new Map());
    vi.mocked(insertRun).mockResolvedValue(undefined);
    queueSendBatch.mockResolvedValue(undefined);
  });

  it('persists auto candidates, preserves existing reasoning effort, and starts a decider run for new effective models', async () => {
    const result = await syncAutoDeciderModels(env, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://app.test/api/internal/auto-routing-benchmark/decider-candidates?minCostUsd=12&maxCostUsd=24',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer secret' }),
      })
    );
    expect(replaceAutoDeciderModels).toHaveBeenCalledWith(env.BENCH_DB, [
      expect.objectContaining({ model: 'auto/existing', reasoning_effort: 'high' }),
      expect.objectContaining({ model: 'auto/new', reasoning_effort: null }),
    ]);
    expect(insertRun).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      addedModels: ['auto/new'],
      removedModels: [],
      startedRun: true,
    });
  });

  it('does not fail the sync when a decider run is already active', async () => {
    vi.mocked(getRunningRun).mockResolvedValue({
      id: 'decider-active',
      kind: 'decider',
      status: 'running',
      started_at: '2026-06-01T00:00:00.000Z',
      completed_at: null,
      error: null,
      min_accuracy: 0.7,
      switch_cost_factor: 3,
      max_concurrency: 100,
      benchmark_user_id: 'user-123',
      benchmark_org_id: null,
      repetitions: 1,
      classifier_max_p95_latency_ms: null,
      engine_identity: 'v1:test',
    });

    const result = await syncAutoDeciderModels(env, { fetchImpl });

    expect(result).toMatchObject({
      addedModels: ['auto/new'],
      removedModels: [],
      startedRun: false,
      runId: null,
      skippedReason: 'active-run',
      activeRunId: 'decider-active',
    });
    expect(insertRun).not.toHaveBeenCalled();
  });
});
