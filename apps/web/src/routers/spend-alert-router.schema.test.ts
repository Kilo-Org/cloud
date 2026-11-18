import { describe, expect, it } from '@jest/globals';
import { MICRODOLLARS_PER_USD, MIN_THRESHOLD_USD } from '@/lib/spend-alerts/settings';
import { SpendAlertRuleInputSchema } from './spend-alert-router';

function thresholdRule(threshold: number | null | undefined) {
  return {
    kind: 'threshold' as const,
    enabled: true,
    threshold,
    windowHours: 24 as const,
    multiplierBasisPoints: null,
    emailEnabled: true,
    pushEnabled: false,
  };
}

describe('spendAlertRouter threshold lower bound', () => {
  it('accepts the smallest threshold that survives conversion to microdollars', () => {
    expect(SpendAlertRuleInputSchema.safeParse(thresholdRule(MIN_THRESHOLD_USD)).success).toBe(
      true
    );
    expect(Math.round(MIN_THRESHOLD_USD * MICRODOLLARS_PER_USD)).toBe(1);
  });

  it('rejects a positive threshold that would round to zero microdollars', () => {
    // A stored zero fires on any spend and its 95% hysteresis band is zero, so
    // the rule could never clear. The server must refuse it, not only the UIs.
    expect(SpendAlertRuleInputSchema.safeParse(thresholdRule(0.000_000_1)).success).toBe(false);
    expect(SpendAlertRuleInputSchema.safeParse(thresholdRule(0)).success).toBe(false);
    expect(SpendAlertRuleInputSchema.safeParse(thresholdRule(-1)).success).toBe(false);
  });

  it('still bounds the threshold above', () => {
    expect(SpendAlertRuleInputSchema.safeParse(thresholdRule(1_000_000)).success).toBe(true);
    expect(SpendAlertRuleInputSchema.safeParse(thresholdRule(1_000_001)).success).toBe(false);
  });
});
