/**
 * Fold case and strip diacritics so a search for "espanol" finds "Español"
 * and "turkce" finds "Türkçe". Shared by the app language picker, the voice
 * language picker and the skill name field, so each folds text the same way.
 */
export function foldForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLowerCase();
}
