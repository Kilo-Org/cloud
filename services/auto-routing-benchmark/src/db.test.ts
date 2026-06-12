import { describe, it, expect } from 'vitest';
import type { RankedCandidate, RoutingTable } from '@kilocode/auto-routing-contracts';
import {
  apiKindsToFlags,
  flagsToApiKinds,
  mapRunRow,
  mapSummaryRow,
  routingTableToRows,
  rowsToRoutingTable,
} from './db';
import type { BenchmarkModelSummary } from '@kilocode/auto-routing-contracts';

// ---------------------------------------------------------------------------
// apiKindsToFlags / flagsToApiKinds round-trip
// ---------------------------------------------------------------------------

describe('apiKindsToFlags', () => {
  it('maps all three kinds to true when all present', () => {
    expect(apiKindsToFlags(['chat_completions', 'messages', 'responses'])).toEqual({
      supports_chat_completions: true,
      supports_messages: true,
      supports_responses: true,
    });
  });

  it('maps an empty array to all false', () => {
    expect(apiKindsToFlags([])).toEqual({
      supports_chat_completions: false,
      supports_messages: false,
      supports_responses: false,
    });
  });

  it('maps a single kind correctly', () => {
    expect(apiKindsToFlags(['chat_completions'])).toEqual({
      supports_chat_completions: true,
      supports_messages: false,
      supports_responses: false,
    });
  });
});

describe('flagsToApiKinds', () => {
  it('returns all three kinds when all flags are true', () => {
    expect(
      flagsToApiKinds({
        supports_chat_completions: true,
        supports_messages: true,
        supports_responses: true,
      })
    ).toEqual(['chat_completions', 'messages', 'responses']);
  });

  it('returns empty array when all flags are false', () => {
    expect(
      flagsToApiKinds({
        supports_chat_completions: false,
        supports_messages: false,
        supports_responses: false,
      })
    ).toEqual([]);
  });

  it('returns only the set flags in order: chat_completions, messages, responses', () => {
    expect(
      flagsToApiKinds({
        supports_chat_completions: false,
        supports_messages: true,
        supports_responses: true,
      })
    ).toEqual(['messages', 'responses']);
  });
});

describe('apiKindsToFlags / flagsToApiKinds round-trip', () => {
  const cases: Parameters<typeof apiKindsToFlags>[0][] = [
    [],
    ['chat_completions'],
    ['messages'],
    ['responses'],
    ['chat_completions', 'messages'],
    ['chat_completions', 'responses'],
    ['messages', 'responses'],
    ['chat_completions', 'messages', 'responses'],
  ];

  for (const kinds of cases) {
    it(`round-trips [${kinds.join(', ')}]`, () => {
      expect(flagsToApiKinds(apiKindsToFlags(kinds))).toEqual(kinds);
    });
  }
});

// ---------------------------------------------------------------------------
// mapSummaryRow
// ---------------------------------------------------------------------------

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
      carried: false,
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
      carried: false,
    };
    const result = mapSummaryRow(row);
    expect(result.avgCostUsd).toBeNull();
    expect(result.p50LatencyMs).toBeNull();
    expect(result.tier).toBe('*');
    expect(result.errors).toBe(0);
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
      max_concurrency: 4,
      benchmark_user_id: null,
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
      error: null,
      min_accuracy: 0.7,
      max_concurrency: 4,
      benchmark_user_id: null,
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
  supportedApiKinds: ['chat_completions', 'messages'],
  reasoningEffort: null,
});

const sampleTable: RoutingTable = {
  version: 'run-test-1',
  generatedAt: '2026-06-01T10:00:00.000Z',
  minAccuracy: 0.7,
  source: 'benchmark',
  tiers: {
    low: [candidate('model-a'), candidate('model-b')],
    medium: [candidate('model-c')],
    high: [candidate('model-a')],
  },
};

describe('routingTableToRows', () => {
  it('produces a tableRow with the correct scalar fields', () => {
    const { tableRow } = routingTableToRows(sampleTable, '2026-06-01T11:00:00.000Z');
    expect(tableRow.run_id).toBe('run-test-1');
    expect(tableRow.published_at).toBe('2026-06-01T11:00:00.000Z');
    expect(tableRow.generated_at).toBe('2026-06-01T10:00:00.000Z');
    expect(tableRow.min_accuracy).toBe(0.7);
    expect(tableRow.source).toBe('benchmark');
  });

  it('assigns rank 0,1 for the two low-tier candidates', () => {
    const { candidateRows } = routingTableToRows(sampleTable, '2026-06-01T11:00:00.000Z');
    const lowRows = candidateRows.filter(r => r.tier === 'low').sort((a, b) => a.rank - b.rank);
    expect(lowRows).toHaveLength(2);
    expect(lowRows[0].model).toBe('model-a');
    expect(lowRows[0].rank).toBe(0);
    expect(lowRows[1].model).toBe('model-b');
    expect(lowRows[1].rank).toBe(1);
  });

  it('maps supportedApiKinds to boolean flags', () => {
    const { candidateRows } = routingTableToRows(sampleTable, '2026-06-01T11:00:00.000Z');
    const row = candidateRows[0];
    expect(row.supports_chat_completions).toBe(true);
    expect(row.supports_messages).toBe(true);
    expect(row.supports_responses).toBe(false);
  });
});

describe('rowsToRoutingTable', () => {
  it('round-trips: rowsToRoutingTable(routingTableToRows(table)) === table', () => {
    const { tableRow, candidateRows } = routingTableToRows(sampleTable, '2026-06-01T11:00:00.000Z');
    const reassembled = rowsToRoutingTable(tableRow, candidateRows);
    expect(reassembled).toEqual(sampleTable);
  });

  it('preserves candidate order within each tier', () => {
    const { tableRow, candidateRows } = routingTableToRows(sampleTable, '2026-06-01T11:00:00.000Z');
    // Shuffle candidateRows to verify rank-based sorting.
    const shuffled = [...candidateRows].reverse();
    const reassembled = rowsToRoutingTable(tableRow, shuffled);
    expect(reassembled.tiers.low[0].model).toBe('model-a');
    expect(reassembled.tiers.low[1].model).toBe('model-b');
  });

  it('preserves null avgCostUsd through routingTableToRows → rowsToRoutingTable', () => {
    const nullCostCandidate: RankedCandidate = {
      model: 'model-nullcost',
      accuracy: 0.88,
      avgCostUsd: null as unknown as number,
      meetsThreshold: true,
      supportedApiKinds: ['responses'],
      reasoningEffort: null,
    };
    const tableWithNullCost: RoutingTable = {
      version: 'run-null-cost',
      generatedAt: '2026-06-01T10:00:00.000Z',
      minAccuracy: 0.7,
      source: 'benchmark',
      tiers: {
        low: [nullCostCandidate],
        medium: [candidate('model-c')],
        high: [candidate('model-a')],
      },
    };
    const { tableRow, candidateRows } = routingTableToRows(
      tableWithNullCost,
      '2026-06-01T11:00:00.000Z'
    );
    const lowRow = candidateRows.find(r => r.tier === 'low');
    expect(lowRow?.avg_cost_usd).toBeNull();
    const reassembled = rowsToRoutingTable(tableRow, candidateRows);
    expect(reassembled.tiers.low[0].avgCostUsd).toBeNull();
  });
});
