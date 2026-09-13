/**
 * Fold case and strip diacritics so a search for "espanol" finds "Español"
 * and "turkce" finds "Türkçe". Shared by the app language picker and the
 * voice language picker so both search language names the same way.
 */
export function foldForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLowerCase();
}
