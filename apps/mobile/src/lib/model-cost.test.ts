import { describe, expect, it } from 'vitest';
import { formatModelCostPer1M, modelPickerCostLabel } from './model-cost';

describe('formatModelCostPer1M', () => {
  it('returns null for undefined pricing', () => {
    expect(formatModelCostPer1M(undefined)).toBeNull();
  });

  it('returns null when one side is missing', () => {
    expect(formatModelCostPer1M({ prompt: '0.00000175' })).toBeNull();
    expect(formatModelCostPer1M({ completion: '0.000014' })).toBeNull();
  });

  it('returns null when one side is zero', () => {
    expect(formatModelCostPer1M({ prompt: '0.00000175', completion: '0.0000000' })).toBeNull();
    expect(formatModelCostPer1M({ prompt: '0.0000000', completion: '0.000014' })).toBeNull();
  });

  it('returns null when one side is negative', () => {
    expect(formatModelCostPer1M({ prompt: '-0.00000175', completion: '0.000014' })).toBeNull();
    expect(formatModelCostPer1M({ prompt: '0.00000175', completion: '-0.000014' })).toBeNull();
  });

  it('returns null for NaN or garbage strings', () => {
    expect(formatModelCostPer1M({ prompt: 'not-a-number', completion: '0.000014' })).toBeNull();
    expect(formatModelCostPer1M({ prompt: '0.00000175', completion: '' })).toBeNull();
    expect(formatModelCostPer1M({ prompt: '', completion: '0.000014' })).toBeNull();
  });

  it('renders $120-class with trailing zeros stripped', () => {
    expect(formatModelCostPer1M({ prompt: '0.00012', completion: '0.000014' })).toBe(
      'In $120 · Out $14 per 1M tokens'
    );
  });

  it('renders $3 with trailing zeros stripped', () => {
    expect(formatModelCostPer1M({ prompt: '0.000003', completion: '0.000014' })).toBe(
      'In $3 · Out $14 per 1M tokens'
    );
  });

  it('renders $1.75 and $1.5 with proper trim rules', () => {
    expect(formatModelCostPer1M({ prompt: '0.00000175', completion: '0.0000015' })).toBe(
      'In $1.75 · Out $1.5 per 1M tokens'
    );
  });

  it('renders $0.15', () => {
    expect(formatModelCostPer1M({ prompt: '0.00000015', completion: '0.000014' })).toBe(
      'In $0.15 · Out $14 per 1M tokens'
    );
  });

  it('renders $0.03', () => {
    expect(formatModelCostPer1M({ prompt: '0.00000003', completion: '0.000014' })).toBe(
      'In $0.03 · Out $14 per 1M tokens'
    );
  });

  it('renders <$0.01 for sub-cent (but positive) prices', () => {
    expect(formatModelCostPer1M({ prompt: '0.000000009', completion: '0.000014' })).toBe(
      'In <$0.01 · Out $14 per 1M tokens'
    );
    expect(formatModelCostPer1M({ prompt: '0.00000175', completion: '0.000000009' })).toBe(
      'In $1.75 · Out <$0.01 per 1M tokens'
    );
  });

  it('renders asymmetric pairs with one side sub-cent', () => {
    expect(formatModelCostPer1M({ prompt: '0.000000005', completion: '0.00003' })).toBe(
      'In <$0.01 · Out $30 per 1M tokens'
    );
  });
});

describe('modelPickerCostLabel', () => {
  it('returns null when hasUserByokAvailable is true even with non-zero pricing', () => {
    expect(
      modelPickerCostLabel({
        hasUserByokAvailable: true,
        pricing: { prompt: '0.00000175', completion: '0.000014' },
      })
    ).toBeNull();
  });

  it('returns null when isFree is true even with non-zero pricing', () => {
    expect(
      modelPickerCostLabel({
        isFree: true,
        pricing: { prompt: '0.00000175', completion: '0.000014' },
      })
    ).toBeNull();
  });

  it('returns formatted label for plain non-zero pricing', () => {
    expect(
      modelPickerCostLabel({
        pricing: { prompt: '0.00000175', completion: '0.000014' },
      })
    ).toBe('In $1.75 · Out $14 per 1M tokens');
  });

  it('returns null for undefined pricing on non-free, non-BYOK option', () => {
    expect(modelPickerCostLabel({})).toBeNull();
  });
});
