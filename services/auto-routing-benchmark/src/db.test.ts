import { describe, it, expect } from 'vitest';
import { RoutingTableSchema } from '@kilocode/auto-routing-contracts';
import type { RankedCandidate, RoutingTable } from '@kilocode/auto-routing-contracts';
import { mapRunRow, mapSummaryRow, routingTableToRows, rowsToRoutingTable } from './db';
import type { BenchmarkModelSummary } from '@kilocode/auto-routing-contracts';

// ---------------------------------------------------------------------------
// mapSummaryRow
// ---------------------------------------------------------------------------

describe('mapSummaryRow', () => {
  it('maps snake_case columns to camelCase BenchmarkModelSummary', () => {
    const row = {
      run_id: 'run-1',
      model: 'openai/gpt-4o',
      route_key: 'implementation/code_generation',
      accuracy: 0.92,
      avg_cost_usd: 0.0015,
      avg_latency_ms: 320.5,
      p50_latency_ms: 300.0,
      p95_latency_ms: 300.0,
      cases: 50,
      errors: 2,
      timeouts: 0,
      carried: false,
    };
    const result = mapSummaryRow(row);
    expect(result).toEqual<BenchmarkModelSummary>({
      model: 'openai/gpt-4o',
      routeKey: 'implementation/code_generation',
      accuracy: 0.92,
      avgCostUsd: 0.0015,
      avgLatencyMs: 320.5,
      p50LatencyMs: 300.0,
      p95LatencyMs: 300.0,
      cases: 50,
      errors: 2,
      timeouts: 0,
    });
  });

  it('handles null avg_cost_usd and p50_latency_ms', () => {
    const row = {
      run_id: 'run-2',
      model: 'anthropic/claude-3-haiku',
      route_key: '*',
      accuracy: 0.85,
      avg_cost_usd: null,
      avg_latency_ms: 150.0,
      p50_latency_ms: null,
      p95_latency_ms: null,
      cases: 30,
      errors: 0,
      timeouts: 0,
      carried: false,
    };
    const result = mapSummaryRow(row);
    expect(result.avgCostUsd).toBeNull();
    expect(result.p50LatencyMs).toBeNull();
    expect(result.p95LatencyMs).toBeNull();
    expect(result.routeKey).toBe('*');
    expect(result.errors).toBe(0);
    expect(result.timeouts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// mapRunRow
// ---------------------------------------------------------------------------

describe('mapRunRow', () => {
  it('maps a RunRow and attaches its summaries', () => {
    const runRow = {
      id: 'run-abc',
      kind: 'classifier' as const,
      status: 'completed' as const,
      started_at: '2026-06-10T04:10:00.000Z',
      completed_at: '2026-06-10T04:25:00.000Z',
      error: null,
      min_accuracy: 0.7,
      switch_cost_factor: 3,
      best_accuracy_switch_threshold: 0.05,
      max_concurrency: 4,
      benchmark_user_id: null,
      benchmark_org_id: null,
      repetitions: 1,
      classifier_max_p95_latency_ms: null,
      engine_identity: 'v1:deadbeef',
    };
    const summaries: BenchmarkModelSummary[] = [
      {
        model: 'openai/gpt-4o-mini',
        routeKey: '*',
        accuracy: 0.78,
        avgCostUsd: 0.0002,
        avgLatencyMs: 120,
        p50LatencyMs: 110,
        p95LatencyMs: null,
        cases: 100,
        errors: 5,
        timeouts: 0,
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
      error: null,
      min_accuracy: 0.7,
      switch_cost_factor: 3,
      best_accuracy_switch_threshold: 0.05,
      max_concurrency: 4,
      benchmark_user_id: null,
      benchmark_org_id: null,
      repetitions: 1,
      classifier_max_p95_latency_ms: null,
      engine_identity: 'v1:deadbeef',
    };
    const result = mapRunRow(runRow, []);
    expect(result.summaries).toEqual([]);
    expect(result.completedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// routingTableToRows / rowsToRoutingTable round-trip
// ---------------------------------------------------------------------------

const candidate = (model: string): RankedCandidate => ({
  model,
  accuracy: 0.9,
  avgCostUsd: 0.001,
  meetsThreshold: true,
  reasoningEffort: null,
});

const sampleTable: RoutingTable = {
  version: 'run-test-1',
  generatedAt: '2026-06-01T10:00:00.000Z',
  minAccuracy: 0.7,
  switchCostFactor: 3,
  bestAccuracySwitchThreshold: 0.05,
  source: 'benchmark',
  routes: {
    'implementation/code_generation': [candidate('model-a'), candidate('model-b')],
    'debugging/bug_fixing': [candidate('model-c')],
  },
};

describe('routingTableToRows', () => {
  it('produces a tableRow with the correct scalar fields', () => {
    const { tableRow } = routingTableToRows(sampleTable, '2026-06-01T11:00:00.000Z');
    expect(tableRow.run_id).toBe('run-test-1');
    expect(tableRow.published_at).toBe('2026-06-01T11:00:00.000Z');
    expect(tableRow.generated_at).toBe('2026-06-01T10:00:00.000Z');
    expect(tableRow.min_accuracy).toBe(0.7);
    expect(tableRow.switch_cost_factor).toBe(3);
    expect(tableRow.best_accuracy_switch_threshold).toBe(0.05);
    expect(tableRow.source).toBe('benchmark');
  });

  it('assigns rank 0,1 for the two implementation/code_generation candidates', () => {
    const { candidateRows } = routingTableToRows(sampleTable, '2026-06-01T11:00:00.000Z');
    const routeRows = candidateRows
      .filter(r => r.route_key === 'implementation/code_generation')
      .sort((a, b) => a.rank - b.rank);
    expect(routeRows).toHaveLength(2);
    expect(routeRows[0].model).toBe('model-a');
    expect(routeRows[0].rank).toBe(0);
    expect(routeRows[1].model).toBe('model-b');
    expect(routeRows[1].rank).toBe(1);
  });
});

describe('rowsToRoutingTable', () => {
  it('round-trips: rowsToRoutingTable(routingTableToRows(table)) === table', () => {
    const { tableRow, candidateRows } = routingTableToRows(sampleTable, '2026-06-01T11:00:00.000Z');
    const reassembled = rowsToRoutingTable(tableRow, candidateRows);
    expect(reassembled).toEqual(sampleTable);
    // The reassembled table must satisfy the contract schema (getLatestRoutingTable parses it).
    expect(RoutingTableSchema.parse(reassembled)).toEqual(sampleTable);
  });

  it('preserves candidate order within each route', () => {
    const { tableRow, candidateRows } = routingTableToRows(sampleTable, '2026-06-01T11:00:00.000Z');
    // Shuffle candidateRows to verify rank-based sorting.
    const shuffled = [...candidateRows].reverse();
    const reassembled = rowsToRoutingTable(tableRow, shuffled);
    expect(reassembled.routes['implementation/code_generation']?.[0]?.model).toBe('model-a');
    expect(reassembled.routes['implementation/code_generation']?.[1]?.model).toBe('model-b');
  });
});
