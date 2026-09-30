import { describe, expect, it } from '@jest/globals';
import { FALLBACK_CURRENT_MODEL_IDS, resolveCurrentModelIds } from './current-models';

describe('resolveCurrentModelIds', () => {
  it('uses fallback ids when the catalog is empty', () => {
    expect(resolveCurrentModelIds({})).toEqual(FALLBACK_CURRENT_MODEL_IDS);
  });

  it('resolves a family to its latest alias target', () => {
    expect(
      resolveCurrentModelIds({
        '~anthropic/claude-opus-latest': { alias_target: { slug: 'anthropic/claude-opus-9' } },
        'anthropic/claude-opus-9': {},
      })
    ).toEqual({ ...FALLBACK_CURRENT_MODEL_IDS, claudeOpus: 'anthropic/claude-opus-9' });
  });

  it('keeps the fallback id when the alias target is missing from the catalog', () => {
    expect(
      resolveCurrentModelIds({
        '~z-ai/glm-flash-latest': { alias_target: { slug: 'z-ai/glm-9-flash' } },
      })
    ).toEqual(FALLBACK_CURRENT_MODEL_IDS);
  });
});
