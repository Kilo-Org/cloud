import { MINIMAX_CURRENT_MODEL_ID } from './minimax';
import { getModelVariants } from './model-settings';

describe('MiniMax model variants', () => {
  it.each([MINIMAX_CURRENT_MODEL_ID, 'opencode-go/minimax-m3'])(
    'defaults to thinking while exposing instant for MiniMax M3 model %s',
    model => {
      const variants = getModelVariants(model);

      expect(Object.keys(variants ?? {})).toEqual(['thinking', 'instant']);
      expect(variants).toEqual({
        thinking: { reasoning: { enabled: true, effort: 'high' } },
        instant: { reasoning: { enabled: false, effort: 'none' } },
      });
    }
  );

  it('keeps instant as the default for older MiniMax models', () => {
    const variants = getModelVariants('minimax/minimax-m2.7');

    expect(Object.keys(variants ?? {})).toEqual(['instant', 'thinking']);
    expect(variants).toEqual({
      instant: { reasoning: { enabled: false, effort: 'none' } },
      thinking: { reasoning: { enabled: true, effort: 'high' } },
    });
  });
});
