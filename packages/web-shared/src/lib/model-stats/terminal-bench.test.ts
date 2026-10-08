import { describe, expect, it } from '@jest/globals';
import {
  summarizeTerminalBench,
  summarizeTerminalBenchLatest,
  terminalBenchFor,
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

describe('summarizeTerminalBenchLatest', () => {
  it('populates terminalBenchLatest from the highest eligible Hub revision', () => {
    const legacy = benchmarks().kiloBench.evals['terminal-bench'];
    const revisioned = (revision: string, overallScore: number, nAttempts = 5) => ({
      ...legacy,
      taskSource: `terminal-bench/terminal-bench@${revision}`,
      datasetName: 'terminal-bench/terminal-bench',
      benchmarkRelease: `${revision}.0.0`,
      benchmarkRevision: revision,
      scope: 'cpu-only',
      overallScore,
      nAttempts,
    });
    const summaries = summarizeTerminalBenchLatest([
      row({
        benchmarks: {
          kiloBench: {
            overallScore: 0.4,
            evals: {
              'terminal-bench': legacy,
              'terminal-bench/terminal-bench@3': revisioned('3', 0.3),
              'terminal-bench/terminal-bench@4': revisioned('4', 0.6),
              'terminal-bench/terminal-bench@5': revisioned('5', 0.9, 4),
            },
          },
        },
      }),
      row({ openrouterId: 'legacy/model' }),
    ]);

    expect(summaries).toEqual(
      new Map([
        [
          'openai/model',
          {
            overallScore: 0.6,
            avgAttemptCostUsd: summary.avgAttemptCostUsd,
            release: '4.0.0',
            revision: '4',
            scope: 'cpu-only',
          },
        ],
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
