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

/**
 * Keys `en.json` defines that the translation slice still has to land in every
 * catalog. English copy is written first, and only the translation slice may
 * write another catalog (apps/mobile/AGENTS.md; every other slice's catalog
 * edit is reverted), so copy a slice adds sits in `en.json` alone until that
 * slice runs. Only these keys may be absent; `pnpm check:i18n` still fails
 * every one of them, as does the section's `i18n-missing.py` gate, so the gap
 * cannot ship. Delete an entry the translation slice has landed in every
 * catalog.
 *
 * No key is pending. Every catalog has the profile-editor and preview copy.
 * Keep the missing-key assertion strict.
 */
const PENDING_TRANSLATION_KEYS = new Set<string>();

/**
 * The preview card's empty-state description. English added it for the
 * composer-less transcript card, and the reader must see it in their own
 * words rather than the English fallback. Every catalog must carry it, so the
 * test below reads the catalogs directly and not through
 * `PENDING_TRANSLATION_KEYS`: re-listing the key as pending cannot turn an
 * untranslated catalog green.
 */
const PREVIEW_EMPTY_DESCRIPTION_KEY = 'agentChat.session.emptyTranscriptDescription';

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
  it('names only pending keys en.json defines', () => {
    for (const key of PENDING_TRANSLATION_KEYS) {
      expect(ENGLISH_FAMILIES.has(key), `${key} is not an English key family`).toBe(true);
    }
  });

  it('retires launcher.newAgent from every catalog', () => {
    for (const tag of SUPPORTED_LANGUAGES) {
      expect(keyFamilies(CATALOG_LOADERS[tag]())).not.toContain('launcher.newAgent');
    }
  });

  it.each(SUPPORTED_LANGUAGES.filter(tag => tag !== 'en'))(
    '%s translates the preview empty-state description',
    tag => {
      const catalog = CATALOG_LOADERS[tag]();
      const english = CATALOG_LOADERS.en();
      const description =
        typeof catalog === 'string'
          ? undefined
          : catalog.agentChat?.session?.emptyTranscriptDescription;
      const englishDescription =
        typeof english === 'string'
          ? undefined
          : english.agentChat?.session?.emptyTranscriptDescription;
      expect(description, `${tag} lacks ${PREVIEW_EMPTY_DESCRIPTION_KEY}`).toBeTypeOf('string');
      expect(description, `${tag} leaves ${PREVIEW_EMPTY_DESCRIPTION_KEY} in English`).not.toBe(
        englishDescription
      );
    }
  );

  it.each(SUPPORTED_LANGUAGES.filter(tag => tag !== 'en'))(
    '%s defines exactly the English key families',
    tag => {
      const families = keyFamilies(CATALOG_LOADERS[tag]());
      expect(
        [...families].filter(key => !ENGLISH_FAMILIES.has(key)),
        `${tag} defines keys en.json does not`
      ).toEqual([]);
      expect(
        [...ENGLISH_FAMILIES].filter(
          key => !families.has(key) && !PENDING_TRANSLATION_KEYS.has(key)
        ),
        `${tag} is missing keys en.json defines`
      ).toEqual([]);
    }
  );
});
