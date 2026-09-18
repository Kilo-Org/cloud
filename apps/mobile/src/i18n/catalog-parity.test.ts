import { describe, expect, it } from 'vitest';

import { CATALOG_LOADERS } from './catalogs';
import { SUPPORTED_LANGUAGES } from './languages';
import en from './locales/en.json';

type Catalog = Record<string, unknown>;

function flatten(
  value: Catalog,
  prefix = '',
  out = new Map<string, string>()
): Map<string, string> {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      flatten(child as Catalog, path, out);
    } else {
      out.set(path, String(child));
    }
  }
  return out;
}

const PLURAL_SUFFIX = /_(?:zero|one|two|few|many|other)$/;
const pluralBase = (key: string) =>
  PLURAL_SUFFIX.test(key) ? key.replace(PLURAL_SUFFIX, '') : null;

const english = flatten(en as unknown as Catalog);
const englishFamilies = new Set(
  [...english.keys()].map(key => pluralBase(key)).filter((base): base is string => base !== null)
);

/**
 * A key that leaves en.json is dead copy: it never renders, and
 * `tools/i18n/check-catalogs.mjs` (run by `check:i18n`) fails the build until it
 * is gone. Plural categories the language needs are the only allowed extra.
 */
describe('catalog parity', () => {
  it.each(SUPPORTED_LANGUAGES.filter(tag => tag !== 'en'))(
    '%s has no key that en.json does not define',
    tag => {
      const catalog = flatten(CATALOG_LOADERS[tag]() as unknown as Catalog);
      const extra = [...catalog.keys()].filter(key => {
        if (english.has(key)) {
          return false;
        }
        const base = pluralBase(key);
        return !(base !== null && englishFamilies.has(base));
      });
      expect(extra, `${tag} carries keys absent from en.json`).toEqual([]);
    }
  );
});
