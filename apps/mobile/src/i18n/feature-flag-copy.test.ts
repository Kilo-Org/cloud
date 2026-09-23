import { describe, expect, it } from 'vitest';

import { CATALOG_LOADERS } from './catalogs';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from './languages';

/**
 * The Preferences feature-flag rows name the source and state of the value the
 * build acted on: `remote` or `default`, and the version gate. The row prefix
 * (`common.enabled`) is translated, but the source and state words shipped as
 * English notation in every catalog, so the otherwise Arabic screen read
 * `default · not loaded` beside the localized value word.
 *
 * Key parity only fails when a key is English in EVERY locale, so a single
 * catalog left in English passes `catalog-parity.test.ts` and still shows the
 * English copy on the device. That is the half this test owns, and it is the
 * rule `label-reference.test.ts` already applies to the PR-comment copy. The
 * assertions below fire on every catalog that still ships English: a catalog
 * that is missing a key resolves to English at runtime, so it fails here too.
 */
const FEATURE_FLAG_COPY_KEYS = [
  'preferences.featureFlagApplied',
  'preferences.featureFlagSkipped',
  'preferences.featureFlagNotLoaded',
] as const;

/** The string a catalog itself ships for a dotted key, or undefined. */
function catalogValue(tag: SupportedLanguage, key: string): string | undefined {
  let node: unknown = CATALOG_LOADERS[tag]();
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

describe('feature-flag row copy', () => {
  it('defines every key in English', () => {
    for (const key of FEATURE_FLAG_COPY_KEYS) {
      expect(catalogValue('en', key), `en.json is missing ${key}`).toBeTruthy();
    }
  });

  it.each(SUPPORTED_LANGUAGES.filter(tag => tag !== 'en'))(
    '%s ships its own feature-flag copy',
    tag => {
      for (const key of FEATURE_FLAG_COPY_KEYS) {
        const value = catalogValue(tag, key);
        expect(value, `${tag} ${key} is missing`).toBeTruthy();
        expect(value?.trim(), `${tag} ${key} is empty`).toBeTruthy();
        expect(value, `${tag} ${key} is the English copy`).not.toBe(catalogValue('en', key));
      }
    }
  );
});
