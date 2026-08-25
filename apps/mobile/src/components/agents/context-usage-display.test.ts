/* eslint-disable max-lines -- Migrated getHeaderSummary cases plus new no-info pill/a11y branches. */
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
  getHeaderPillContent,
  getIndeterminateArcFraction,
  getMetricsAccessibilityLabel,
  getRemainingTokens,
  type HeaderPillContent,
} from './context-usage-display';

function info(partial: Partial<SessionContextInfo> = {}): SessionContextInfo {
  return {
    contextTokens: 32_418,
    providerID: 'kilo',
    modelID: 'anthropic/claude-sonnet-4',
    contextWindow: 200_000,
    percentage: 16,
    ...partial,
  };
}

function pill(args: {
  info?: SessionContextInfo;
  totalCostMicrodollars: number | null;
  hasMessages: boolean;
}): HeaderPillContent {
  return getHeaderPillContent({
    info: args.info,
    totalCostMicrodollars: args.totalCostMicrodollars,
    hasMessages: args.hasMessages,
  });
}

const trackOnly: HeaderPillContent = {
  primary: null,
  secondary: null,
  hasCost: false,
  tone: 'neutral',
  arcFraction: 0,
  interactive: false,
};

describe('formatCompactTokens', () => {
  it('formats below one thousand, thousands, and millions', () => {
    expect(formatCompactTokens(0)).toBe('0');
    expect(formatCompactTokens(999)).toBe('999');
    expect(formatCompactTokens(1000)).toBe('1K');
    expect(formatCompactTokens(32_418)).toBe('32.4K');
    expect(formatCompactTokens(1500)).toBe('1.5K');
    expect(formatCompactTokens(995_000)).toBe('995K');
    expect(formatCompactTokens(1_200_000)).toBe('1.2M');
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
  it('maps known percentages and leaves unknown capacity indeterminate', () => {
    expect(getArcFraction(0)).toBe(0);
    expect(getArcFraction(50)).toBe(0.5);
    expect(getArcFraction(100)).toBe(1);
    expect(getArcFraction(125)).toBe(1);
    expect(getArcFraction(undefined)).toBeUndefined();
  });
});

describe('getIndeterminateArcFraction', () => {
  it('returns a stable non-empty neutral arc fraction', () => {
    const fraction = getIndeterminateArcFraction();
    expect(fraction).toBeGreaterThan(0);
    expect(fraction).toBeLessThan(1);
    expect(getIndeterminateArcFraction()).toBe(fraction);
  });
});

describe('getRemainingTokens', () => {
  it('reports remaining, zero-at-overflow, and undefined when capacity unknown', () => {
    expect(getRemainingTokens(info({ contextTokens: 32_418, contextWindow: 200_000 }))).toBe(
      167_582
    );
    expect(getRemainingTokens(info({ contextTokens: 200_000, contextWindow: 200_000 }))).toBe(0);
    expect(getRemainingTokens(info({ contextTokens: 250_000, contextWindow: 200_000 }))).toBe(0);
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

describe('getHeaderPillContent', () => {
  // Migrated getHeaderSummary cases (info-present) + new no-info branches.
  it('is track-only and non-interactive with no info and no transcript', () => {
    expect(pill({ totalCostMicrodollars: 80_000, hasMessages: false })).toEqual(trackOnly);
    expect(pill({ totalCostMicrodollars: 0, hasMessages: false })).toEqual(trackOnly);
    expect(pill({ totalCostMicrodollars: null, hasMessages: false })).toEqual(trackOnly);
  });

  it('shows percentage as primary and cost as secondary when capacity is known', () => {
    expect(
      pill({ info: info({ percentage: 42 }), totalCostMicrodollars: 80_000, hasMessages: true })
    ).toEqual({
      primary: '42%',
      secondary: '$0.08',
      hasCost: true,
      tone: 'primary',
      arcFraction: 0.42,
      interactive: true,
    });
  });

  it('omits secondary cost when cost is zero or null', () => {
    const base = {
      primary: '10%',
      secondary: null,
      hasCost: false,
      tone: 'primary' as const,
      arcFraction: 0.1,
      interactive: true,
    };
    expect(
      pill({ info: info({ percentage: 10 }), totalCostMicrodollars: 0, hasMessages: true })
    ).toEqual(base);
    expect(
      pill({ info: info({ percentage: 10 }), totalCostMicrodollars: null, hasMessages: true })
    ).toEqual(base);
  });

  it('uses warning tone at 75-89% with cost', () => {
    const result = pill({
      info: info({ percentage: 80 }),
      totalCostMicrodollars: 500_000,
      hasMessages: true,
    });
    expect(result.primary).toBe('80%');
    expect(result.tone).toBe('warning');
    expect(result.secondary).toBe('$0.50');
    expect(result.arcFraction).toBe(0.8);
    expect(result.interactive).toBe(true);
  });

  it('keeps overflow percentage visible with destructive tone and full arc', () => {
    const result = pill({
      info: info({ contextTokens: 250_000, contextWindow: 200_000, percentage: 125 }),
      totalCostMicrodollars: 1_000_000,
      hasMessages: true,
    });
    expect(result.primary).toBe('125%');
    expect(result.tone).toBe('destructive');
    expect(result.arcFraction).toBe(1);
    expect(result.interactive).toBe(true);
  });

  it('falls back to compact tokens and neutral tone when capacity is unknown', () => {
    expect(
      pill({
        info: info({ contextWindow: undefined, percentage: undefined, contextTokens: 32_418 }),
        totalCostMicrodollars: 120_000,
        hasMessages: true,
      })
    ).toEqual({
      primary: '32.4K',
      secondary: '$0.12',
      hasCost: true,
      tone: 'neutral',
      arcFraction: undefined,
      interactive: true,
    });
  });

  it('omits secondary cost when capacity is unknown and cost is zero', () => {
    expect(
      pill({
        info: info({ contextWindow: undefined, percentage: undefined, contextTokens: 32_418 }),
        totalCostMicrodollars: 0,
        hasMessages: true,
      })
    ).toEqual({
      primary: '32.4K',
      secondary: null,
      hasCost: false,
      tone: 'neutral',
      arcFraction: undefined,
      interactive: true,
    });
  });

  it('shows cost only, not interactive, arc 0 when transcript exists without context', () => {
    expect(pill({ totalCostMicrodollars: 80_000, hasMessages: true })).toEqual({
      primary: '$0.08',
      secondary: null,
      hasCost: true,
      tone: 'neutral',
      arcFraction: 0,
      interactive: false,
    });
  });

  it('shows no text when transcript exists without context or cost', () => {
    expect(pill({ totalCostMicrodollars: null, hasMessages: true })).toEqual(trackOnly);
    expect(pill({ totalCostMicrodollars: 0, hasMessages: true })).toEqual(trackOnly);
  });

  it('never surfaces a bare cost before a transcript exists', () => {
    expect(pill({ totalCostMicrodollars: 700, hasMessages: false })).toEqual(trackOnly);
  });
});

describe('getContextSheetContent', () => {
  it('describes exact usage and remaining when capacity is known', () => {
    const content = getContextSheetContent(
      info({ contextTokens: 84_000, contextWindow: 200_000, percentage: 42 }),
      80_000
    );
    expect(content.usedTokens).toBe('84,000');
    expect(content.windowTokens).toBe('200,000');
    expect(content.capacityKnown).toBe(true);
    expect(content.percentage).toBe('42%');
    expect(content.remainingTokens).toBe('116,000');
    expect(content.remainingPercentage).toBe('58%');
    expect(content.cost).toBe('$0.08');
    expect(content.tone).toBe('primary');
  });

  it('preserves overflow percentage and zero remaining', () => {
    const content = getContextSheetContent(
      info({ contextTokens: 250_000, contextWindow: 200_000, percentage: 125 }),
      0
    );
    expect(content.percentage).toBe('125%');
    expect(content.remainingTokens).toBe('0');
    expect(content.remainingPercentage).toBe('0%');
    expect(content.cost).toBeNull();
    expect(content.tone).toBe('destructive');
  });

  it('reports unavailable window copy when capacity is unknown', () => {
    const content = getContextSheetContent(
      info({ contextWindow: undefined, percentage: undefined, contextTokens: 32_418 }),
      0
    );
    expect(content.usedTokens).toBe('32,418');
    expect(content.windowTokens).toBeNull();
    expect(content.windowUnavailable).toBe(true);
    expect(content.percentage).toBeNull();
    expect(content.remainingTokens).toBeNull();
    expect(content.cost).toBeNull();
    expect(content.windowUnavailableLabel).toBe('Context-window size unavailable');
    expect(content.tone).toBe('neutral');
  });

  it('returns null cost when total cost is zero', () => {
    expect(getContextSheetContent(info({ percentage: 20 }), 0).cost).toBeNull();
  });
});

describe('getMetricsAccessibilityLabel', () => {
  it('includes usage, percentage, humanized cost, and tap intent when interactive', () => {
    const label = getMetricsAccessibilityLabel({
      info: info({ contextTokens: 84_000, contextWindow: 200_000, percentage: 42 }),
      totalCostMicrodollars: 80_000,
      interactive: true,
    });
    expect(label).toContain('84,000');
    expect(label).toContain('200,000');
    expect(label).toContain('42%');
    expect(label).not.toContain('%%');
    expect(label).toContain('8 cents');
    expect(label).not.toContain('$');
    expect(label.toLowerCase()).toContain('context details');
  });

  it('omits cost when none is available', () => {
    const label = getMetricsAccessibilityLabel({
      info: info({ contextTokens: 84_000, contextWindow: 200_000, percentage: 42 }),
      totalCostMicrodollars: 0,
      interactive: true,
    });
    expect(label).not.toContain('$');
    expect(label).not.toContain('cost');
  });

  it('uses unavailable-capacity copy without percentage when window unknown', () => {
    const label = getMetricsAccessibilityLabel({
      info: info({ contextWindow: undefined, percentage: undefined, contextTokens: 32_418 }),
      totalCostMicrodollars: 0,
      interactive: true,
    });
    expect(label).toContain('32,418');
    expect(label.toLowerCase()).toContain('unavailable');
    expect(label).not.toContain('%');
    expect(label).not.toContain('$');
  });

  it('includes humanized cost in the unknown-capacity case', () => {
    const label = getMetricsAccessibilityLabel({
      info: info({ contextWindow: undefined, percentage: undefined, contextTokens: 32_418 }),
      totalCostMicrodollars: 120_000,
      interactive: true,
    });
    expect(label).toContain('12 cents');
    expect(label).not.toContain('$');
  });

  it('preserves overflow percentage (125%)', () => {
    const label = getMetricsAccessibilityLabel({
      info: info({ contextTokens: 250_000, contextWindow: 200_000, percentage: 125 }),
      totalCostMicrodollars: 0,
      interactive: true,
    });
    expect(label).toContain('125%');
    expect(label).not.toContain('100%');
  });

  it('drops tap intent when not pressable and reads cost', () => {
    expect(
      getMetricsAccessibilityLabel({
        info: undefined,
        totalCostMicrodollars: 80_000,
        interactive: false,
      })
    ).toBe('cost 8 cents');
    expect(
      getMetricsAccessibilityLabel({
        info: undefined,
        totalCostMicrodollars: 120_000,
        interactive: false,
      })
    ).toBe('cost 12 cents');
  });

  it('reads empty when there is no info or cost', () => {
    expect(
      getMetricsAccessibilityLabel({
        info: undefined,
        totalCostMicrodollars: null,
        interactive: false,
      })
    ).toBe('');
  });

  it('does not speak a platform when info and cost are present', () => {
    const label = getMetricsAccessibilityLabel({
      info: info({ contextTokens: 84_000, contextWindow: 200_000, percentage: 42 }),
      totalCostMicrodollars: 80_000,
      interactive: true,
    });
    expect(label).not.toContain('CLI');
    expect(label.toLowerCase()).toContain('context details');
  });
});

describe('pure integration fallback', () => {
  it('keeps a fixed non-interactive pill when context usage is unresolved', () => {
    const result = pill({ totalCostMicrodollars: 80_000, hasMessages: true });
    expect(result.interactive).toBe(false);
    expect(result.arcFraction).toBe(0);
    expect(result.primary).toBe('$0.08');
  });
});
