import {
  LANGUAGE_ENDONYMS,
  LANGUAGE_ENGLISH_NAMES,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from './languages';
import { collator } from '@/lib/intl-cache';

export type LanguageRow = {
  tag: SupportedLanguage;
  /** The language's name in its own language — the primary line. */
  endonym: string;
  /** The English name — the secondary line, so the row is findable either way. */
  englishName: string;
};

/** One entry of the picker list: a group title, the device option, or a language. */
export type LanguagePickerItem =
  | { kind: 'section'; key: string; section: 'current' | 'all' }
  | { kind: 'device'; key: string }
  | { kind: 'language'; key: string; row: LanguageRow };

/**
 * Fold case and strip diacritics so a search for "espanol" finds "Español"
 * and "turkce" finds "Türkçe".
 */
function foldForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase();
}

const ALL_ROWS: readonly LanguageRow[] = SUPPORTED_LANGUAGES.map(tag => ({
  tag,
  endonym: LANGUAGE_ENDONYMS[tag],
  englishName: LANGUAGE_ENGLISH_NAMES[tag],
}));

/**
 * Every supported language by endonym, filtered by an optional query and
 * collated in `locale`. The query matches the endonym, the English name and
 * the tag, so a speaker finds their language whether or not they read the
 * interface's current language.
 */
export function languageRows(query: string, locale?: SupportedLanguage): readonly LanguageRow[] {
  const comparer = collator(locale ?? 'en', { sensitivity: 'base' });
  const needle = foldForSearch(query.trim());
  return (
    (
      needle
        ? ALL_ROWS.filter(
            row =>
              foldForSearch(row.endonym).includes(needle) ||
              foldForSearch(row.englishName).includes(needle) ||
              row.tag.toLocaleLowerCase().startsWith(needle)
          )
        : [...ALL_ROWS]
    )
      // eslint-disable-next-line unicorn/no-array-sort -- Hermes lacks toSorted(); each branch creates a new array.
      .sort((a, b) => comparer.compare(a.endonym, b.endonym))
  );
}

/**
 * The picker's list. With no query it opens on a "Current" group — the device
 * option plus the language already in use — followed by every language by
 * endonym. The groups depend only on what was applied when the sheet opened,
 * never on the row the user is tapping, so the list never reorders under a
 * finger. A query replaces both groups with the flat match list.
 */
export function languagePickerItems(
  query: string,
  applied: SupportedLanguage,
  usingDeviceLanguage: boolean
): readonly LanguagePickerItem[] {
  const rows = languageRows(query, applied);
  if (query.trim()) {
    return rows.map(row => ({ kind: 'language', key: row.tag, row }));
  }
  // The device option already names the applied language when the preference
  // is "device", so pinning it a second time would just duplicate the row.
  const pinned = usingDeviceLanguage ? undefined : rows.find(row => row.tag === applied);
  return [
    { kind: 'section', key: 'section:current', section: 'current' },
    { kind: 'device', key: 'device' },
    ...(pinned ? [{ kind: 'language' as const, key: pinned.tag, row: pinned }] : []),
    { kind: 'section', key: 'section:all', section: 'all' },
    ...rows
      .filter(row => row.tag !== pinned?.tag)
      .map(row => ({ kind: 'language' as const, key: row.tag, row })),
  ];
}
