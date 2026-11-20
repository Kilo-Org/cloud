import { foldForSearch } from './fold-for-search';
import { languageSearchNames } from './language-search-names';
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
  /**
   * Names of this language in the UI language, generated and folded at cache
   * build ("Arabisch" for Arabic under a German UI). Search only — never
   * rendered — so they are stored folded and matched as-is.
   */
  searchNames: readonly string[];
};

/** One entry of the picker list: a group title, the device option, or a language. */
export type LanguagePickerItem =
  | { kind: 'section'; key: string; section: 'current' | 'all' }
  | { kind: 'device'; key: string }
  | { kind: 'language'; key: string; row: LanguageRow };

/** The 87 rows for each UI language, built once per language on first use. */
const ROWS_BY_UI = new Map<SupportedLanguage, readonly LanguageRow[]>();

/**
 * The rows for one UI language. The picker re-filters on every keystroke, so
 * the localized names are folded here, at cache build, instead of on every
 * filter pass.
 */
function rowsFor(ui: SupportedLanguage): readonly LanguageRow[] {
  const cached = ROWS_BY_UI.get(ui);
  if (cached) {
    return cached;
  }
  const names = languageSearchNames(ui);
  const rows: readonly LanguageRow[] = SUPPORTED_LANGUAGES.map(tag => {
    const name = names[tag];
    return {
      tag,
      endonym: LANGUAGE_ENDONYMS[tag],
      englishName: LANGUAGE_ENGLISH_NAMES[tag],
      searchNames: name === undefined ? [] : [foldForSearch(name)],
    };
  });
  ROWS_BY_UI.set(ui, rows);
  return rows;
}

/**
 * Every supported language by endonym, filtered by an optional query and
 * collated in `locale`. The query matches the endonym, the English name, the
 * name in the UI language and the tag, so a speaker finds their language
 * whether or not they read the interface's current language.
 */
export function languageRows(query: string, ui: SupportedLanguage = 'en'): readonly LanguageRow[] {
  const comparer = collator(ui, { sensitivity: 'base' });
  const needle = foldForSearch(query.trim());
  return (
    (
      needle
        ? rowsFor(ui).filter(
            row =>
              foldForSearch(row.endonym).includes(needle) ||
              foldForSearch(row.englishName).includes(needle) ||
              row.searchNames.some(name => name.includes(needle)) ||
              row.tag.toLocaleLowerCase().startsWith(needle)
          )
        : [...rowsFor(ui)]
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
