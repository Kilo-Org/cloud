/**
 * The server's mode-slug bound. The server refuses a slug longer than this, or
 * one holding a character outside `a-z`, `0-9` and `-`. The fallback branch
 * counts inside this bound; a folded name keeps its own length, and the form and
 * the server refuse a slug longer than the bound.
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
 * `###` — suggests `mode`, then `mode-2`, `mode-3`, … Each fallback candidate is
 * a few characters, and the counter runs past every taken slug, so the fallback
 * is never taken. A folded name keeps its own length: the form and the server
 * refuse a slug longer than the bound. An empty or whitespace-only name suggests
 * nothing (`''`): the fallback covers a name that folds away, not a field the
 * person has not filled. A derived slug is a suggestion the person can replace.
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
  // Count past every taken slug. A candidate is at most a few characters, so the
  // count stays far below the server bound in practice.
  while (taken.has(candidate())) {
    attempt += 1;
  }
  return candidate();
}
