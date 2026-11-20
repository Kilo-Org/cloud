import { describe, expect, it } from '@jest/globals';
import {
  BenchmarkSchedulerConfigResponseSchema,
  type BenchmarkSchedulerConfigResponse,
} from '@kilocode/auto-routing-contracts';
import { runBudgetLabel } from './BenchmarksSection';

/**
 * The spend-cap states the console must render. The card is a client component with
 * React Query, so its data contract is asserted through the schema and its pure
 * formatting through the exported label helper.
 */

const cap = (effective: number, source: 'admin' | 'env' | 'default', override: number | null) => ({
  effective,
  source,
  override,
  fallback: 50,
});

const response: BenchmarkSchedulerConfigResponse = {
  settings: {
    slots: { effective: 250, source: 'default', override: null, fallback: 250 },
    modelConcurrency: { effective: 12, source: 'default', override: null, fallback: 12 },
  },
  spendCaps: {
    perRunUsd: cap(50, 'default', null),
    perDayUsd: cap(150, 'env', null),
    perOwnerDayUsd: cap(25, 'admin', 40),
  },
  spendToday: { day: '2026-11-20', spentUsd: 149.5, perDayUsd: 150 },
  updatedAt: null,
  updatedBy: null,
};

describe('spend cap console state', () => {
  it('parses a worker that reports caps and today spend', () => {
    const parsed = BenchmarkSchedulerConfigResponseSchema.parse(response);
    expect(parsed.spendCaps?.perRunUsd.effective).toBe(50);
    expect(parsed.spendToday).toEqual({ day: '2026-11-20', spentUsd: 149.5, perDayUsd: 150 });
  });

  it('parses a worker that predates caps, so the card shows unknown rather than a zero cap', () => {
    const parsed = BenchmarkSchedulerConfigResponseSchema.parse({
      settings: response.settings,
      updatedAt: null,
      updatedBy: null,
    });
    expect(parsed.spendCaps).toBeUndefined();
    expect(parsed.spendToday).toBeUndefined();
  });

  it('rejects a non-positive cap, so an empty or zero field cannot read as unlimited', () => {
    expect(
      BenchmarkSchedulerConfigResponseSchema.safeParse({
        ...response,
        spendCaps: {
          ...response.spendCaps,
          perRunUsd: { ...cap(0, 'admin', 0), effective: 0 },
        },
      }).success
    ).toBe(false);
  });

  it('names the cap that paused a run, and nothing for a run within its cap', () => {
    expect(runBudgetLabel(undefined)).toBeNull();
    expect(runBudgetLabel({ state: 'within', capUsd: 50, forecastUsd: 20 })).toBeNull();
    expect(
      runBudgetLabel({ state: 'paused', capUsd: 50, scope: 'run', forecastUsd: 20 })
    ).toContain('per-run cap');
    expect(
      runBudgetLabel({ state: 'paused', capUsd: 150, scope: 'day', forecastUsd: null })
    ).toContain('daily cap');
    expect(
      runBudgetLabel({ state: 'paused', capUsd: 25, scope: 'owner_day', forecastUsd: null })
    ).toContain("owner's daily cap");
  });
});
