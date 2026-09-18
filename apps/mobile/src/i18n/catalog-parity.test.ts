import { describe, expect, it } from 'vitest';

import { CATALOG_LOADERS } from './catalogs';
import { SUPPORTED_LANGUAGES } from './languages';
import en from './locales/en.json';

/**
 * Every translated catalog is a key-for-key copy of English. `check-catalogs.mjs`
 * enforces that for the whole repository in CI; this test keeps the leftover half
 * of the rule inside the mobile suite, so deleting an English key without deleting
 * it from the 86 translated catalogs fails here too. A catalog still carrying
 * `launcher.newAgent` after en.json dropped it is exactly that half-done removal.
 */

type Catalog = Record<string, unknown>;

/** Dotted leaf paths, matching `flatten` in tools/i18n/check-catalogs.mjs. */
function flatten(value: unknown, prefix = '', out = new Set<string>()): Set<string> {
  for (const [key, child] of Object.entries(value as Catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      flatten(child, path, out);
    } else {
      out.add(path);
    }
  }
  return out;
}

/**
 * A plural category English does not carry, such as `_few` in Russian. The
 * checker allows it when English defines any sibling of the same family.
 */
function isPluralSibling(key: string, englishKeys: Set<string>): boolean {
  const base = key.replace(/_(?:zero|one|two|few|many|other)$/, '');
  if (base === key) {
    return false;
  }
  for (const englishKey of englishKeys) {
    if (englishKey.startsWith(`${base}_`)) {
      return true;
    }
  }
  return false;
}

const englishKeys = flatten(en);

describe('catalog parity', () => {
  it.each(SUPPORTED_LANGUAGES.filter(tag => tag !== 'en'))(
    'keeps no key English does not define in %s',
    tag => {
      const leftover = [...flatten(CATALOG_LOADERS[tag]())].filter(
        key => !englishKeys.has(key) && !isPluralSibling(key, englishKeys)
      );
      expect(leftover).toEqual([]);
    }
  );
});
