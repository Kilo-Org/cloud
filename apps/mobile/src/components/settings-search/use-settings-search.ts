import { type ParseKeys, type TFunction } from 'i18next';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type TextInput } from 'react-native';

import { clearComposerInput } from '@/components/agents/composer-input-clear';
import {
  type SettingsKeyword,
  type SettingsPath,
  type SettingsSearchSource,
} from '@/lib/settings-search/definitions';
import { searchSettings } from '@/lib/settings-search/match';

/**
 * One resolved result: the entry a select handler navigates with, and the
 * UTF-16 ranges of the visible label that matched, for the bold cue.
 */
export type SettingsSearchResult = {
  entry: SettingsSearchEntry;
  ranges: readonly SettingsMatchRange[];
};

export type SettingsMatchRange = { readonly start: number; readonly end: number };

/**
 * The already-localized entry: `label` is what the reader sees and hears,
 * `context` is the breadcrumb of the containing screen, and `keywords` are the
 * localized synonyms the result may have matched instead of its label.
 */
export type SettingsSearchEntry = {
  id: string;
  label: string;
  context?: string;
  keywords?: readonly string[];
  path?: SettingsPath;
  params?: Readonly<Record<string, string>>;
};

/**
 * Each keyword's catalog path, resolved through the typed catalog rather than
 * a string template, so a keyword without copy is a compile error.
 */
const KEYWORD_COPY = {
  signOut: 'settingsSearch.keywords.signOut',
  appearance: 'settingsSearch.keywords.appearance',
  appUnlock: 'settingsSearch.keywords.appUnlock',
  language: 'settingsSearch.keywords.language',
  notifications: 'settingsSearch.keywords.notifications',
  privacy: 'settingsSearch.keywords.privacy',
} as const satisfies Record<SettingsKeyword, ParseKeys>;

/** The breadcrumb separator between nested screen names. */
const CONTEXT_SEPARATOR = ' · ';

/** No entries while the query is empty; a stable identity for the idle state. */
const NO_ENTRIES: readonly SettingsSearchEntry[] = [];

/** No results while the query is empty; a stable identity for the idle state. */
const NO_RESULTS: readonly SettingsSearchResult[] = [];

/**
 * Split one localized keyword entry (`biometrics|face ID|fingerprint`) into its
 * distinct terms.
 */
function keywordTerms(t: TFunction, keyword: SettingsKeyword): readonly string[] {
  const terms = t(KEYWORD_COPY[keyword])
    .split('|')
    .map(term => term.trim())
    .filter(term => term.length > 0);
  return [...new Set(terms)];
}

/** Resolve one keyword's synonyms once and share them with every setting that names it. */
function cachedKeywordTerms(
  keyword: SettingsKeyword,
  t: TFunction,
  cache: Map<SettingsKeyword, readonly string[]>
): readonly string[] {
  const cached = cache.get(keyword);
  if (cached !== undefined) {
    return cached;
  }
  const terms = keywordTerms(t, keyword);
  cache.set(keyword, terms);
  return terms;
}

/**
 * The settings search index over every source the current screen can show.
 *
 * The labels and keyword synonyms are resolved through `t()` in the active app
 * language, so the matcher folds the same strings the reader sees; a definition
 * marked unavailable (`available: false`) is not in the index at all. The query
 * is matched against the label, the containing screen's breadcrumb, and the
 * synonyms, and only a label match returns highlight ranges.
 *
 * This module deliberately has no native UI imports: the Profile screen and its
 * suites load the index without mounting the field or result rows.
 */
export function useSettingsSearch(sources: readonly SettingsSearchSource[]) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const inputRef = useRef<TextInput | null>(null);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const active = query.trim().length > 0;

  // The translated index changes with the language, the sources and entering
  // search — not with each keystroke; each keyword's synonyms are resolved once
  // and shared by every setting that names it.
  const entries = useMemo(() => {
    if (!active) {
      return NO_ENTRIES;
    }
    const resolved: SettingsSearchEntry[] = [];
    const keywordsById = new Map<SettingsKeyword, readonly string[]>();
    for (const source of sources) {
      const context = source.context?.map(key => t(key)).join(CONTEXT_SEPARATOR);
      for (const setting of source.settings) {
        if (setting.available !== false) {
          resolved.push({
            id: setting.id,
            label: t(setting.label),
            context: context === undefined || context === '' ? undefined : context,
            keywords:
              setting.keyword === undefined
                ? undefined
                : cachedKeywordTerms(setting.keyword, t, keywordsById),
            path: source.path,
            params: source.params,
          });
        }
      }
    }
    return resolved;
  }, [active, sources, t]);

  const results = useMemo(
    () => (active ? searchSettings(entries, query, locale) : NO_RESULTS),
    [active, entries, locale, query]
  );

  const clear = useCallback(() => {
    setQuery('');
    // `clear()` alone is dropped on Android once a programmatic write moved the
    // native text; the shared helper writes the empty text too.
    clearComposerInput(inputRef.current);
  }, []);

  return { query, active, setQuery, clear, inputRef, results };
}
