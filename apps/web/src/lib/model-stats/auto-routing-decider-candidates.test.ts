import { describe, expect, it } from '@jest/globals';
import {
  AUTO_DECIDER_MAX_COST_USD,
  AUTO_DECIDER_MIN_COST_USD,
  summarizeAutoRoutingDeciderCandidates,
} from './auto-routing-decider-candidates';

function row(
  openrouterId: string,
  avgAttemptCostUsd: number,
  overrides: { active?: boolean } = {}
) {
  return {
    openrouterId,
    isActive: overrides.active ?? true,
    benchmarks: {
      kiloBench: {
        overallScore: 0.5,
        evals: {
          'terminal-bench': {
            taskSource: 'terminal-bench',
            overallScore: 0.5,
            totalScore: 3,
            avgCostUsd: 1,
            avgInputTokens: 1,
            avgOutputTokens: 1,
            avgCacheReadTokens: 1,
            avgExecutionMs: 1,
            nTotalTrials: 6,
            nAttempts: 6,
            avgAttemptCostUsd,
            avgAttemptInputTokens: 1,
            avgAttemptOutputTokens: 1,
            avgAttemptCacheReadTokens: 1,
            nErrored: 0,
            lastPromotedAt: '2026-06-01T00:00:00.000Z',
          },
        },
      },
    },
  };
}

describe('summarizeAutoRoutingDeciderCandidates', () => {
  it('keeps active terminal-bench models whose floored average attempt cost is in the auto range', () => {
    const candidates = summarizeAutoRoutingDeciderCandidates([
      row('model/too-cheap', AUTO_DECIDER_MIN_COST_USD - 0.01),
      row('model/minimum', AUTO_DECIDER_MIN_COST_USD),
      row('model/floored-maximum', AUTO_DECIDER_MAX_COST_USD + 0.99),
      row('model/too-expensive', AUTO_DECIDER_MAX_COST_USD + 1),
      row('model/inactive', 20, { active: false }),
      row('kilo-internal/custom', 20),
    ]);

    expect(candidates).toEqual([
      { id: 'model/floored-maximum', avgAttemptCostUsd: 25.99 },
      { id: 'model/minimum', avgAttemptCostUsd: 15 },
    ]);
  });
});
