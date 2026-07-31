import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RankedCandidate, RoutingTable } from '@kilocode/auto-routing-contracts';

const mocks = vi.hoisted(() => {
  const batch = vi.fn(async (_stmts: unknown[]) => []);
  const where = vi.fn(() => ({ kind: 'delete' }));
  const deleteFrom = vi.fn(() => ({ where }));
  const onConflictDoUpdate = vi.fn((args: unknown) => ({ kind: 'upsert', args }));
  const insertValues = vi.fn((values: unknown) => ({
    kind: 'insert',
    values,
    onConflictDoUpdate,
  }));
  const insertInto = vi.fn(() => ({ values: insertValues }));

  return { batch, deleteFrom, insertInto, insertValues, onConflictDoUpdate, where };
});

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({
    batch: mocks.batch,
    delete: mocks.deleteFrom,
    insert: mocks.insertInto,
  })),
}));

import { saveRoutingTable } from './db';

const candidate = (model: string): RankedCandidate => ({
  model,
  accuracy: 0.9,
  avgCostUsd: 0.001,
  meetsThreshold: true,
  reasoningEffort: null,
});

describe('saveRoutingTable', () => {
  beforeEach(() => {
    mocks.batch.mockClear();
    mocks.deleteFrom.mockClear();
    mocks.insertInto.mockClear();
    mocks.insertValues.mockClear();
    mocks.onConflictDoUpdate.mockClear();
    mocks.where.mockClear();
  });

  it('chunks routing candidate inserts to stay under D1 variable limits', async () => {
    const table: RoutingTable = {
      version: 'run-large-routing-table',
      generatedAt: '2026-06-16T18:00:00.000Z',
      minAccuracy: 0.7,
      switchCostFactor: 3,
      bestAccuracySwitchThreshold: 0.05,
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

    expect(mocks.batch).toHaveBeenCalledTimes(1);
    const batch = mocks.batch.mock.calls[0]?.[0] as Array<{ kind: string; values?: unknown }>;
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
