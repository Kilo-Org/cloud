import { type ParseKeys, type TFunction } from 'i18next';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, type TextInput, View } from 'react-native';

import { clearComposerInput } from '@/components/agents/composer-input-clear';
import { EmptyState } from '@/components/empty-state';
import { SearchX } from '@/components/ui/icons';
import { RowFrame } from '@/components/ui/row-frame';
import { RowGroup } from '@/components/ui/row-group';
import { SearchField } from '@/components/ui/search-field';
import { Text } from '@/components/ui/text';
import { useStatusAnnouncement } from '@/lib/a11y/status-announcement';
import { useIsLargeFontScale } from '@/lib/font-scale/system-font-scale-context';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import {
  type SettingsKeyword,
  type SettingsPath,
  type SettingsSearchSource,
} from '@/lib/settings-search/definitions';
import { searchSettings } from '@/lib/settings-search/match';
import { cn } from '@/lib/utils';

/**
 * One resolved result: the entry a select handler navigates with, and the
 * UTF-16 ranges of the visible label that matched, for the bold cue.
 */
export type SettingsSearchResult = {
  entry: SettingsSearchEntry;
  ranges: readonly SettingsMatchRange[];
};

type SettingsMatchRange = { readonly start: number; readonly end: number };

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
} as const satisfies Record<SettingsKeyword, ParseKeys<'translation'>>;

/** The breadcrumb separator between nested screen names. */
const CONTEXT_SEPARATOR = ' · ';

/** How long a changing result count waits before the reader is told it. */
const STATUS_ANNOUNCEMENT_DELAY_MS = 500;

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

/**
 * The settings search index over every source the current screen can show.
 *
 * The labels and keyword synonyms are resolved through `t()` in the active app
 * language, so the matcher folds the same strings the reader sees; a definition
 * marked unavailable (`available: false`) is not in the index at all. The query
 * is matched against the label, the containing screen's breadcrumb, and the
 * synonyms, and only a label match returns highlight ranges.
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
        if (setting.available === false) {
          continue;
        }
        let keywords: readonly string[] | undefined;
        if (setting.keyword !== undefined) {
          keywords = keywordsById.get(setting.keyword);
          if (keywords === undefined) {
            keywords = keywordTerms(t, setting.keyword);
            keywordsById.set(setting.keyword, keywords);
          }
        }
        resolved.push({
          id: setting.id,
          label: t(setting.label),
          context: context === undefined || context === '' ? undefined : context,
          keywords,
          path: source.path,
          params: source.params,
        });
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

type SettingsSearchFieldProps = {
  query: string;
  onChangeText: (text: string) => void;
  inputRef: RefObject<TextInput | null>;
};

/**
 * The Profile search field: the shared `SearchField` at the screen's gutter,
 * pinned above the scrolling settings body. The field owns the clear control
 * and the search return key; the query stays uncontrolled inside `SearchField`,
 * and the caller only tracks its text for results.
 */
export function SettingsSearchField({
  query,
  onChangeText,
  inputRef,
}: Readonly<SettingsSearchFieldProps>) {
  const { t } = useTranslation();
  return (
    <SearchField
      placeholder={t('settingsSearch.placeholder')}
      accessibilityLabel={t('settingsSearch.placeholder')}
      hasText={query.length > 0}
      onChangeText={onChangeText}
      inputRef={inputRef}
      returnKeyType="search"
      autoCorrect={false}
      autoCapitalize="none"
      spellCheck={false}
      className="mx-4 mb-3 mt-3"
    />
  );
}

type SettingsSearchResultsProps = {
  results: readonly SettingsSearchResult[];
  onSelect: (entry: SettingsSearchEntry) => void;
};

/**
 * The search results body: one grouped card of matching rows, or the no-match
 * state. The result count is announced after the typing settles, through a
 * polite live region on Android and one imperative announcement on iOS, so a
 * reader hears each count once instead of every keystroke's intermediate count.
 */
export function SettingsSearchResults({ results, onSelect }: Readonly<SettingsSearchResultsProps>) {
  const { t } = useTranslation();
  const status = t('settingsSearch.resultsStatus', { resultCount: results.length });
  const announcedStatus = useCoalescedStatus(status);
  useStatusAnnouncement(announcedStatus);

  return (
    <View className={cn(SCREEN_BODY_CLASS, 'relative')}>
      <Text
        accessibilityLiveRegion={Platform.OS === 'android' ? 'polite' : undefined}
        className="absolute size-px overflow-hidden"
      >
        {announcedStatus}
      </Text>
      {results.length === 0 ? (
        <EmptyState
          placement="top"
          inset="none"
          icon={SearchX}
          title={t('settingsSearch.noMatches')}
          description={t('settingsSearch.emptyDescription')}
        />
      ) : (
        <RowGroup>
          {results.map(({ entry, ranges }) => (
            <RowFrame
              key={entry.id}
              onPress={() => {
                onSelect(entry);
              }}
              accessibilityLabel={entry.label}
              accessibilityHint={entry.context}
              trailing={entry.path === undefined ? undefined : ({ kind: 'chevron' } as const)}
            >
              <HighlightedSettingLabel label={entry.label} ranges={ranges} />
              {entry.context === undefined ? null : (
                <Text
                  numberOfLines={1}
                  ellipsizeMode="tail"
                  className="mt-0.5 text-xs text-muted-foreground"
                >
                  {entry.context}
                </Text>
              )}
            </RowFrame>
          ))}
        </RowGroup>
      )}
    </View>
  );
}

/**
 * The visible row title with the matched spans set in a heavier weight. The
 * row's accessible name stays the plain label, so the spoken text is never the
 * marked-up children.
 */
function HighlightedSettingLabel({
  label,
  ranges,
}: Readonly<{ label: string; ranges: readonly SettingsMatchRange[] }>) {
  const lines = useIsLargeFontScale() ? 2 : 1;
  return (
    <Text
      numberOfLines={lines}
      ellipsizeMode="tail"
      className="text-sm font-medium text-foreground"
    >
      {renderHighlightedLabel(label, ranges)}
    </Text>
  );
}

/** Split the label at the matched ranges; only the matched pieces take the heavier weight. */
function renderHighlightedLabel(
  label: string,
  ranges: readonly SettingsMatchRange[]
): readonly ReactNode[] {
  const segments: ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(cursor, Math.min(range.start, label.length));
    const end = Math.max(start, Math.min(range.end, label.length));
    if (start > cursor) {
      segments.push(label.slice(cursor, start));
    }
    if (end > start) {
      segments.push(
        <Text key={`${start}-${end}`} className="text-sm font-semibold">
          {label.slice(start, end)}
        </Text>
      );
      cursor = end;
    }
  }
  if (cursor < label.length) {
    segments.push(label.slice(cursor));
  }
  return segments;
}

/** Hold a changing status until the query settles, and speak only the latest one. */
function useCoalescedStatus(status: string): string {
  const [settled, setSettled] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSettled(status), STATUS_ANNOUNCEMENT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status]);
  return settled;
}
