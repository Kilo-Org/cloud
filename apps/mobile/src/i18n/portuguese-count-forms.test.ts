import { type TFunction } from 'i18next';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import { CATALOG_LOADERS } from './catalogs';

/**
 * pt-BR and pt select their `one` category at a zero count under CLDR, so a
 * counted family without a `_zero` form renders the singular for "0 itens".
 * i18next looks up `<key>_zero` first at count 0, and Brazilian Portuguese
 * uses the plural for zero, so every counted family of both catalogs declares
 * `_zero` with the family's `_other` wording: the general plural, never the
 * million-scale `_many` form and never the singular `_one` form. The
 * organization member count the report named pins the visible case; the rest
 * of the class is read back out of each catalog, so a family that gains a
 * singular `_zero`, or loses the key, fails here.
 */

const t = i18n.t as TFunction;

const PORTUGUESE = ['pt-BR', 'pt'] as const;
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** Every plural family of one catalog, keyed by family name and then category. */
function pluralFamilies(
  value: unknown,
  prefix = '',
  found = new Map<string, Map<string, string>>()
): Map<string, Map<string, string>> {
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      pluralFamilies(child, path, found);
    } else {
      const match = PLURAL_SUFFIX.exec(path);
      const category = match?.[1];
      if (match && category && typeof child === 'string') {
        const family = path.slice(0, -match[0].length);
        const forms = found.get(family) ?? new Map<string, string>();
        forms.set(category, child);
        found.set(family, forms);
      }
    }
  }
  return found;
}

/** `t` with `returnDetails`, so a test can see which plural category resolved. */
function resolveKey(key: string, count: number) {
  return t(key, { count, displayCount: 'N', returnDetails: true }) as unknown as {
    res: string;
    exactUsedKey: string;
  };
}

// The catalog is loaded per language by the app's backend, so each test
// changes the language once rather than passing `lng` to every call.
beforeAll(async () => {
  await i18n.changeLanguage('pt-BR');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Portuguese organization group counts', () => {
  it('renders a zero member count with the plural', async () => {
    for (const tag of PORTUGUESE) {
      // One instance holds one language at a time, so the catalogs load in sequence.
      // eslint-disable-next-line no-await-in-loop
      await i18n.changeLanguage(tag);
      expect(i18n.t('organization.groups.memberCount', { count: 0, displayCount: '0' })).toBe(
        '0 membros'
      );
      expect(i18n.t('organization.groups.memberCount', { count: 1, displayCount: '1' })).toBe(
        '1 membro'
      );
      expect(i18n.t('organization.groups.memberCount', { count: 2, displayCount: '2' })).toBe(
        '2 membros'
      );
    }
  });
});

describe('every counted Portuguese family', () => {
  it('declares a zero form that i18next selects at a zero count', async () => {
    for (const tag of PORTUGUESE) {
      // eslint-disable-next-line no-await-in-loop
      await i18n.changeLanguage(tag);
      const families = pluralFamilies(CATALOG_LOADERS[tag]());
      const counted = [...families].filter(([, forms]) => forms.has('one'));
      // A non-trivial catalog, so the loop below cannot pass by finding nothing.
      expect(counted.length).toBeGreaterThan(10);
      for (const [family, forms] of counted) {
        if (!forms.has('zero')) {
          expect.fail(`${tag} declares no ${family}_zero`);
        }
        expect(resolveKey(family, 0).exactUsedKey, `${tag} ${family}`).toBe(`${family}_zero`);
      }
    }
  });

  it('reads a zero count as the plural, never as the singular', async () => {
    for (const tag of PORTUGUESE) {
      // eslint-disable-next-line no-await-in-loop
      await i18n.changeLanguage(tag);
      const families = pluralFamilies(CATALOG_LOADERS[tag]());
      for (const [family, forms] of families) {
        const one = forms.get('one');
        const other = forms.get('other');
        // Only a family whose singular reads differently can mistake zero for one.
        if (one !== undefined && other !== undefined && one !== other) {
          // The count itself interpolates into some families, so mask it before
          // comparing: the zero and the plural form differ by the number alone.
          expect(resolveKey(family, 0).res.replaceAll('0', 'N'), `${tag} ${family}`).toBe(
            resolveKey(family, 2).res.replaceAll('2', 'N')
          );
        }
      }
    }
  });
});
