/**
 * Fold case, strip diacritics and map compatibility forms so a search for
 * "espanol" finds "Español", "turkce" finds "Türkçe", and the full-width
 * "ＥＳＰＡＮＯＬ" or the ligature "ﬁ" fold to what the stored name folds to.
 * Shared by the app language picker, the voice language picker and the skill
 * name field, so each folds text the same way.
 *
 * NFKD is the canonical decomposition NFD applies plus the compatibility
 * mapping, which is what reduces full-width Latin and digits, ligatures and
 * circled forms; the diacritic strip then removes the marks NFKD separates.
 */
export function foldForSearch(value: string): string {
  return value
    .normalize('NFKD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLowerCase();
}
