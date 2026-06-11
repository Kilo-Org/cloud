import { describe, it, expect } from 'vitest';
import { mapSummaryRow, mapRunRow } from './db';
import type { BenchmarkModelSummary } from '@kilocode/auto-routing-contracts';

describe('mapSummaryRow', () => {
  it('maps snake_case columns to camelCase BenchmarkModelSummary', () => {
    const row = {
      run_id: 'run-1',
      model: 'openai/gpt-4o',
      tier: 'high',
      accuracy: 0.92,
      avg_cost_usd: 0.0015,
      avg_latency_ms: 320.5,
      p50_latency_ms: 300.0,
      cases: 50,
      errors: 2,
    };
    const result = mapSummaryRow(row);
    expect(result).toEqual<BenchmarkModelSummary>({
      model: 'openai/gpt-4o',
      tier: 'high',
      accuracy: 0.92,
      avgCostUsd: 0.0015,
      avgLatencyMs: 320.5,
      p50LatencyMs: 300.0,
      cases: 50,
      errors: 2,
    });
  });

  it('handles null avg_cost_usd and p50_latency_ms', () => {
    const row = {
      run_id: 'run-2',
      model: 'anthropic/claude-3-haiku',
      tier: '*',
      accuracy: 0.85,
      avg_cost_usd: null,
      avg_latency_ms: 150.0,
      p50_latency_ms: null,
      cases: 30,
      errors: 0,
    };
    const result = mapSummaryRow(row);
    expect(result.avgCostUsd).toBeNull();
    expect(result.p50LatencyMs).toBeNull();
    expect(result.tier).toBe('*');
    expect(result.errors).toBe(0);
  });
});

describe('mapRunRow', () => {
  it('maps a RunRow and attaches its summaries', () => {
    const runRow = {
      id: 'run-abc',
      kind: 'classifier' as const,
      status: 'completed' as const,
      started_at: '2026-06-10T04:10:00.000Z',
      completed_at: '2026-06-10T04:25:00.000Z',
      config_json: '{}',
      error: null,
    };
    const summaries: BenchmarkModelSummary[] = [
      {
        model: 'openai/gpt-4o-mini',
        tier: '*',
        accuracy: 0.78,
        avgCostUsd: 0.0002,
        avgLatencyMs: 120,
        p50LatencyMs: 110,
        cases: 100,
        errors: 5,
      },
    ];
    const result = mapRunRow(runRow, summaries);
    expect(result.id).toBe('run-abc');
    expect(result.kind).toBe('classifier');
    expect(result.status).toBe('completed');
    expect(result.startedAt).toBe('2026-06-10T04:10:00.000Z');
    expect(result.completedAt).toBe('2026-06-10T04:25:00.000Z');
    expect(result.error).toBeNull();
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0].model).toBe('openai/gpt-4o-mini');
  });

  it('attaches an empty summaries array when none are provided', () => {
    const runRow = {
      id: 'run-xyz',
      kind: 'decider' as const,
      status: 'running' as const,
      started_at: '2026-06-11T05:10:00.000Z',
      completed_at: null,
      config_json: '{}',
      error: null,
    };
    const result = mapRunRow(runRow, []);
    expect(result.summaries).toEqual([]);
    expect(result.completedAt).toBeNull();
  });

  it('summaries are attached to the correct run (not mixed up)', () => {
    const runRow1 = {
      id: 'run-1',
      kind: 'classifier' as const,
      status: 'completed' as const,
      started_at: '2026-06-01T04:10:00.000Z',
      completed_at: '2026-06-01T04:20:00.000Z',
      config_json: '{}',
      error: null,
    };
    const runRow2 = {
      id: 'run-2',
      kind: 'decider' as const,
      status: 'failed' as const,
      started_at: '2026-06-02T05:10:00.000Z',
      completed_at: null,
      config_json: '{}',
      error: 'timed out',
    };
    const summariesForRun1: BenchmarkModelSummary[] = [
      {
        model: 'model-a',
        tier: '*',
        accuracy: 0.9,
        avgCostUsd: null,
        avgLatencyMs: 200,
        p50LatencyMs: null,
        cases: 10,
        errors: 1,
      },
    ];
    const result1 = mapRunRow(runRow1, summariesForRun1);
    const result2 = mapRunRow(runRow2, []);

    expect(result1.summaries).toHaveLength(1);
    expect(result1.summaries[0].model).toBe('model-a');
    expect(result2.summaries).toHaveLength(0);
    expect(result2.error).toBe('timed out');
  });
});
