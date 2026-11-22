import { describe, expect, test } from '@jest/globals';
import { providerDisplayNamesBySlug } from '@/components/models/CondensedProviderAndModelsList';

describe('providerDisplayNamesBySlug', () => {
  test('keys a mixed-case catalog slug by its canonical form', () => {
    const names = providerDisplayNamesBySlug([{ slug: 'OpenAI', displayName: 'OpenAI' }]);

    expect(names.get('openai')).toBe('OpenAI');
  });

  test('leaves one entry for rows that canonicalize to one slug', () => {
    const names = providerDisplayNamesBySlug([
      { slug: 'OpenAI', displayName: 'OpenAI' },
      { slug: 'openai', displayName: 'OpenAI' },
    ]);

    expect(names.size).toBe(1);
    expect(names.get('openai')).toBe('OpenAI');
  });
});
