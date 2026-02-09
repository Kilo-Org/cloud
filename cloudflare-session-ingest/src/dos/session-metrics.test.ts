import { describe, it, expect } from 'vitest';
import { computeSessionMetrics } from '../dos/session-metrics';

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
