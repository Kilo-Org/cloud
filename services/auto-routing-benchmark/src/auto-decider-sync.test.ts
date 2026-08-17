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
    listStaleRunningDeciderRuns: vi.fn(),
    listPendingCurrentProfiles: vi.fn(),
    syncPlatformRegistryRows: vi.fn(),
    listReadyCurrentProfilesForEntries: vi.fn(),
    getSummariesForRuns: vi.fn(),
    markProfilesFailedForRun: vi.fn(),
    markProfilesRunningForRun: vi.fn(),
    markProfilesReadyForRun: vi.fn(),
  };
});

import {
  getConfigRows,
  getLatestSummariesByModel,
  getRunningRun,
  insertRun,
  getSummariesForRuns,
  listPendingCurrentProfiles,
  markProfilesRunningForRun,
  listReadyCurrentProfilesForEntries,
  syncPlatformRegistryRows,
  listStaleRunningDeciderRuns,
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
  best_accuracy_switch_threshold: 0.05,
  max_concurrency: 100,
  benchmark_user_id: 'user-123',
  benchmark_org_id: null,
  classifier_repetitions: 1,
  decider_repetitions: 1,
  classifier_max_p95_latency_ms: 1000,
  auto_decider_min_cost_usd: 12,
  auto_decider_max_cost_usd: 24,
  user_max_concurrency: 100,
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
      deciderModels: [{ model: 'manual/model', variant: null, reasoning_effort: null }],
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
    vi.mocked(listStaleRunningDeciderRuns).mockResolvedValue([]);
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([]);
    vi.mocked(markProfilesRunningForRun).mockImplementation(async (_db, _runId, entries) => [
      ...entries,
    ]);
    vi.mocked(syncPlatformRegistryRows).mockResolvedValue(undefined);
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([]);
    vi.mocked(getSummariesForRuns).mockResolvedValue([]);
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
    // Newly configured models enter the registry queue; nothing is measured
    // straight from the config list.
    expect(syncPlatformRegistryRows).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      addedModels: ['auto/new'],
      removedModels: [],
    });
  });

  it('does not fail the sync when both queue slots are already active', async () => {
    vi.mocked(getRunningRun).mockResolvedValue({
      id: 'decider-active',
      kind: 'decider',
      status: 'running',
      started_at: '2026-06-01T00:00:00.000Z',
      completed_at: null,
      error: null,
      min_accuracy: 0.7,
      switch_cost_factor: 3,
      best_accuracy_switch_threshold: 0.05,
      max_concurrency: 100,
      benchmark_user_id: 'user-123',
      benchmark_org_id: null,
      repetitions: 1,
      classifier_max_p95_latency_ms: null,
      engine_identity: 'v1:test',
      purpose: 'platform',
    });

    const result = await syncAutoDeciderModels(env, { fetchImpl });

    expect(result).toMatchObject({
      addedModels: ['auto/new'],
      removedModels: [],
      startedRuns: [],
    });
    expect(insertRun).not.toHaveBeenCalled();
  });

  it('drains stranded pending profiles when the slot is free and no model change', async () => {
    // No effective model change after sync.
    fetchImpl.mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ id: 'auto/existing', avgAttemptCostUsd: 18 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.mocked(getConfigRows).mockResolvedValue({
      config,
      classifierModels: ['classifier/model'],
      deciderModels: [{ model: 'manual/model', variant: null, reasoning_effort: null }],
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
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'stranded/m', variant: 'high', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);

    const result = await syncAutoDeciderModels(env, { fetchImpl });

    // Pending work drains even when the model list did not change.
    expect(result.startedRuns.map(run => run.purpose)).toEqual(['platform', 'user']);
    expect(vi.mocked(insertRun).mock.calls.map(call => call[1].purpose)).toEqual([
      'platform',
      'user',
    ]);
  });

  it('reconciles the platform queue with the decider list before draining', async () => {
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'pending/m', variant: 'high', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);

    const result = await syncAutoDeciderModels(env, { fetchImpl });

    // Configured models become registry rows; nothing is measured directly from
    // the config list any more.
    expect(syncPlatformRegistryRows).toHaveBeenCalledOnce();
    const [, , desired] = vi.mocked(syncPlatformRegistryRows).mock.calls[0];
    expect(desired.length).toBe(result.platformEntries);
    expect(desired.length).toBeGreaterThan(0);
    expect(result.startedRuns.map(run => run.purpose)).toEqual(['platform', 'user']);
  });

  it('an occupied platform slot still lets the user queue run', async () => {
    vi.mocked(getRunningRun).mockImplementation(async (_db, _kind, purpose) =>
      purpose === 'user'
        ? undefined
        : ({
            id: 'decider-active',
            kind: 'decider',
            status: 'running',
            started_at: '2026-06-01T00:00:00.000Z',
            completed_at: null,
            error: null,
            min_accuracy: 0.7,
            switch_cost_factor: 3,
            best_accuracy_switch_threshold: 0.05,
            max_concurrency: 100,
            benchmark_user_id: 'user-123',
            benchmark_org_id: null,
            repetitions: 1,
            classifier_max_p95_latency_ms: null,
            engine_identity: 'v1:test',
            purpose: 'platform',
          } as Awaited<ReturnType<typeof getRunningRun>>)
    );
    vi.mocked(listPendingCurrentProfiles).mockResolvedValue([
      { model: 'pending/m', variant: 'high', requested_at: '2026-06-01T00:00:00.000Z' },
    ]);

    const result = await syncAutoDeciderModels(env, { fetchImpl });

    // The platform slot is taken, so only the user queue starts a run.
    expect(result.startedRuns.map(run => run.purpose)).toEqual(['user']);
    expect(vi.mocked(insertRun).mock.calls.map(call => call[1].purpose)).toEqual(['user']);
  });
});
