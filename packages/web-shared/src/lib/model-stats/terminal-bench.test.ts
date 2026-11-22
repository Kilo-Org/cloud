import { beforeEach, describe, expect, it } from '@jest/globals';
import type { ModelStats } from '@kilocode/db/schema';
import {
  getTerminalBenchSummaries,
  summarizeTerminalBench,
  terminalBenchFor,
} from './terminal-bench';
import { getModelStatsSnapshot } from './model-stats-cache';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import type {
  ModelStatsCacheEntry,
  ModelStatsLoadClient,
  ModelStatsSnapshot,
} from './model-stats-cache';

jest.mock('./model-stats-cache', () => ({
  getModelStatsSnapshot: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  warnExceptInTest: jest.fn(),
}));

const mockSnapshot = jest.mocked(getModelStatsSnapshot);
const mockWarn = jest.mocked(warnExceptInTest);

const summary = { overallScore: 0.551, avgAttemptCostUsd: 53.37 };

function benchmarks(
  overrides: Partial<{ nAttempts: number | null; avgAttemptCostUsd: number | null }> = {}
) {
  return {
    kiloBench: {
      overallScore: 0.4,
      evals: {
        'terminal-bench': {
          taskSource: 'terminal-bench',
          overallScore: summary.overallScore,
          totalScore: 2.755,
          avgCostUsd: 1,
          avgInputTokens: 1,
          avgOutputTokens: 1,
          avgCacheReadTokens: 1,
          avgExecutionMs: 1,
          nTotalTrials: 5,
          nAttempts: 5,
          avgAttemptCostUsd: summary.avgAttemptCostUsd,
          avgAttemptInputTokens: 1,
          avgAttemptOutputTokens: 1,
          avgAttemptCacheReadTokens: 1,
          nErrored: 0,
          lastPromotedAt: '2026-06-03T00:00:00.000Z',
          ...overrides,
        },
      },
    },
  };
}

type RowOverrides = Partial<Omit<ModelStats, 'benchmarks'>> & { benchmarks?: unknown };

function row(overrides: RowOverrides = {}): ModelStatsCacheEntry {
  return {
    stat: {
      openrouterId: 'openai/model',
      isActive: true,
      isStealth: false,
      benchmarks: benchmarks(),
      ...overrides,
    } as ModelStats,
    verification: undefined,
  };
}

function snapshot(
  entries: readonly ModelStatsCacheEntry[],
  customLlmIds: ReadonlySet<string> = new Set()
): ModelStatsSnapshot {
  return { entries, observedAt: Date.now(), generation: 0, customLlmIds };
}

beforeEach(() => {
  mockSnapshot.mockReset();
  mockWarn.mockReset();
});

describe('summarizeTerminalBench', () => {
  it('publishes only eligible non-internal summaries', () => {
    const nullable = {
      ...benchmarks(),
      artificialAnalysis: { liveCodeBench: null },
    };
    const summaries = summarizeTerminalBench(
      [
        row(),
        row({ openrouterId: 'stealth/model', isStealth: true }),
        row({ openrouterId: 'nullable/model', benchmarks: nullable }),
        row({ openrouterId: 'Acme/Custom', benchmarks: benchmarks() }),
        row({ isActive: false }),
        row({ benchmarks: benchmarks({ nAttempts: 4 }) }),
        row({ benchmarks: benchmarks({ avgAttemptCostUsd: null }) }),
        row({ benchmarks: { kiloBench: { overallScore: 0.4, evals: {} } } }),
        row({ benchmarks: { kiloBench: { overallScore: 'invalid' } } }),
      ],
      new Set(['acme/custom'])
    );

    expect(summaries).toEqual(
      new Map([
        ['openai/model', summary],
        ['stealth/model', summary],
        ['nullable/model', summary],
      ])
    );
  });
});

describe('getTerminalBenchSummaries', () => {
  it('derives the summaries from one snapshot load', async () => {
    mockSnapshot.mockResolvedValue(
      snapshot(
        [row(), row({ openrouterId: 'acme/custom' }), row({ isActive: false })],
        new Set(['acme/custom'])
      )
    );

    expect(await getTerminalBenchSummaries()).toEqual(new Map([['openai/model', summary]]));
    expect(mockSnapshot).toHaveBeenCalledTimes(1);
    expect(mockSnapshot).toHaveBeenCalledWith({ fromDb: undefined });
  });

  it('issues one snapshot load per call, never a load per row', async () => {
    mockSnapshot.mockResolvedValue(
      snapshot([
        row(),
        row({ openrouterId: 'short/model', benchmarks: benchmarks({ nAttempts: 4 }) }),
        row({
          openrouterId: 'uncosted/model',
          benchmarks: benchmarks({ avgAttemptCostUsd: null }),
        }),
      ])
    );

    const first = await getTerminalBenchSummaries();
    const second = await getTerminalBenchSummaries();

    expect(first).toEqual(new Map([['openai/model', summary]]));
    expect(second).toEqual(first);
    expect(mockSnapshot).toHaveBeenCalledTimes(2);
  });

  it('forwards the caller client to the snapshot load', async () => {
    mockSnapshot.mockResolvedValue(snapshot([row()]));
    const replica = { select: jest.fn() } as unknown as ModelStatsLoadClient;

    await getTerminalBenchSummaries({ fromDb: replica });

    expect(mockSnapshot.mock.calls).toHaveLength(1);
    expect(mockSnapshot.mock.calls[0]?.[0]?.fromDb).toBe(replica);
  });

  it('computes the summaries once per snapshot, not once per call', async () => {
    const shared = snapshot([row()]);
    mockSnapshot.mockResolvedValue(shared);

    const first = await getTerminalBenchSummaries();
    const second = await getTerminalBenchSummaries();

    expect(mockSnapshot).toHaveBeenCalledTimes(2);
    expect(second).toBe(first);
    expect(first).toEqual(new Map([['openai/model', summary]]));
  });

  it('builds a new map for a new snapshot after invalidation', async () => {
    const before = snapshot([row()]);
    const after = snapshot([
      row({
        openrouterId: 'anthropic/new-model',
        benchmarks: benchmarks({ avgAttemptCostUsd: 12.5 }),
      }),
    ]);
    mockSnapshot.mockResolvedValueOnce(before).mockResolvedValueOnce(after);

    const first = await getTerminalBenchSummaries();
    const second = await getTerminalBenchSummaries();

    expect(second).not.toBe(first);
    expect(first).toEqual(new Map([['openai/model', summary]]));
    expect(second).toEqual(
      new Map([
        ['anthropic/new-model', { overallScore: summary.overallScore, avgAttemptCostUsd: 12.5 }],
      ])
    );
  });

  it('resolves an empty map and warns once when the snapshot load rejects', async () => {
    mockSnapshot.mockRejectedValue(new Error('snapshot\n  unavailable'));

    await expect(getTerminalBenchSummaries()).resolves.toEqual(new Map());

    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      '[model-stats] terminal-bench summaries unavailable: snapshot unavailable; serving no benchmark summaries'
    );
  });

  it('reports a repeated failure once, not once per request', async () => {
    // The snapshot cache rethrows its recorded error during the retry cooldown, so every caller
    // sees the same error object; an outage must not log one line per catalog request.
    const outage = new Error('snapshot unavailable');
    mockSnapshot.mockRejectedValue(outage);

    await getTerminalBenchSummaries();
    await getTerminalBenchSummaries();
    await getTerminalBenchSummaries();

    expect(mockSnapshot).toHaveBeenCalledTimes(3);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it('reports each distinct failure', async () => {
    mockSnapshot
      .mockRejectedValueOnce(new Error('first outage'))
      .mockRejectedValueOnce(new Error('second outage'));

    await getTerminalBenchSummaries();
    await getTerminalBenchSummaries();

    expect(mockWarn).toHaveBeenCalledTimes(2);
  });

  it('reports the same error object again after a successful load', async () => {
    const outage = new Error('snapshot unavailable');
    mockSnapshot
      .mockRejectedValueOnce(outage)
      .mockResolvedValueOnce(snapshot([row()]))
      .mockRejectedValueOnce(outage);

    await getTerminalBenchSummaries();
    await getTerminalBenchSummaries();
    await getTerminalBenchSummaries();

    expect(mockSnapshot).toHaveBeenCalledTimes(3);
    expect(mockWarn).toHaveBeenCalledTimes(2);
  });
});

describe('terminalBenchFor', () => {
  it('matches only safe canonical IDs', () => {
    const summaries = new Map([['openai/model', summary]]);

    expect(terminalBenchFor(summaries, 'kilo/openai/model')).toEqual(summary);
    expect(terminalBenchFor(summaries, 'kilo/special-model')).toBeUndefined();
  });
});
