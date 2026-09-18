import { describe, expect, it } from 'vitest';

import { CATALOG_LOADERS } from './catalogs';
import { SUPPORTED_LANGUAGES } from './languages';

/**
 * A translated catalog must be a key-for-key copy of English.
 * `tools/i18n/check-catalogs.mjs` enforces the whole contract in CI; this is
 * the fast local guard for the one invariant that broke the `i18n-leftover`
 * job: a key en.json dropped left behind in the 86 translated catalogs. The
 * dead `launcher.newAgent` entry survived in every catalog after the live copy
 * moved to `glanceable.newAgent`, so the parity check reported an extra key 86
 * times.
 *
 * A catalog may carry a plural category English does not need — a Slavic
 * `few`, an Arabic `two` — so an extra key is allowed only as a category
 * sibling of an English plural family.
 */

const PLURAL_CATEGORY_RE = /_(?:zero|one|two|few|many|other)$/;

/** Every dotted leaf key of a catalog. */
function flatten(value: unknown, prefix = '', out = new Set<string>()): Set<string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    if (prefix !== '') {
      out.add(prefix);
    }
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

const englishKeys = flatten(CATALOG_LOADERS.en());
const englishPluralFamilies = new Set(
  [...englishKeys]
    .filter(key => PLURAL_CATEGORY_RE.test(key))
    .map(key => key.replace(PLURAL_CATEGORY_RE, ''))
);

const TRANSLATED_LANGUAGES = SUPPORTED_LANGUAGES.filter(tag => tag !== 'en');

describe('catalog key parity', () => {
  it('loads the English key set', () => {
    expect(englishKeys.size).toBeGreaterThan(0);
    expect(englishPluralFamilies.size).toBeGreaterThan(0);
  });

  it.each(TRANSLATED_LANGUAGES)('%s carries no key English dropped', tag => {
    const translated = flatten(CATALOG_LOADERS[tag]());
    const extra = [...translated].filter(key => {
      if (englishKeys.has(key)) {
        return false;
      }
      return !(
        PLURAL_CATEGORY_RE.test(key) &&
        englishPluralFamilies.has(key.replace(PLURAL_CATEGORY_RE, ''))
      );
    });
    expect(extra).toEqual([]);
  });

  it.each(TRANSLATED_LANGUAGES)('%s carries every key English defines', tag => {
    const translated = flatten(CATALOG_LOADERS[tag]());
    const missing = [...englishKeys].filter(key => !translated.has(key));
    expect(missing).toEqual([]);
  });

  it('names the live New agent label under one English key', () => {
    // English is the source of truth the 86 catalogs mirror. The live launcher
    // label is `glanceable.newAgent`, so English must not define a second
    // `launcher.newAgent` copy: that would trip the duplicate-copy rule in
    // tools/i18n/check-catalogs.mjs and put every catalog back in the drift
    // this file guards against.
    expect(englishKeys.has('glanceable.newAgent'), 'en.json lacks glanceable.newAgent').toBe(true);
    const launcherKeys = [...englishKeys].filter(key => key.startsWith('launcher.'));
    expect(launcherKeys, 'en.json launcher namespace drifted').toEqual([
      'launcher.openLastSession',
    ]);
  });

  it('keeps the launcher New agent label under its live key', () => {
    // The launcher surface renders `glanceable.newAgent`; this pins the exact
    // leftover that broke `i18n-leftover`. A catalog that still carries
    // `launcher.newAgent` holds a dead second copy of the label and fails here
    // with the offending tag named, instead of only in the generic diff above.
    for (const tag of TRANSLATED_LANGUAGES) {
      const translated = flatten(CATALOG_LOADERS[tag]());
      expect(translated.has('glanceable.newAgent'), `${tag} lacks glanceable.newAgent`).toBe(true);
      expect(translated.has('launcher.newAgent'), `${tag} still carries launcher.newAgent`).toBe(
        false
      );
      // The whole `launcher` namespace holds the one live label. A dead sibling
      // left behind there is the same defect under another name, so pin the
      // namespace rather than the single key that broke CI this time.
      const launcherKeys = [...translated].filter(key => key.startsWith('launcher.'));
      expect(launcherKeys, `${tag} launcher holds a dead key`).toEqual([
        'launcher.openLastSession',
      ]);
    }
  });
});
