import { describe, expect, it, vi } from 'vitest';
import type { RankedCandidate, RoutingTable } from '@kilocode/auto-routing-contracts';

const mockState = vi.hoisted(() => ({
  batchCalls: [] as Array<Array<{ kind: string; values?: unknown }>>,
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({
    delete: vi.fn(() => ({
      where: vi.fn(() => ({ kind: 'delete' })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: unknown) => ({
        kind: 'insert',
        values,
        onConflictDoUpdate: vi.fn(() => ({ kind: 'upsert', values })),
      })),
    })),
    batch: vi.fn(async (stmts: Array<{ kind: string; values?: unknown }>) => {
      mockState.batchCalls.push(stmts);
    }),
  })),
}));

const candidate = (model: string): RankedCandidate => ({
  model,
  accuracy: 0.9,
  avgCostUsd: 0.001,
  meetsThreshold: true,
  reasoningEffort: null,
});

describe('saveRoutingTable', () => {
  it('chunks routing candidate inserts to stay under D1 variable limits', async () => {
    const { saveRoutingTable } = await import('./db');

    const table: RoutingTable = {
      version: 'run-large-routing-table',
      generatedAt: '2026-06-16T18:00:00.000Z',
      minAccuracy: 0.7,
      switchCostFactor: 3,
      source: 'benchmark',
      routes: {
        'implementation/code_generation': Array.from({ length: 23 }, (_, index) =>
          candidate(`impl-model-${index}`)
        ),
        'debugging/bug_fixing': [candidate('debug-model')],
        'planning_design/system_design': [candidate('plan-model')],
      },
    };

    await saveRoutingTable({} as D1Database, table, '2026-06-16T18:01:00.000Z');

    const [batch] = mockState.batchCalls;
    expect(batch).toBeDefined();
    const candidateInsertSizes = batch
      .filter(stmt => stmt.kind === 'insert')
      .map(stmt => {
        expect(Array.isArray(stmt.values)).toBe(true);
        return (stmt.values as unknown[]).length;
      });

    expect(candidateInsertSizes).toEqual([10, 10, 5]);
  });
});
