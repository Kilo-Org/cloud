import {
  LANGUAGE_ENDONYMS,
  LANGUAGE_ENGLISH_NAMES,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from './languages';

export type LanguageRow = {
  tag: SupportedLanguage;
  /** The language's name in its own language — the primary line. */
  endonym: string;
  /** The English name — the secondary line, so the row is findable either way. */
  englishName: string;
};

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
})).toSorted((a, b) => a.endonym.localeCompare(b.endonym));

/**
 * The picker's rows: the active language first so it is visible without a
 * scroll, then every other language by endonym. A query filters on the
 * endonym, the English name, and the tag, so a speaker finds their language
 * whether or not they read the interface's current language.
 */
export function languageRows(query: string, active?: SupportedLanguage): readonly LanguageRow[] {
  const needle = foldForSearch(query.trim());
  const matches = needle
    ? ALL_ROWS.filter(
        row =>
          foldForSearch(row.endonym).includes(needle) ||
          foldForSearch(row.englishName).includes(needle) ||
          row.tag.toLocaleLowerCase().startsWith(needle)
      )
    : ALL_ROWS;
  const pinned = matches.find(row => row.tag === active);
  return pinned ? [pinned, ...matches.filter(row => row.tag !== active)] : matches;
}
