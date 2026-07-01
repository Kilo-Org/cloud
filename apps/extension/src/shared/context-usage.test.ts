import { describe, expect, it } from 'vitest';
import { formatContextSummary, getContextRatio, getContextTone } from './context-usage';

describe('context ratio', () => {
  it('returns undefined without a context length', () => {
    expect(getContextRatio(100, undefined as number | undefined)).toBeUndefined();
    expect(getContextRatio(100, 0)).toBeUndefined();
  });

  it('returns a clamped ratio', () => {
    expect(getContextRatio(50, 200)).toBeCloseTo(0.25);
    expect(getContextRatio(500, 200)).toBe(1);
  });
});

describe('context tone', () => {
  it('maps ratio to tone', () => {
    expect(getContextTone(0.5)).toBe('safe');
    expect(getContextTone(0.75)).toBe('warn');
    expect(getContextTone(0.95)).toBe('danger');
  });
});

describe('context summary formatting', () => {
  it('formats tokens and percent', () => {
    expect(formatContextSummary(1200, 200_000)).toBe('1,200 / 200,000 tokens (1%)');
  });

  it('omits percent without a context length', () => {
    expect(formatContextSummary(1200, undefined as number | undefined)).toBe('1,200 tokens');
  });

  it('caps the percent at 100% when tokens exceed the window', () => {
    expect(formatContextSummary(300_000, 200_000)).toBe('300,000 / 200,000 tokens (100%)');
  });
});
