import { getAvailableThinkingEfforts } from '@/lib/code-reviews/core/model-variants';

describe('getAvailableThinkingEfforts', () => {
  const modelSlug = 'anthropic/claude-sonnet-4.5';

  it('prefers variants discovered through the models endpoint', () => {
    expect(
      getAvailableThinkingEfforts(modelSlug, [{ id: modelSlug, variants: ['low', 'high'] }])
    ).toEqual(['low', 'high']);
  });

  it('respects an endpoint model with no variants', () => {
    expect(getAvailableThinkingEfforts(modelSlug, [{ id: modelSlug, variants: [] }])).toEqual([]);
  });

  it('falls back when the model was not discovered', () => {
    expect(getAvailableThinkingEfforts(modelSlug, [])).toEqual([
      'max',
      'xhigh',
      'high',
      'medium',
      'low',
      'none',
    ]);
  });
});
