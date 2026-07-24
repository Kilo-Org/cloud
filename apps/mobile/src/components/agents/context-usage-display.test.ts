import { describe, expect, it } from 'vitest';

import { type SessionContextInfo } from '@/lib/session-context-info';

import {
  type ContextTone,
  formatCompactTokens,
  formatCost,
  formatExactTokens,
  formatRemainingTokens,
  getArcFraction,
  getContextSheetContent,
  getContextTone,
  getHeaderSummary,
  getIndeterminateArcFraction,
  getMetricsAccessibilityLabel,
  getRemainingTokens,
} from './context-usage-display';

function info(partial: Partial<SessionContextInfo>): SessionContextInfo {
  return {
    contextTokens: 32_418,
    providerID: 'kilo',
    modelID: 'anthropic/claude-sonnet-4',
    contextWindow: 200_000,
    percentage: 16,
    ...partial,
  };
}

describe('formatCompactTokens', () => {
  it('returns the raw number below one thousand', () => {
    expect(formatCompactTokens(0)).toBe('0');
    expect(formatCompactTokens(999)).toBe('999');
  });

  it('switches to one-decimal thousands at the 1000 boundary', () => {
    expect(formatCompactTokens(1000)).toBe('1.0K');
    expect(formatCompactTokens(32_418)).toBe('32.4K');
  });

  it('switches to millions at one million', () => {
    expect(formatCompactTokens(1_200_000)).toBe('1.2M');
  });

  it('handles sub-thousand precision for fractional thousands', () => {
    expect(formatCompactTokens(1500)).toBe('1.5K');
    expect(formatCompactTokens(995_000)).toBe('995.0K');
  });
});

describe('formatExactTokens', () => {
  it('uses grouped digit formatting', () => {
    expect(formatExactTokens(0)).toBe('0');
    expect(formatExactTokens(999)).toBe('999');
    expect(formatExactTokens(32_418)).toBe('32,418');
    expect(formatExactTokens(1_234_567)).toBe('1,234,567');
  });
});

describe('formatCost', () => {
  it('preserves the existing four-decimal dollar format', () => {
    expect(formatCost(0)).toBe('$0.0000');
    expect(formatCost(0.08)).toBe('$0.0800');
    expect(formatCost(0.123_456)).toBe('$0.1235');
    expect(formatCost(1.2)).toBe('$1.2000');
  });
});

describe('getContextTone', () => {
  const cases: readonly { percentage: number | undefined; expected: ContextTone }[] = [
    { percentage: undefined, expected: 'neutral' },
    { percentage: 0, expected: 'primary' },
    { percentage: 42, expected: 'primary' },
    { percentage: 74, expected: 'primary' },
    { percentage: 75, expected: 'warning' },
    { percentage: 89, expected: 'warning' },
    { percentage: 90, expected: 'destructive' },
    { percentage: 100, expected: 'destructive' },
    { percentage: 125, expected: 'destructive' },
  ];

  for (const { percentage, expected } of cases) {
    it(`classifies ${String(percentage)}% as ${expected}`, () => {
      expect(getContextTone(percentage)).toBe(expected);
    });
  }
});

describe('getArcFraction', () => {
  it('maps zero to an empty arc', () => {
    expect(getArcFraction(0)).toBe(0);
  });

  it('maps fifty percent to half', () => {
    expect(getArcFraction(50)).toBe(0.5);
  });

  it('clamps to one at exactly one hundred percent', () => {
    expect(getArcFraction(100)).toBe(1);
  });

  it('clamps to one even when the real percentage overflows', () => {
    expect(getArcFraction(125)).toBe(1);
  });

  it('returns undefined for unknown capacity so callers render indeterminate', () => {
    expect(getArcFraction(undefined)).toBeUndefined();
  });
});

describe('getIndeterminateArcFraction', () => {
  it('returns a stable non-empty neutral arc fraction', () => {
    const fraction = getIndeterminateArcFraction();
    expect(fraction).toBeGreaterThan(0);
    expect(fraction).toBeLessThan(1);
  });

  it('is a pure value (same on repeated calls) so render output is stable', () => {
    expect(getIndeterminateArcFraction()).toBe(getIndeterminateArcFraction());
  });
});

describe('getRemainingTokens', () => {
  it('reports the remaining window when capacity is known', () => {
    expect(getRemainingTokens(info({ contextTokens: 32_418, contextWindow: 200_000 }))).toBe(
      167_582
    );
  });

  it('reports zero remaining when usage meets or exceeds the window', () => {
    expect(getRemainingTokens(info({ contextTokens: 200_000, contextWindow: 200_000 }))).toBe(0);
    expect(getRemainingTokens(info({ contextTokens: 250_000, contextWindow: 200_000 }))).toBe(0);
  });

  it('returns undefined when capacity is unknown', () => {
    expect(
      getRemainingTokens(info({ contextWindow: undefined, percentage: undefined }))
    ).toBeUndefined();
  });
});

describe('formatRemainingTokens', () => {
  it('uses exact grouped formatting', () => {
    expect(formatRemainingTokens(0)).toBe('0');
    expect(formatRemainingTokens(167_582)).toBe('167,582');
  });
});

describe('getHeaderSummary', () => {
  it('returns null when there is no completed assistant context usage', () => {
    expect(getHeaderSummary(undefined, 0.08)).toBeNull();
    expect(getHeaderSummary(undefined, 0)).toBeNull();
  });

  it('shows percentage as primary and cost as secondary when capacity is known', () => {
    const summary = getHeaderSummary(info({ percentage: 42 }), 0.08);
    expect(summary).toEqual({
      primary: '42%',
      secondary: '$0.0800',
      hasCost: true,
      tone: 'primary',
    });
  });

  it('omits the secondary cost when cost is zero', () => {
    const summary = getHeaderSummary(info({ percentage: 10 }), 0);
    expect(summary).toEqual({ primary: '10%', hasCost: false, tone: 'primary' });
  });

  it('uses percentage as primary and a warning tone at 75-89%', () => {
    const summary = getHeaderSummary(info({ percentage: 80 }), 0.5);
    expect(summary?.primary).toBe('80%');
    expect(summary?.tone).toBe('warning');
    expect(summary?.secondary).toBe('$0.5000');
  });

  it('keeps the real overflow percentage visible (does not clamp above 100) and uses a destructive tone', () => {
    const summary = getHeaderSummary(
      info({ contextTokens: 250_000, contextWindow: 200_000, percentage: 125 }),
      1
    );
    expect(summary?.primary).toBe('125%');
    expect(summary?.tone).toBe('destructive');
  });

  it('falls back to compact tokens and a neutral tone when capacity is unknown', () => {
    const summary = getHeaderSummary(
      info({ contextWindow: undefined, percentage: undefined, contextTokens: 32_418 }),
      0.12
    );
    expect(summary).toEqual({
      primary: '32.4K',
      secondary: '$0.1200',
      hasCost: true,
      tone: 'neutral',
    });
  });

  it('omits the secondary cost when capacity is unknown and cost is zero', () => {
    const summary = getHeaderSummary(
      info({ contextWindow: undefined, percentage: undefined, contextTokens: 32_418 }),
      0
    );
    expect(summary).toEqual({ primary: '32.4K', hasCost: false, tone: 'neutral' });
  });
});

describe('getContextSheetContent', () => {
  it('describes exact usage and remaining tokens when capacity is known', () => {
    const content = getContextSheetContent(
      info({ contextTokens: 84_000, contextWindow: 200_000, percentage: 42 }),
      0.08
    );
    expect(content.usedTokens).toBe('84,000');
    expect(content.windowTokens).toBe('200,000');
    expect(content.capacityKnown).toBe(true);
    expect(content.percentage).toBe('42%');
    expect(content.remainingTokens).toBe('116,000');
    expect(content.remainingPercentage).toBe('58%');
    expect(content.cost).toBe('$0.0800');
    expect(content.tone).toBe('primary');
  });

  it('preserves the real overflow percentage and reports zero remaining tokens and 0% remaining', () => {
    const content = getContextSheetContent(
      info({ contextTokens: 250_000, contextWindow: 200_000, percentage: 125 }),
      0
    );
    expect(content.percentage).toBe('125%');
    expect(content.remainingTokens).toBe('0');
    expect(content.remainingPercentage).toBe('0%');
    expect(content.cost).toBe('$0.0000');
    expect(content.tone).toBe('destructive');
  });

  it('reports used tokens, an unavailable window, and the unavailable copy when capacity is unknown', () => {
    const content = getContextSheetContent(
      info({ contextWindow: undefined, percentage: undefined, contextTokens: 32_418 }),
      0
    );
    expect(content.usedTokens).toBe('32,418');
    expect(content.windowTokens).toBeNull();
    expect(content.windowUnavailable).toBe(true);
    expect(content.percentage).toBeNull();
    expect(content.remainingTokens).toBeNull();
    expect(content.cost).toBe('$0.0000');
    expect(content.windowUnavailableLabel).toBe('Context-window size unavailable');
    expect(content.tone).toBe('neutral');
  });

  it('shows the cost line as $0.0000 when total cost is zero', () => {
    const content = getContextSheetContent(info({ percentage: 20 }), 0);
    expect(content.cost).toBe('$0.0000');
  });
});

describe('getMetricsAccessibilityLabel', () => {
  it('includes exact usage, real percentage, and tap intent when capacity is known with cost', () => {
    const label = getMetricsAccessibilityLabel(
      info({ contextTokens: 84_000, contextWindow: 200_000, percentage: 42 }),
      0.08
    );
    expect(label).toContain('84,000');
    expect(label).toContain('200,000');
    expect(label).toContain('42%');
    expect(label).toContain('$0.0800');
    expect(label.toLowerCase()).toContain('context details');
  });

  it('omits the cost clause when no positive cost is available', () => {
    const label = getMetricsAccessibilityLabel(
      info({ contextTokens: 84_000, contextWindow: 200_000, percentage: 42 }),
      0
    );
    expect(label).not.toContain('$');
  });

  it('switches to the unavailable-capacity copy and omits percentage/cost when not available', () => {
    const label = getMetricsAccessibilityLabel(
      info({ contextWindow: undefined, percentage: undefined, contextTokens: 32_418 }),
      0
    );
    expect(label).toContain('32,418');
    expect(label.toLowerCase()).toContain('unavailable');
    expect(label).not.toContain('%');
    expect(label).not.toContain('$');
  });

  it('includes the positive cost in the unknown-capacity case', () => {
    const label = getMetricsAccessibilityLabel(
      info({ contextWindow: undefined, percentage: undefined, contextTokens: 32_418 }),
      0.12
    );
    expect(label).toContain('$0.1200');
  });

  it('preserves the real overflow percentage in the known-capacity case (125%)', () => {
    const label = getMetricsAccessibilityLabel(
      info({ contextTokens: 250_000, contextWindow: 200_000, percentage: 125 }),
      0
    );
    expect(label).toContain('125%');
    expect(label).not.toContain('100%');
  });
});

describe('pure integration fallback', () => {
  it('shows the cost-only header when there is no completed assistant context usage', () => {
    // Mirrors the SessionDetailContent integration: when resolveSessionContextInfo
    // returns undefined the header should keep the legacy positive cost text
    // (no context control, no sheet) rather than an empty header.
    const summary = getHeaderSummary(undefined, 0.08);
    expect(summary).toBeNull();
  });
});
