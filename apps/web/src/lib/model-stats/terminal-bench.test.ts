import { describe, expect, it, jest } from '@jest/globals';
import {
  createTerminalBenchFetch,
  summarizeTerminalBench,
  terminalBenchFor,
  type TerminalBenchSummaries,
} from './terminal-bench';

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

function row(overrides: Partial<Parameters<typeof summarizeTerminalBench>[0][number]> = {}) {
  return {
    openrouterId: 'openai/model',
    isActive: true,
    isStealth: false,
    benchmarks: benchmarks(),
    ...overrides,
  };
}

describe('summarizeTerminalBench', () => {
  it('extracts publishable summaries keyed by OpenRouter ID', () => {
    expect(summarizeTerminalBench([row()])).toEqual(new Map([['openai/model', summary]]));
  });

  it.each([
    ['inactive', row({ isActive: false })],
    ['stealth', row({ isStealth: true })],
    ['fewer than five attempts', row({ benchmarks: benchmarks({ nAttempts: 4 }) })],
    ['null attempt cost', row({ benchmarks: benchmarks({ avgAttemptCostUsd: null }) })],
    ['missing eval', row({ benchmarks: { kiloBench: { overallScore: 0.4, evals: {} } } })],
    ['invalid benchmarks', row({ benchmarks: { kiloBench: { overallScore: 'invalid' } } })],
  ])('omits %s rows', (_name, input) => {
    expect(summarizeTerminalBench([input])).toEqual(new Map());
  });
});

describe('terminalBenchFor', () => {
  const summaries = new Map([['openai/model', summary]]);

  it('matches exact OpenRouter IDs', () => {
    expect(terminalBenchFor(summaries, 'openai/model')).toEqual(summary);
  });

  it('matches safely prefixed Kilo gateway IDs', () => {
    expect(terminalBenchFor(summaries, 'kilo/openai/model')).toEqual(summary);
  });

  it('does not strip ambiguous Kilo-owned IDs', () => {
    expect(terminalBenchFor(summaries, 'kilo/special-model')).toBeUndefined();
  });
});

describe('createTerminalBenchFetch', () => {
  it('falls back to an empty map when the first lookup fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const load = jest
      .fn<() => Promise<TerminalBenchSummaries>>()
      .mockRejectedValue(new Error('lookup failed'));
    const get = createTerminalBenchFetch(load);

    expect(await get()).toEqual(new Map());
    expect(console.error).toHaveBeenCalled();
  });

  it('falls back to the last-known-good map when refresh fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const good = new Map([['openai/model', summary]]);
    const load = jest
      .fn<() => Promise<TerminalBenchSummaries>>()
      .mockResolvedValueOnce(good)
      .mockRejectedValueOnce(new Error('lookup failed'));
    const get = createTerminalBenchFetch(load);

    expect(await get()).toBe(good);
    expect(await get()).toBe(good);
    expect(console.error).toHaveBeenCalled();
  });
});
