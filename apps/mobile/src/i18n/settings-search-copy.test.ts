import { describe, expect, it } from 'vitest';

import { searchSettings } from '@/lib/settings-search/match';

import { CATALOG_LOADERS } from './catalogs';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from './languages';

/**
 * The localized Settings search, read against every shipped catalog. The
 * matcher must find a setting by its own translated label and by the local
 * keywords that catalog ships, and it must treat a decomposed query
 * (`Cafe` + U+0301) as the precomposed label the screen renders. A locale
 * without an accent in any of these six labels gets the deliberate `Café`
 * entry, so canonical equivalence is exercised for every language rather than
 * skipped where the catalog happens to be unaccented.
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

type SettingsCatalog = {
  settingsSearch: SettingsSearchCopy;
  common: { language: string; signOut: string; notifications: string };
  preferences: { appearance: string; biometricUnlock: string };
  profile: { privacyChoices: string };
};

type SearchableEntry = {
  label: string;
  keywords?: readonly string[];
};

type Highlight = { start: number; end: number };

type SettingsSearchResult = {
  entry: SearchableEntry;
  ranges: readonly Highlight[];
};

function settingsCatalog(tag: SupportedLanguage): SettingsCatalog {
  return CATALOG_LOADERS[tag]() as unknown as SettingsCatalog;
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

/** Folds case and marks the way the matcher compares a query with a label. */
function foldForContainment(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * A keyword and the label it belongs to, chosen so no word of the keyword
 * appears in that label: the hit then proves the keyword is indexed rather
 * than the label happening to contain the query.
 */
function independentKeyword(catalog: SettingsCatalog): { label: string; keyword: string } {
  for (const [name, label] of settingRows(catalog)) {
    const folded = foldForContainment(label);
    for (const keyword of alternatives(catalog.settingsSearch, name)) {
      const words = keyword.split(/\s+/).map(foldForContainment);
      if (words.every(word => !folded.includes(word))) {
        return { label, keyword };
      }
    }
  }
  // Every shipped catalog carries one; the fallback keeps a regression a
  // failed hit assertion rather than a missing keyword in the test itself.
  return {
    label: catalog.common.signOut,
    keyword: alternatives(catalog.settingsSearch, 'signOut')[0] ?? '',
  };
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

  it.each(SUPPORTED_LANGUAGES)('%s finds a setting by a local keyword', tag => {
    const catalog = settingsCatalog(tag);
    const entries = entriesOf(catalog);
    const { label, keyword } = independentKeyword(catalog);

    const hit = hitFor(searchSettings(entries, keyword, tag), label);

    expect(hit, `${tag} did not match keyword "${keyword}" for "${label}"`).toBeDefined();
  });

  it.each(SUPPORTED_LANGUAGES)('%s matches a decomposed label as its precomposed form', tag => {
    const catalog = settingsCatalog(tag);
    const entries = entriesOf(catalog);
    const accented = entries
      .map(entry => entry.label)
      .find(label => label !== label.normalize('NFD'));
    const label = accented ?? 'Café';
    const query = label.normalize('NFD');

    expect(query, `${tag} produced no decomposed query for "${label}"`).not.toBe(label);
    if (accented === undefined) {
      // No shipped label carries a mark in this language, so the equivalence is
      // pinned on a deliberate precomposed entry instead of being skipped.
      entries.push({ label });
    }

    const hit = hitFor(searchSettings(entries, query, tag), label);

    expect(hit, `${tag} did not match the decomposed form of "${label}"`).toBeDefined();
    expect(highlightedSpan(hit?.ranges ?? [])).toEqual({ start: 0, end: label.length });
  });
});
