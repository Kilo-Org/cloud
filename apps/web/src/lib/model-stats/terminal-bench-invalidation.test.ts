import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { db, cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import { modelStats } from '@kilocode/db/schema';
import type { ModelStats, ModelStatsBenchmarks } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import {
  getModelStatsSnapshot,
  invalidateModelStatsCache,
} from '@kilocode/web-shared/lib/model-stats/model-stats-cache';
import {
  getTerminalBenchSummaries,
  type TerminalBenchSummaries,
} from '@kilocode/web-shared/lib/model-stats/terminal-bench';
import { insertTestModelStats } from '@/tests/helpers/model-stats.helper';

/** The initial and updated attempt costs; any two distinct numbers pin the refresh. */
const INITIAL_COST_USD = 12.5;
const UPDATED_COST_USD = 34.75;

/** A `benchmarks` payload the terminal-bench summary accepts, with the given attempt cost. */
function terminalBenchBenchmarks(avgAttemptCostUsd: number): ModelStatsBenchmarks {
  return {
    kiloBench: {
      overallScore: 0.4,
      evals: {
        'terminal-bench': {
          taskSource: 'terminal-bench',
          overallScore: 0.551,
          totalScore: 2.755,
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
          lastPromotedAt: '2026-06-03T00:00:00.000Z',
        },
      },
    },
  };
}

describe('terminal-bench summaries share the model-stats cache', () => {
  let model: ModelStats;

  beforeAll(async () => {
    await cleanupDbForTest();
    // The snapshot cache lives for the worker process; start from a known generation so a
    // snapshot loaded before this row existed cannot mask the sequence below.
    invalidateModelStatsCache();
    model = await insertTestModelStats({
      benchmarks: terminalBenchBenchmarks(INITIAL_COST_USD),
    });
  });

  afterAll(async () => {
    if (model) await db.delete(modelStats).where(eq(modelStats.id, model.id));
    await cleanupDbForTest();
    invalidateModelStatsCache();
  });

  it('refreshes the terminal-bench view only when the model-stats cache is invalidated', async () => {
    const seeded: TerminalBenchSummaries = await getTerminalBenchSummaries();
    expect(seeded.get(model.openrouterId)?.avgAttemptCostUsd).toBe(INITIAL_COST_USD);

    await db
      .update(modelStats)
      .set({ benchmarks: terminalBenchBenchmarks(UPDATED_COST_USD) })
      .where(eq(modelStats.openrouterId, model.openrouterId));

    const stillCached: TerminalBenchSummaries = await getTerminalBenchSummaries();
    expect(stillCached.get(model.openrouterId)?.avgAttemptCostUsd).toBe(INITIAL_COST_USD);

    invalidateModelStatsCache();

    const refreshed: TerminalBenchSummaries = await getTerminalBenchSummaries();
    expect(refreshed.get(model.openrouterId)?.avgAttemptCostUsd).toBe(UPDATED_COST_USD);

    // The summaries and the snapshot are one cached read, so the refreshed generation must
    // serve the updated benchmarks to both.
    const snapshot = await getModelStatsSnapshot();
    const entry = snapshot.entries.find(({ stat }) => stat.openrouterId === model.openrouterId);
    expect(entry).toBeDefined();
    expect(entry?.stat.benchmarks?.kiloBench?.evals['terminal-bench']?.avgAttemptCostUsd).toBe(
      UPDATED_COST_USD
    );
  });
});
