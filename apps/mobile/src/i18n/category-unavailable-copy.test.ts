import { describe, expect, it } from 'vitest';

import { CATALOG_LOADERS } from './catalogs';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from './languages';

/**
 * The reason an unavailable notification category shows is mobile copy: the
 * server's `unavailableReason` is English prose, so `notifications-screen.tsx`
 * renders these keys instead. The defect this pins: the Arabic notifications
 * list showed the English sentence. Every catalog must carry its own wording.
 *
 * Key parity only fails when a key is English in EVERY locale, so a single
 * catalog that leaves a reason in English passes `catalog-parity.test.ts` and
 * still shows the English sentence on the device. That is the half this test
 * owns, and it is the rule `label-reference.test.ts` already applies to the
 * PR-comment copy. A catalog that does not carry a key yet resolves to the
 * English string at runtime; the translation slice lands those, and
 * `catalog-parity.test.ts` lists them as pending in the meantime. The
 * assertions below therefore fire on every translation that lands.
 */
const UNAVAILABLE_REASON_KEYS = [
  'notifications.category.kiloclawActivityUnavailable',
  'notifications.category.balanceAlertsUnavailable',
  'notifications.category.securityFindingsUnavailable',
] as const;

/**
 * The string a catalog itself ships for a dotted key, or undefined when the
 * catalog does not carry it yet -- the fallback to English happens in i18next,
 * never in the catalog file.
 */
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

describe('unavailable-category reasons', () => {
  it('defines every reason in English', () => {
    for (const key of UNAVAILABLE_REASON_KEYS) {
      expect(catalogValue('en', key), `en.json is missing ${key}`).toBeTruthy();
    }
  });

  it.each(SUPPORTED_LANGUAGES.filter(tag => tag !== 'en'))('%s ships its own reason copy', tag => {
    for (const key of UNAVAILABLE_REASON_KEYS) {
      const value = catalogValue(tag, key);
      // An absent key is still pending translation: it resolves to English on
      // the device, but only `catalog-parity.test.ts` can tell a tracked
      // absence from an untracked one.
      if (value !== undefined) {
        expect(value.trim(), `${tag} ${key} is empty`).toBeTruthy();
        expect(value, `${tag} ${key} is the English sentence`).not.toBe(catalogValue('en', key));
      }
    }
  });
});
