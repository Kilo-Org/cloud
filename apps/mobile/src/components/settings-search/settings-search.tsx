import {
  type ReactNode,
  type RefObject,
  useEffect,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, type TextInput, View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { SearchX } from '@/components/ui/icons';
import { RowFrame } from '@/components/ui/row-frame';
import { RowGroup } from '@/components/ui/row-group';
import { SearchField } from '@/components/ui/search-field';
import { Text } from '@/components/ui/text';
import { useStatusAnnouncement } from '@/lib/a11y/status-announcement';
import { useIsLargeFontScale } from '@/lib/font-scale/system-font-scale-context';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { cn } from '@/lib/utils';
import {
  type SettingsMatchRange,
  type SettingsSearchEntry,
  type SettingsSearchResult,
} from './use-settings-search';

/** How long a changing result count waits before the reader is told it. */
const STATUS_ANNOUNCEMENT_DELAY_MS = 500;

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
    const timer = setTimeout(() => {
      setSettled(status);
    }, STATUS_ANNOUNCEMENT_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [status]);
  return settled;
}
