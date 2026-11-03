import { describe, expect, it } from 'vitest';

import { resolveFontScaleCap } from './text-scale-cap';

describe('resolveFontScaleCap', () => {
  it('tracks the live scale when the caller sets no cap', () => {
    expect(resolveFontScaleCap(1)).toBe(1);
    expect(resolveFontScaleCap(1.3)).toBe(1.3);
    expect(resolveFontScaleCap(2)).toBe(2);
  });

  it('keeps a caller cap that is below the live scale', () => {
    expect(resolveFontScaleCap(1.3, 1)).toBe(1);
    expect(resolveFontScaleCap(2, 1.5)).toBe(1.5);
  });

  it('tracks the live scale while it stays below the caller cap', () => {
    // The cap is not reached, so the node must follow the scale: the value has
    // to change with it for the native text to re-measure.
    expect(resolveFontScaleCap(1.1, 1.5)).toBe(1.1);
    expect(resolveFontScaleCap(1.4, 1.5)).toBe(1.4);
  });

  it('reports no cap for a scale below 1, which RN cannot express as a multiplier', () => {
    expect(resolveFontScaleCap(0.85)).toBe(0);
    expect(resolveFontScaleCap(0.85, 1.5)).toBe(0);
  });

  it('leaves a node alone without a usable scale', () => {
    expect(resolveFontScaleCap(null)).toBeUndefined();
    expect(resolveFontScaleCap(Number.NaN)).toBeUndefined();
    expect(resolveFontScaleCap(0)).toBeUndefined();
    expect(resolveFontScaleCap(-1)).toBeUndefined();
  });

  it('ignores a caller multiplier that RN would reject or read as no cap', () => {
    expect(resolveFontScaleCap(1.3, Number.NaN)).toBe(1.3);
    expect(resolveFontScaleCap(1.3, 0)).toBe(1.3);
    expect(resolveFontScaleCap(1.3, 0.5)).toBe(1.3);
  });
});
