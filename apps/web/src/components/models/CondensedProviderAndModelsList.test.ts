import { describe, expect, test } from '@jest/globals';
import { displayNamesBySlug } from '@/components/models/CondensedProviderAndModelsList';

describe('displayNamesBySlug', () => {
  test('keys a mixed-case catalog slug by its canonical form', () => {
    const names = displayNamesBySlug([{ slug: 'OpenAI', displayName: 'OpenAI' }]);

    expect(names.get('openai')).toBe('OpenAI');
  });

  test('keeps the first display name when two rows normalize to one slug', () => {
    const names = displayNamesBySlug([
      { slug: 'OpenAI', displayName: 'OpenAI' },
      { slug: 'openai', displayName: 'OpenAI Legacy' },
    ]);

    expect(names.size).toBe(1);
    expect(names.get('openai')).toBe('OpenAI');
  });
});
