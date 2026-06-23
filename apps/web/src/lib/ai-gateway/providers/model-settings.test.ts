import { MINIMAX_CURRENT_MODEL_ID } from './minimax';
import { getModelVariants } from './model-settings';

describe('MiniMax model variants', () => {
  it.each([MINIMAX_CURRENT_MODEL_ID, 'opencode-go/minimax-m3'])(
    'exposes only adaptive thinking for MiniMax M3 model %s',
    model => {
      expect(getModelVariants(model)).toEqual({
        thinking: { reasoning: { enabled: true, effort: 'high' } },
      });
    }
  );

  it('keeps the reasoning toggle for older MiniMax models', () => {
    expect(getModelVariants('minimax/minimax-m2.7')).toEqual({
      instant: { reasoning: { enabled: false, effort: 'none' } },
      thinking: { reasoning: { enabled: true, effort: 'high' } },
    });
  });
});
