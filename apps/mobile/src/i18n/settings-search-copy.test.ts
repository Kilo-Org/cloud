import { describe, expect, it } from 'vitest';

import { searchSettings } from '@/lib/settings-search/match';

import { CATALOG_LOADERS } from './catalogs';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from './languages';
import type en from './locales/en.json';

/**
 * The localized Settings search, read against every shipped catalog. The
 * matcher must find a setting by its own translated label and by a keyword
 * that appears nowhere in that label, and it must fold accents in both
 * directions: a query without the accent still finds an accented label, and a
 * query carrying an extra combining mark still finds the plain label. Locales
 * whose six labels carry no foldable accent get the second direction against
 * their real label, so no shipped language skips the check.
 */
const KEYWORD_NAMES = [
  'signOut',
  'appearance',
  'appUnlock',
  'language',
  'notifications',
  'privacy',
] as const;

type KeywordName = (typeof KEYWORD_NAMES)[number];

type SettingsSearchCopy = {
  placeholder: string;
  noMatches: string;
  emptyDescription: string;
  resultsStatus: string;
  keywords: Record<KeywordName, string>;
};

/**
 * Every shipped catalog is key-for-key identical to English, so en.json's
 * type is the precise shape of the catalog each loader returns.
 */
type SettingsCatalog = typeof en;

type SearchableEntry = {
  label: string;
  keywords?: readonly string[];
};

type Highlight = { start: number; end: number };

/**
 * The combining diacritic block a search fold must drop: U+0300–U+036F. A
 * label whose marks live here can be queried without them; a label whose
 * script marks live elsewhere gets the added-mark direction instead, which a
 * fold of this block alone still resolves.
 */
const FOLDABLE_DIACRITICS = /[\u0300-\u036F]/gu;
const FOLDABLE_DIACRITIC = /[\u0300-\u036F]/u;

type SettingsSearchResult = {
  entry: SearchableEntry;
  ranges: readonly Highlight[];
};

function settingsCatalog(tag: SupportedLanguage): SettingsCatalog {
  // The loader is typed as i18next's loose ResourceKey; catalog parity makes
  // en.json's type the exact shape of what it returns.
  return CATALOG_LOADERS[tag]() as SettingsCatalog;
}

function alternatives(copy: SettingsSearchCopy, name: KeywordName): string[] {
  return copy.keywords[name].split('|');
}

/** The six indexed settings and the catalog label each one carries. */
function settingRows(catalog: SettingsCatalog): [KeywordName, string][] {
  return [
    ['signOut', catalog.common.signOut],
    ['appearance', catalog.preferences.appearance],
    ['appUnlock', catalog.preferences.biometricUnlock],
    ['language', catalog.common.language],
    ['notifications', catalog.common.notifications],
    ['privacy', catalog.profile.privacyChoices],
  ];
}

/** One entry per indexed setting, labelled and keyworded by this catalog. */
function entriesOf(catalog: SettingsCatalog): SearchableEntry[] {
  return settingRows(catalog).map(([name, label]) => ({
    label,
    keywords: alternatives(catalog.settingsSearch, name),
  }));
}

/** Folds case before marks, so Turkish İ becomes i instead of a bare I. */
function foldForContainment(value: string): string {
  return value.toLowerCase().normalize('NFD').replaceAll(/\p{M}/gu, '');
}

/** Drops the foldable diacritics, lowering first so Turkish İ folds to i. */
function withoutDiacritics(label: string): string {
  return label.toLowerCase().normalize('NFD').replace(FOLDABLE_DIACRITICS, '').normalize('NFC');
}

/**
 * A keyword and the label it belongs to, chosen so no word of the keyword
 * appears in that label: the hit then proves the keyword is indexed rather
 * than the label happening to contain the query.
 */
function independentKeyword(
  catalog: SettingsCatalog
): { label: string; keyword: string } | undefined {
  for (const [name, label] of settingRows(catalog)) {
    const folded = foldForContainment(label);
    for (const keyword of alternatives(catalog.settingsSearch, name)) {
      const words = keyword.split(/\s+/).map(word => foldForContainment(word));
      if (words.every(word => !folded.includes(word))) {
        return { label, keyword };
      }
    }
  }
  return undefined;
}

function hitFor(
  results: readonly SettingsSearchResult[],
  label: string
): SettingsSearchResult | undefined {
  return results.find(result => result.entry.label === label);
}

/** The span the matcher highlights, in the label's own coordinates. */
function highlightedSpan(ranges: readonly Highlight[]): { start: number; end: number } {
  return {
    start: Math.min(...ranges.map(range => range.start)),
    end: Math.max(...ranges.map(range => range.end)),
  };
}

describe('settings search copy', () => {
  it.each(SUPPORTED_LANGUAGES)('%s labels every indexed setting in its own catalog', tag => {
    const copy = settingsCatalog(tag).settingsSearch;

    expect(copy.placeholder.trim()).not.toBe('');
    expect(copy.noMatches.trim()).not.toBe('');
    expect(copy.emptyDescription.trim()).not.toBe('');
    expect(copy.resultsStatus).toContain('{{resultCount}}');

    for (const name of KEYWORD_NAMES) {
      const parts = alternatives(copy, name);
      expect(parts.length, `${tag} ${name} has no alternatives`).toBeGreaterThanOrEqual(2);
      for (const part of parts) {
        expect(part.trim(), `${tag} ${name} has a padded alternative`).toBe(part);
        expect(part, `${tag} ${name} has an empty alternative`).not.toBe('');
      }
    }
  });

  it.each(SUPPORTED_LANGUAGES)('%s finds a setting by its translated label', tag => {
    const catalog = settingsCatalog(tag);
    const entries = entriesOf(catalog);
    const appearance = catalog.preferences.appearance;

    const hit = hitFor(searchSettings(entries, appearance, tag), appearance);

    expect(hit, `${tag} did not match "${appearance}"`).toBeDefined();
    expect(highlightedSpan(hit?.ranges ?? [])).toEqual({ start: 0, end: appearance.length });
  });

  it.each(SUPPORTED_LANGUAGES)('%s finds a setting by a keyword absent from its label', tag => {
    const catalog = settingsCatalog(tag);
    const entries = entriesOf(catalog);
    const candidate = independentKeyword(catalog);
    if (candidate === undefined) {
      throw new Error(`${tag} has no keyword outside its label`);
    }
    const { label, keyword } = candidate;

    const hit = hitFor(searchSettings(entries, keyword, tag), label);

    expect(hit, `${tag} did not match keyword "${keyword}" for "${label}"`).toBeDefined();
    // A keyword-only hit highlights nothing in the label.
    expect(hit?.ranges ?? []).toHaveLength(0);
    // Removing the keywords must remove the same hit: it came from a keyword,
    // not from any part of the label.
    const withoutKeywords = entries.map(entry =>
      entry.label === label ? { label: entry.label, keywords: [] } : entry
    );
    const control = searchSettings(withoutKeywords, keyword, tag);
    expect(
      control.some(result => result.entry.label === label),
      `${tag} still matched "${label}" without its keywords`
    ).toBe(false);
  });

  it.each(SUPPORTED_LANGUAGES)('%s folds accent differences against its label', tag => {
    const catalog = settingsCatalog(tag);
    const entries = entriesOf(catalog);
    // A real label whose accent lives in the foldable diacritic block.
    const accented = entries
      .map(entry => entry.label)
      .find(label => FOLDABLE_DIACRITIC.test(label.toLowerCase().normalize('NFD')));
    const label = accented ?? catalog.preferences.appearance;
    // With no such label, the query keeps the real text and adds one optional
    // acute after its first character, which folding must drop. The first
    // character is intentional: a trailing mark on a Turkish i is avoided.
    const query =
      accented === undefined
        ? `${label.slice(0, 1)}\u0301${label.slice(1)}`
        : withoutDiacritics(label);

    expect(query, `${tag} produced the label unchanged`).not.toBe(label);

    const hit = hitFor(searchSettings(entries, query, tag), label);

    expect(hit, `${tag} did not match "${label}" from "${query}"`).toBeDefined();
    expect(highlightedSpan(hit?.ranges ?? [])).toEqual({ start: 0, end: label.length });
  });
});
