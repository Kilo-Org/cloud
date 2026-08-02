import { describe, it, expect } from 'vitest';
import {
  computeRunningAssistantCostUsd,
  computeSessionMetrics,
  decideLivePersist,
  type DecideLivePersistArgs,
} from '../dos/session-metrics';

function makeItem(item_type: string, data: Record<string, unknown>) {
  return { item_type, item_data: JSON.stringify(data) };
}

describe('computeSessionMetrics', () => {
  it('returns zeroed metrics for empty items', () => {
    const result = computeSessionMetrics([], 'completed');
    expect(result.totalTurns).toBe(0);
    expect(result.totalSteps).toBe(0);
    expect(result.totalErrors).toBe(0);
    expect(result.totalCost).toBe(0);
    expect(result.compactionCount).toBe(0);
    expect(result.terminationReason).toBe('completed');
    expect(result.platform).toBe('unknown');
  });

  it('counts user messages as turns', () => {
    const items = [
      makeItem('message', { role: 'user', time: { created: 1000 } }),
      makeItem('message', { role: 'user', time: { created: 2000 } }),
      makeItem('message', { role: 'assistant', time: { created: 1500 } }),
    ];
    const result = computeSessionMetrics(items, 'completed');
    expect(result.totalTurns).toBe(2);
  });

  it('counts step-finish parts as steps', () => {
    const items = [
      makeItem('part', { type: 'step-finish', tokens: { input: 100, output: 50 } }),
      makeItem('part', { type: 'step-finish', tokens: { input: 200, output: 100 } }),
      makeItem('part', { type: 'text', text: 'hello' }),
    ];
    const result = computeSessionMetrics(items, 'completed');
    expect(result.totalSteps).toBe(2);
  });

  it('counts tool calls by type', () => {
    const items = [
      makeItem('part', {
        type: 'tool',
        tool: 'read_file',
        state: { status: 'completed', input: {} },
      }),
      makeItem('part', {
        type: 'tool',
        tool: 'read_file',
        state: { status: 'completed', input: {} },
      }),
      makeItem('part', {
        type: 'tool',
        tool: 'write_file',
        state: { status: 'completed', input: { path: '/a' } },
      }),
    ];
    const result = computeSessionMetrics(items, 'completed');
    expect(result.toolCallsByType).toEqual({ read_file: 2, write_file: 1 });
  });

  it('counts tool errors by type', () => {
    const items = [
      makeItem('part', {
        type: 'tool',
        tool: 'write_file',
        state: { status: 'error', input: {}, error: 'fail' },
      }),
      makeItem('part', {
        type: 'tool',
        tool: 'read_file',
        state: { status: 'completed', input: {} },
      }),
    ];
    const result = computeSessionMetrics(items, 'completed');
    expect(result.toolErrorsByType).toEqual({ write_file: 1 });
    expect(result.totalErrors).toBe(1);
  });

  it('detects stuck tool calls (3+ identical tool+input)', () => {
    const items = [
      makeItem('part', {
        type: 'tool',
        tool: 'read_file',
        state: { status: 'completed', input: { path: '/a' } },
      }),
      makeItem('part', {
        type: 'tool',
        tool: 'read_file',
        state: { status: 'completed', input: { path: '/a' } },
      }),
      makeItem('part', {
        type: 'tool',
        tool: 'read_file',
        state: { status: 'completed', input: { path: '/a' } },
      }),
      makeItem('part', {
        type: 'tool',
        tool: 'read_file',
        state: { status: 'completed', input: { path: '/b' } },
      }),
    ];
    const result = computeSessionMetrics(items, 'completed');
    // 3 calls with same input = 3 stuck; the unique /b call is not counted
    expect(result.stuckToolCallCount).toBe(3);
  });

  it('does not count 2 identical tool calls as stuck', () => {
    const items = [
      makeItem('part', {
        type: 'tool',
        tool: 'read_file',
        state: { status: 'completed', input: { path: '/a' } },
      }),
      makeItem('part', {
        type: 'tool',
        tool: 'read_file',
        state: { status: 'completed', input: { path: '/a' } },
      }),
    ];
    const result = computeSessionMetrics(items, 'completed');
    expect(result.stuckToolCallCount).toBe(0);
  });

  it('sums tokens from assistant messages', () => {
    const items = [
      makeItem('message', {
        role: 'assistant',
        time: { created: 1000 },
        tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } },
        cost: 0.05,
      }),
      makeItem('message', {
        role: 'assistant',
        time: { created: 2000 },
        tokens: { input: 200, output: 100, reasoning: 20, cache: { read: 30, write: 10 } },
        cost: 0.1,
      }),
    ];
    const result = computeSessionMetrics(items, 'completed');
    expect(result.totalTokens).toEqual({
      input: 300,
      output: 150,
      reasoning: 30,
      cacheRead: 50,
      cacheWrite: 15,
    });
    expect(result.totalCost).toBeCloseTo(0.15);
  });

  it('clamps negative token and cost totals to 0', () => {
    const items = [
      makeItem('message', {
        role: 'assistant',
        time: { created: 1000 },
        tokens: {
          input: -10,
          output: -20,
          reasoning: -30,
          cache: { read: -40, write: -50 },
        },
        cost: -0.05,
      }),
    ];
    const result = computeSessionMetrics(items, 'completed');
    expect(result.totalTokens).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(result.totalCost).toBe(0);
  });

  it('counts compaction parts', () => {
    const items = [
      makeItem('part', { type: 'compaction', auto: true }),
      makeItem('part', { type: 'compaction', auto: false }),
      makeItem('part', { type: 'compaction', auto: true }),
    ];
    const result = computeSessionMetrics(items, 'completed');
    expect(result.compactionCount).toBe(3);
    expect(result.autoCompactionCount).toBe(2);
  });

  it('computes session duration from session timestamps', () => {
    const items = [makeItem('session', { time: { created: 1000, updated: 61000 } })];
    const result = computeSessionMetrics(items, 'completed');
    expect(result.sessionDurationMs).toBe(60000);
  });

  it('computes time to first response', () => {
    const items = [
      makeItem('message', { role: 'user', time: { created: 1000 } }),
      makeItem('message', {
        role: 'assistant',
        time: { created: 2500 },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0,
      }),
    ];
    const result = computeSessionMetrics(items, 'completed');
    expect(result.timeToFirstResponseMs).toBe(1500);
  });

  it('extracts platform from kilo_meta', () => {
    const items = [makeItem('kilo_meta', { platform: 'vscode', orgId: 'org-123' })];
    const result = computeSessionMetrics(items, 'completed');
    expect(result.platform).toBe('vscode');
    expect(result.organizationId).toBe('org-123');
  });

  it('tracks errors by type from assistant messages', () => {
    const items = [
      makeItem('message', {
        role: 'assistant',
        time: { created: 1000 },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0,
        error: { name: 'APIError', data: { message: 'rate limited' } },
      }),
      makeItem('message', {
        role: 'assistant',
        time: { created: 2000 },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0,
        error: { name: 'MessageOutputLengthError', data: {} },
      }),
    ];
    const result = computeSessionMetrics(items, 'completed');
    expect(result.totalErrors).toBe(2);
    expect(result.errorsByType).toEqual({ APIError: 1, MessageOutputLengthError: 1 });
  });

  describe('termination reason', () => {
    it('uses explicit close reason when provided', () => {
      const result = computeSessionMetrics([], 'completed');
      expect(result.terminationReason).toBe('completed');
    });

    it('uses interrupted close reason', () => {
      const result = computeSessionMetrics([], 'interrupted');
      expect(result.terminationReason).toBe('interrupted');
    });

    it('uses error close reason', () => {
      const result = computeSessionMetrics([], 'error');
      expect(result.terminationReason).toBe('error');
    });

    it('uses abandoned close reason', () => {
      const result = computeSessionMetrics([], 'abandoned');
      expect(result.terminationReason).toBe('abandoned');
    });

    it('uses unknown close reason', () => {
      const result = computeSessionMetrics([], 'unknown');
      expect(result.terminationReason).toBe('unknown');
    });
  });

  it('handles malformed item_data gracefully', () => {
    const items = [
      { item_type: 'message', item_data: 'not json' },
      { item_type: 'message', item_data: 'null' },
      makeItem('message', { role: 'user', time: { created: 1000 } }),
    ];
    const result = computeSessionMetrics(items, 'completed');
    expect(result.totalTurns).toBe(1);
  });

  it('clamps negative session duration to 0', () => {
    const items = [makeItem('session', { time: { created: 61000, updated: 1000 } })];
    const result = computeSessionMetrics(items, 'completed');
    expect(result.sessionDurationMs).toBe(0);
  });

  it('returns undefined timeToFirstResponseMs with only user messages', () => {
    const items = [
      makeItem('message', { role: 'user', time: { created: 1000 } }),
      makeItem('message', { role: 'user', time: { created: 2000 } }),
    ];
    const result = computeSessionMetrics(items, 'completed');
    expect(result.timeToFirstResponseMs).toBeUndefined();
  });

  it('returns undefined timeToFirstResponseMs with only assistant messages', () => {
    const items = [
      makeItem('message', {
        role: 'assistant',
        time: { created: 1000 },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0,
      }),
    ];
    const result = computeSessionMetrics(items, 'completed');
    expect(result.timeToFirstResponseMs).toBeUndefined();
  });

  it('uses last kilo_meta for platform and orgId', () => {
    const items = [
      makeItem('kilo_meta', { platform: 'vscode', orgId: 'org-1' }),
      makeItem('kilo_meta', { platform: 'cli', orgId: 'org-2' }),
    ];
    const result = computeSessionMetrics(items, 'completed');
    expect(result.platform).toBe('cli');
    expect(result.organizationId).toBe('org-2');
  });

  it('uses last session item for duration timestamps', () => {
    const items = [
      makeItem('session', { time: { created: 1000, updated: 2000 } }),
      makeItem('session', { time: { created: 5000, updated: 10000 } }),
    ];
    const result = computeSessionMetrics(items, 'completed');
    expect(result.sessionDurationMs).toBe(5000);
  });

  it('clamps timeToFirstResponseMs to 0 when assistant precedes user', () => {
    const items = [
      makeItem('message', { role: 'user', time: { created: 5000 } }),
      makeItem('message', {
        role: 'assistant',
        time: { created: 1000 },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0,
      }),
    ];
    const result = computeSessionMetrics(items, 'completed');
    expect(result.timeToFirstResponseMs).toBe(0);
  });
});

function assistantMessage(cost: number) {
  return makeItem('message', {
    role: 'assistant',
    time: { created: 1000 },
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    cost,
  });
}

describe('computeRunningAssistantCostUsd', () => {
  it('sums assistant message costs in USD', () => {
    const rows = [assistantMessage(0.05), assistantMessage(0.1)];
    expect(computeRunningAssistantCostUsd(rows)).toBeCloseTo(0.15);
  });

  it('ignores user messages', () => {
    const rows = [
      makeItem('message', { role: 'user', time: { created: 1000 } }),
      assistantMessage(0.2),
    ];
    expect(computeRunningAssistantCostUsd(rows)).toBeCloseTo(0.2);
  });

  it('skips malformed rows', () => {
    const rows = [{ item_data: 'not json' }, { item_data: 'null' }, assistantMessage(0.07)];
    expect(computeRunningAssistantCostUsd(rows)).toBeCloseTo(0.07);
  });

  it("treats R2-offloaded '{}' as 0", () => {
    expect(computeRunningAssistantCostUsd([{ item_data: '{}' }])).toBe(0);
  });

  it('clamps negative totals to 0', () => {
    expect(computeRunningAssistantCostUsd([assistantMessage(-0.5)])).toBe(0);
  });

  it('converts to microdollars with the close-path formula (0.15 USD → 150_000)', () => {
    const usd = computeRunningAssistantCostUsd([assistantMessage(0.15)]);
    expect(Math.max(0, Math.round(usd * 1_000_000))).toBe(150_000);
  });
});

function baseDecideArgs(overrides: Partial<DecideLivePersistArgs> = {}): DecideLivePersistArgs {
  return {
    nowMs: 100_000,
    wroteActivityItem: false,
    wroteAssistantMessageItem: false,
    idleTransition: false,
    lastActivityValueMs: 100_000,
    lastActivityPersistedAtMs: null,
    lastActivityPersistedValueMs: null,
    currentCostMicrodollars: null,
    lastCostPersistedAtMs: null,
    lastCostPersistedMicrodollars: null,
    ...overrides,
  };
}

describe('decideLivePersist', () => {
  it('no-ops when nothing was written and cost was not computed', () => {
    expect(decideLivePersist(baseDecideArgs())).toEqual({
      persistActivity: false,
      persistCost: false,
    });
  });

  it('persists activity on first activity write', () => {
    expect(
      decideLivePersist(baseDecideArgs({ wroteActivityItem: true, lastActivityValueMs: 50_000 }))
    ).toEqual({ persistActivity: true, persistCost: false });
  });

  it('throttles activity within 15s', () => {
    expect(
      decideLivePersist(
        baseDecideArgs({
          nowMs: 100_000,
          wroteActivityItem: true,
          lastActivityValueMs: 100_000,
          lastActivityPersistedAtMs: 90_000,
          lastActivityPersistedValueMs: 90_000,
        })
      )
    ).toEqual({ persistActivity: false, persistCost: false });
  });

  it('allows activity after 15s when value is newer', () => {
    expect(
      decideLivePersist(
        baseDecideArgs({
          nowMs: 110_000,
          wroteActivityItem: true,
          lastActivityValueMs: 110_000,
          lastActivityPersistedAtMs: 90_000,
          lastActivityPersistedValueMs: 90_000,
        })
      )
    ).toEqual({ persistActivity: true, persistCost: false });
  });

  it('blocks activity when candidate value is not newer (monotonic)', () => {
    expect(
      decideLivePersist(
        baseDecideArgs({
          nowMs: 200_000,
          wroteActivityItem: true,
          lastActivityValueMs: 50_000,
          lastActivityPersistedAtMs: 10_000,
          lastActivityPersistedValueMs: 50_000,
        })
      )
    ).toEqual({ persistActivity: false, persistCost: false });
  });

  it('persists cost on first assistant message when cost differs', () => {
    expect(
      decideLivePersist(
        baseDecideArgs({
          wroteAssistantMessageItem: true,
          currentCostMicrodollars: 150_000,
        })
      )
    ).toEqual({ persistActivity: false, persistCost: true });
  });

  it('throttles cost within 30s even with assistant message', () => {
    expect(
      decideLivePersist(
        baseDecideArgs({
          nowMs: 100_000,
          wroteAssistantMessageItem: true,
          currentCostMicrodollars: 200_000,
          lastCostPersistedAtMs: 80_000,
          lastCostPersistedMicrodollars: 100_000,
        })
      )
    ).toEqual({ persistActivity: false, persistCost: false });
  });

  it('allows cost after 30s when value changed', () => {
    expect(
      decideLivePersist(
        baseDecideArgs({
          nowMs: 120_000,
          wroteAssistantMessageItem: true,
          currentCostMicrodollars: 200_000,
          lastCostPersistedAtMs: 80_000,
          lastCostPersistedMicrodollars: 100_000,
        })
      )
    ).toEqual({ persistActivity: false, persistCost: true });
  });

  it('skips cost when microdollars unchanged', () => {
    expect(
      decideLivePersist(
        baseDecideArgs({
          wroteAssistantMessageItem: true,
          currentCostMicrodollars: 100_000,
          lastCostPersistedMicrodollars: 100_000,
        })
      )
    ).toEqual({ persistActivity: false, persistCost: false });
  });

  it('skips cost when recomputed value decreased (monotonic, matches SQL CASE)', () => {
    expect(
      decideLivePersist(
        baseDecideArgs({
          wroteAssistantMessageItem: true,
          currentCostMicrodollars: 50_000,
          lastCostPersistedMicrodollars: 100_000,
        })
      )
    ).toEqual({ persistActivity: false, persistCost: false });
  });

  it('skips decreased cost even on idleTransition', () => {
    expect(
      decideLivePersist(
        baseDecideArgs({
          idleTransition: true,
          currentCostMicrodollars: 80_000,
          lastCostPersistedMicrodollars: 100_000,
        })
      )
    ).toEqual({ persistActivity: false, persistCost: false });
  });

  it('persists cost 0 when never persisted before (null last → -1)', () => {
    expect(
      decideLivePersist(
        baseDecideArgs({
          wroteAssistantMessageItem: true,
          currentCostMicrodollars: 0,
          lastCostPersistedMicrodollars: null,
        })
      )
    ).toEqual({ persistActivity: false, persistCost: true });
  });

  it('forces cost on idleTransition without assistant message or throttle window', () => {
    expect(
      decideLivePersist(
        baseDecideArgs({
          nowMs: 100_000,
          idleTransition: true,
          currentCostMicrodollars: 250_000,
          lastCostPersistedAtMs: 99_000,
          lastCostPersistedMicrodollars: 100_000,
        })
      )
    ).toEqual({ persistActivity: false, persistCost: true });
  });

  it('does not persist cost when currentCostMicrodollars is null', () => {
    expect(
      decideLivePersist(
        baseDecideArgs({
          wroteAssistantMessageItem: true,
          idleTransition: true,
          currentCostMicrodollars: null,
        })
      )
    ).toEqual({ persistActivity: false, persistCost: false });
  });

  it('can fire both activity and cost in one decision', () => {
    expect(
      decideLivePersist(
        baseDecideArgs({
          wroteActivityItem: true,
          wroteAssistantMessageItem: true,
          lastActivityValueMs: 100_000,
          currentCostMicrodollars: 50_000,
        })
      )
    ).toEqual({ persistActivity: true, persistCost: true });
  });
});
