import { describe, expect, it } from '@jest/globals';
import { toEligibleModelOptions } from './eligible-model-options';

describe('toEligibleModelOptions', () => {
  it('excludes kilo-auto, custom LLM, and direct-BYOK-only models', () => {
    const options = toEligibleModelOptions([
      { id: 'kilo-auto/efficient', name: 'Efficient' },
      { id: 'acme/custom', name: 'Custom', isCustomLlm: true },
      { id: 'chutes-byok/direct-only', name: 'Direct BYOK', hasUserByokAvailable: true },
      {
        id: 'anthropic/claude-sonnet-4',
        name: 'Sonnet',
        hasUserByokAvailable: true,
        opencode: { variants: { high: {}, low: {} } },
      },
      { id: 'google/gemini-2.5-flash', name: 'Flash' },
    ]);

    expect(options.map(option => option.id)).toEqual([
      'anthropic/claude-sonnet-4',
      'google/gemini-2.5-flash',
    ]);
    expect(options[0]?.variants).toEqual(['high', 'low']);
    expect(options[1]?.variants).toBeUndefined();
  });
});
