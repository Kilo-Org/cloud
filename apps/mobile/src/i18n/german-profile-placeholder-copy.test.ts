import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * German abbreviations keep a space after each dot. The new-profile name field
 * is the one placeholder a user reads before typing a name, and its example
 * abbreviation must match the rest of the catalog (`z. B. pnpm install`,
 * `z. B. 50`).
 */

beforeAll(async () => {
  await i18n.changeLanguage('de');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('German profile name placeholder', () => {
  it('writes the example abbreviation with the spaced form', () => {
    expect(i18n.t('profiles.namePlaceholder')).toBe('z. B. Backend-Debugging');
  });

  it('keeps no unspaced abbreviation in the profiles namespace', () => {
    const unspaced = Object.entries(i18n.getResourceBundle('de', 'translation').profiles)
      .flatMap(([key, value]) =>
        typeof value === 'string'
          ? [[key, value] as const]
          : Object.entries(value as Record<string, unknown>).map(
              ([child, childValue]) => [`${key}.${child}`, childValue] as const
            )
      )
      .filter(([, value]) => typeof value === 'string' && value.includes('z.B.'));

    expect(unspaced).toEqual([]);
  });
});
