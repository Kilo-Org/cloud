import { describe, expect, it } from 'vitest';

import { CATALOG_LOADERS } from './catalogs';
import { SUPPORTED_LANGUAGES } from './languages';

/**
 * A translated catalog carries exactly the keys English defines. The launcher
 * copy once moved from `launcher.newAgent` to `glanceable.newAgent`, and the
 * orphan key stayed behind in all 86 catalogs until `check:i18n` reported it.
 * This test pins that class to a fast unit check, so a key removed from
 * `en.json` cannot quietly linger in every other catalog and slip past review.
 *
 * Keys that differ only by a plural category (`_one`, `_few`, ...) collapse to
 * their family: a language needs its own categories, and English is not the
 * reference for those. The family itself must match, exactly as
 * `tools/i18n/check-catalogs.mjs` enforces.
 */
const PLURAL_SUFFIX = /_(?:zero|one|two|few|many|other)$/;

function keyFamilies(value: unknown, prefix = '', out = new Set<string>()): Set<string> {
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      keyFamilies(child, path, out);
    } else {
      out.add(path.replace(PLURAL_SUFFIX, ''));
    }
  }
  return out;
}

const ENGLISH_FAMILIES = keyFamilies(CATALOG_LOADERS.en());

describe('catalog keys', () => {
  it('retires launcher.newAgent from every catalog', () => {
    for (const tag of SUPPORTED_LANGUAGES) {
      expect(keyFamilies(CATALOG_LOADERS[tag]())).not.toContain('launcher.newAgent');
    }
  });

  it.each(SUPPORTED_LANGUAGES.filter(tag => tag !== 'en'))(
    '%s defines exactly the English key families',
    tag => {
      const families = keyFamilies(CATALOG_LOADERS[tag]());
      expect(
        [...families].filter(key => !ENGLISH_FAMILIES.has(key)),
        `${tag} defines keys en.json does not`
      ).toEqual([]);
      expect(
        [...ENGLISH_FAMILIES].filter(key => !families.has(key)),
        `${tag} is missing keys en.json defines`
      ).toEqual([]);
    }
  );
});
