import { describe, expect, it } from '@jest/globals';
import { orderOpenCodeSettings, orderOpenCodeVariants } from './order-opencode-variants';

const variant = { reasoning: { enabled: true } };

describe('orderOpenCodeVariants', () => {
  it('orders reasoning effort variants from most to least intensive', () => {
    const variants = {
      max: variant,
      medium: variant,
      none: variant,
      xhigh: variant,
      low: variant,
      high: variant,
      minimal: variant,
    };

    expect(Object.keys(orderOpenCodeVariants(variants))).toEqual([
      'max',
      'xhigh',
      'high',
      'medium',
      'low',
      'minimal',
      'none',
    ]);
    expect(Object.keys(variants)).toEqual([
      'max',
      'medium',
      'none',
      'xhigh',
      'low',
      'high',
      'minimal',
    ]);
  });

  it('orders binary reasoning variants with instant first', () => {
    expect(Object.keys(orderOpenCodeVariants({ thinking: variant, instant: variant }))).toEqual([
      'instant',
      'thinking',
    ]);
  });

  it('orders instant and effort variants consistently with fallback variants', () => {
    expect(
      Object.keys(
        orderOpenCodeVariants({ high: variant, medium: variant, instant: variant, low: variant })
      )
    ).toEqual(['instant', 'high', 'medium', 'low']);
  });

  it('orders arbitrary and mixed variant names alphabetically', () => {
    expect(
      Object.keys(orderOpenCodeVariants({ turbo: variant, medium: variant, balanced: variant }))
    ).toEqual(['balanced', 'medium', 'turbo']);
  });
});

describe('orderOpenCodeSettings', () => {
  it('preserves settings while ordering variants', () => {
    const settings = {
      ai_sdk_provider: 'anthropic',
      variants: { high: variant, low: variant },
    } as const;

    expect(orderOpenCodeSettings(settings)).toEqual({
      ai_sdk_provider: 'anthropic',
      variants: { high: variant, low: variant },
    });
  });

  it('returns settings without variants unchanged', () => {
    const settings = { ai_sdk_provider: 'openai' } as const;

    expect(orderOpenCodeSettings(settings)).toBe(settings);
    expect(orderOpenCodeSettings(undefined)).toBeUndefined();
  });
});
