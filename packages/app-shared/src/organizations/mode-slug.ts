/**
 * The server's mode-slug bound. A slug longer than this, or holding a character
 * outside `a-z`, `0-9` and `-`, is refused, so the derivation stays inside both.
 */
export const MODE_SLUG_MAX_LENGTH = 50;

/** The fallback a name with no Latin letters or digits at all derives. */
const FALLBACK_SLUG = 'mode';

/**
 * The slug a mode form derives from a name. Web's custom-mode form and mobile's
 * organization mode form both call it, so one name gives one identifier on
 * either client.
 *
 * A letter with a diacritic folds to its base letter first: the name is
 * decomposed and its combining marks dropped, so `Código` derives `codigo`.
 * The rest lowercases, every run of other characters folds to one hyphen, and
 * the ends carry no hyphen. A name that folds away completely — Arabic, Hebrew,
 * `###` — suggests `mode`, then `mode-2`, `mode-3`, … past the ones the
 * organization already holds, so the suggestion is never taken; the counter
 * stops at `MODE_SLUG_MAX_LENGTH`, so the fallback always fits the bound. An
 * empty or whitespace-only name suggests nothing (`''`): the fallback covers a
 * name that folds away, not a field the person has not filled. A derived slug is
 * a suggestion the person can replace.
 */
export function modeSlugFromName(name: string, takenSlugs: readonly string[] = []): string {
  // Nothing typed derives nothing; only a name whose characters fold away
  // reaches the fallback counter below.
  if (name.trim().length === 0) {
    return '';
  }
  const folded = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  if (folded.length > 0) {
    return folded;
  }
  const taken = new Set(takenSlugs);
  let attempt = 1;
  const candidate = () => (attempt === 1 ? FALLBACK_SLUG : `${FALLBACK_SLUG}-${attempt}`);
  while (attempt < MODE_SLUG_MAX_LENGTH && taken.has(candidate())) {
    attempt += 1;
  }
  return candidate();
}
