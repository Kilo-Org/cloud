import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';
import { resolveBotModelSlug } from './model';

describe('resolveBotModelSlug', () => {
  it('returns a trimmed configured bot model slug', () => {
    expect(resolveBotModelSlug({ metadata: { model_slug: '  z-ai/glm-5.2  ' } })).toBe(
      'z-ai/glm-5.2'
    );
  });

  it.each([
    { name: 'null integration', integration: null },
    { name: 'undefined integration', integration: undefined },
    { name: 'missing metadata', integration: { metadata: undefined } },
    { name: 'missing model slug', integration: { metadata: {} } },
    { name: 'empty model slug', integration: { metadata: { model_slug: '' } } },
    { name: 'whitespace model slug', integration: { metadata: { model_slug: '   ' } } },
    { name: 'non-string model slug', integration: { metadata: { model_slug: 42 } } },
    { name: 'non-object metadata', integration: { metadata: 'z-ai/glm-5.2' } },
  ])('falls back to the default bot model for $name', ({ integration }) => {
    expect(resolveBotModelSlug(integration)).toBe(DEFAULT_BOT_MODEL);
  });
});
