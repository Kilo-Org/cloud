import { describe, expect, it } from 'vitest';

import {
  catalogVariantEfforts,
  effortOfVariant,
  THINKING_SWITCH_VARIANTS,
  variantOfEffort,
} from './effort';

describe('the effort a picked variant asks for', () => {
  it('reads the effort the catalog gives a variant, whatever the variant is called', () => {
    const efforts = catalogVariantEfforts({
      instant: { reasoning: { enabled: false, effort: 'none' } },
      thinking: { reasoning: { enabled: true, effort: 'high' } },
      curated: { temperature: 0.2 },
    });
    const choices = { variants: ['instant', 'thinking', 'curated'], efforts };

    expect(effortOfVariant(choices, 'instant')).toBe('none');
    expect(effortOfVariant(choices, 'thinking')).toBe('high');
    expect(effortOfVariant(choices, 'curated')).toBeNull();
  });

  it('takes a variant named for an effort as that effort', () => {
    const choices = { variants: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] };

    expect(choices.variants.map(variant => effortOfVariant(choices, variant))).toEqual(
      choices.variants
    );
  });

  it('maps the thinking switch of a downloaded model to off and on', () => {
    const choices = { variants: [...THINKING_SWITCH_VARIANTS] };

    expect(effortOfVariant(choices, 'off')).toBe('none');
    expect(effortOfVariant(choices, 'on')).not.toBe('none');
  });

  it('sends no effort to a model that offers no such variant', () => {
    expect(effortOfVariant({ variants: [] }, 'high')).toBeNull();
    expect(effortOfVariant({ variants: ['low'] }, 'high')).toBeNull();
    expect(effortOfVariant({ variants: ['low'] }, '')).toBeNull();
  });
});

describe('the variant a chat shows for its effort', () => {
  it('shows the variant that asks for the stored effort', () => {
    const choices = {
      variants: ['instant', 'thinking'],
      efforts: { instant: 'none', thinking: 'high' } as const,
    };

    expect(variantOfEffort(choices, 'high')).toBe('thinking');
    expect(variantOfEffort(choices, 'none')).toBe('instant');
  });

  it('shows no variant for the model default or an effort the model does not offer', () => {
    expect(variantOfEffort({ variants: ['low', 'high'] }, null)).toBe('');
    expect(variantOfEffort({ variants: ['low', 'high'] }, 'max')).toBe('');
  });
});
