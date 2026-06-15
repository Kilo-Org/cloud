import { describe, expect, it } from '@jest/globals';
import { summarizeTerminalBench, terminalBenchFor } from './terminal-bench';

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
    benchmarks: benchmarks(),
    ...overrides,
  };
}

describe('summarizeTerminalBench', () => {
  it('publishes only eligible non-internal summaries', () => {
    const stealth = { ...row({ openrouterId: 'stealth/model' }), isStealth: true };
    const nullable = {
      ...benchmarks(),
      artificialAnalysis: { liveCodeBench: null },
    };
    const summaries = summarizeTerminalBench([
      row(),
      stealth,
      row({ openrouterId: 'nullable/model', benchmarks: nullable }),
      row({ openrouterId: 'kilo-internal/custom', benchmarks: benchmarks() }),
      row({ isActive: false }),
      row({ benchmarks: benchmarks({ nAttempts: 4 }) }),
      row({ benchmarks: benchmarks({ avgAttemptCostUsd: null }) }),
      row({ benchmarks: { kiloBench: { overallScore: 0.4, evals: {} } } }),
      row({ benchmarks: { kiloBench: { overallScore: 'invalid' } } }),
    ]);

    expect(summaries).toEqual(
      new Map([
        ['openai/model', summary],
        ['stealth/model', summary],
        ['nullable/model', summary],
      ])
    );
  });
});

describe('terminalBenchFor', () => {
  it('matches only safe canonical IDs', () => {
    const summaries = new Map([['openai/model', summary]]);

    expect(terminalBenchFor(summaries, 'kilo/openai/model')).toEqual(summary);
    expect(terminalBenchFor(summaries, 'kilo/special-model')).toBeUndefined();
  });
});
