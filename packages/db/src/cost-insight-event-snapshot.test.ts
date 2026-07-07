import { describe, expect, test } from '@jest/globals';

import { CostInsightEventSnapshotSchema } from './schema';

const validDriver = {
  spendCategory: 'variable',
  source: 'ai_gateway',
  productKey: 'direct-gateway',
  featureKey: 'chat_completions',
  modelOrPlanKey: 'anthropic/claude-sonnet-4',
  providerKey: 'anthropic',
  actorUserId: 'user-1',
  totalMicrodollars: 125,
  spendRecordCount: 1,
};

describe('CostInsightEventSnapshotSchema', () => {
  test('accepts empty and current alert snapshots', () => {
    expect(CostInsightEventSnapshotSchema.parse({})).toEqual({});
    expect(
      CostInsightEventSnapshotSchema.parse({
        thresholdMicrodollars: 1_000_000,
        thresholdWindow: 'rolling_7d',
        rolling7DayMicrodollars: 1_500_000,
        topDrivers: [validDriver],
        topDriversWindow: {
          startInclusive: '2026-06-01 00:00:00+00',
          endExclusive: '2026-06-08T00:00:00.000Z',
          spendCategory: 'variable',
        },
      })
    ).toMatchObject({ rolling7DayMicrodollars: 1_500_000 });
  });

  test('accepts config and suggestion snapshots', () => {
    expect(
      CostInsightEventSnapshotSchema.parse({
        changedFields: { spendAlertsEnabled: { old: false, new: true } },
        settings: {
          spendAlertsEnabled: true,
          anomalyAlertsEnabled: true,
          costSuggestionsEnabled: true,
          spendThresholdMicrodollars: null,
          spend7DayThresholdMicrodollars: 1,
          spend30DayThresholdMicrodollars: 2,
        },
        suggestion: {
          suggestionKey: 'a'.repeat(64),
          evidenceWindowStart: '2026-06-01T00:00:00.000Z',
          evidenceWindowEnd: '2026-06-02T00:00:00.000Z',
          observedMicrodollars: 1,
          ctaHref: '/pricing',
        },
      })
    ).toMatchObject({ settings: { spendAlertsEnabled: true } });
  });

  test('strips unknown fields while preserving known fields', () => {
    expect(
      CostInsightEventSnapshotSchema.parse({
        rolling24HourMicrodollars: 50,
        unknown: 'ignored',
        topDrivers: [{ ...validDriver, unknown: 'ignored' }],
      })
    ).toEqual({ rolling24HourMicrodollars: 50, topDrivers: [validDriver] });
  });

  test.each([null, [], 'snapshot'])('rejects non-object top-level value %#', value => {
    expect(() => CostInsightEventSnapshotSchema.parse(value)).toThrow();
  });

  test('rejects invalid enums, unsafe amounts, too many drivers, and reversed windows', () => {
    expect(() =>
      CostInsightEventSnapshotSchema.parse({ topDrivers: [{ ...validDriver, source: 'exa' }] })
    ).toThrow();
    expect(() =>
      CostInsightEventSnapshotSchema.parse({
        topDrivers: [{ ...validDriver, totalMicrodollars: -1 }],
      })
    ).toThrow();
    expect(() =>
      CostInsightEventSnapshotSchema.parse({
        topDrivers: Array.from({ length: 6 }, () => validDriver),
      })
    ).toThrow();
    expect(() =>
      CostInsightEventSnapshotSchema.parse({
        topDriversWindow: {
          startInclusive: '2026-06-02T00:00:00.000Z',
          endExclusive: '2026-06-01T00:00:00.000Z',
        },
      })
    ).toThrow();
  });
});
