import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';
import { resolveBotModelSettings, resolveBotModelSlug, resolveBotThinkingEffort } from './model';

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

describe('resolveBotModelSettings', () => {
  it('returns model slug and thinking effort together', () => {
    expect(
      resolveBotModelSettings({
        metadata: { model_slug: 'anthropic/claude-sonnet-4.5', thinking_effort: 'high' },
      })
    ).toEqual({ modelSlug: 'anthropic/claude-sonnet-4.5', thinkingEffort: 'high' });
  });

  it.each([
    { name: 'missing effort', metadata: { model_slug: 'a/b' } },
    { name: 'null effort', metadata: { model_slug: 'a/b', thinking_effort: null } },
    { name: 'empty effort', metadata: { model_slug: 'a/b', thinking_effort: '' } },
    { name: 'whitespace effort', metadata: { model_slug: 'a/b', thinking_effort: '   ' } },
    { name: 'invalid effort', metadata: { model_slug: 'a/b', thinking_effort: 'high!' } },
    { name: 'non-string effort', metadata: { model_slug: 'a/b', thinking_effort: 42 } },
  ])('falls back to null effort for $name', ({ metadata }) => {
    expect(resolveBotThinkingEffort({ metadata })).toBeNull();
  });

  it('keeps the model slug when the effort is invalid', () => {
    expect(
      resolveBotModelSettings({
        metadata: { model_slug: 'anthropic/claude-sonnet-4.5', thinking_effort: 'high!' },
      })
    ).toEqual({ modelSlug: 'anthropic/claude-sonnet-4.5', thinkingEffort: null });
  });

  it('rejects the whole config when the model slug is missing', () => {
    expect(resolveBotModelSettings({ metadata: { thinking_effort: 'high' } })).toEqual({
      modelSlug: DEFAULT_BOT_MODEL,
      thinkingEffort: null,
    });
  });
});
