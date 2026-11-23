/**
 * The server's mode-slug bound. The server refuses a slug longer than this, or
 * one holding a character outside `a-z`, `0-9` and `-`. Every slug this module
 * derives fits inside the bound: a folded name longer than it is cut at a word
 * boundary, and the fallback branch counts inside it.
 */
export const MODE_SLUG_MAX_LENGTH = 50;

/** The fallback a name with no Latin letters or digits at all derives. */
const FALLBACK_SLUG = 'mode';

/**
 * Cut a folded slug down to `maxLength` characters without leaving a partial
 * word: the last hyphen inside the range ends the cut, so no trailing hyphen
 * remains. One word that long on its own is a hard cut at `maxLength`.
 */
function trimFoldedSlug(folded: string, maxLength: number): string {
  if (folded.length <= maxLength) {
    return folded;
  }
  const head = folded.slice(0, maxLength);
  const lastHyphen = head.lastIndexOf('-');
  return lastHyphen > 0 ? head.slice(0, lastHyphen) : head;
}

/**
 * The slug a mode form derives from a name. Web's custom-mode form and mobile's
 * organization mode form both call it, so one name gives one identifier on
 * either client.
 *
 * A letter with a diacritic folds to its base letter first: the name is
 * decomposed and its combining marks dropped, so `Código` derives `codigo`.
 * The rest lowercases, every run of other characters folds to one hyphen, and
 * the ends carry no hyphen.
 *
 * The suggestion always fits the server's `MODE_SLUG_MAX_LENGTH` bound and is
 * never one of the taken slugs. A folded name longer than the bound drops whole
 * trailing words, so `analytics-reporting-pipeline-throughput-timeline-budget`
 * suggests `analytics-reporting-pipeline-throughput-timeline`. When the
 * suggestion is taken, a count is appended — `security-reviewer-2`,
 * `security-reviewer-3`, … — and the name is cut shorter to keep the count
 * inside the bound, so each candidate also fits. A name that folds away
 * completely — Arabic, Hebrew, `###` — suggests `mode`, then `mode-2`,
 * `mode-3`, …, skipping every taken slug; those candidates are a few
 * characters, so the count needs no cut. An empty or whitespace-only name
 * suggests nothing (`''`): the fallback covers a name that folds away, not a
 * field the person has not filled. A derived slug is a suggestion the person
 * can replace.
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
  const taken = new Set(takenSlugs);
  if (folded.length === 0) {
    let attempt = 1;
    const candidate = () => (attempt === 1 ? FALLBACK_SLUG : `${FALLBACK_SLUG}-${attempt}`);
    // Count past every taken slug. A candidate is at most a few characters, so
    // the count stays far below the server bound in practice.
    while (taken.has(candidate())) {
      attempt += 1;
    }
    return candidate();
  }
  const base = trimFoldedSlug(folded, MODE_SLUG_MAX_LENGTH);
  if (!taken.has(base)) {
    return base;
  }
  // Each count gives a distinct suffix, so the loop finds a free candidate after
  // at most as many attempts as there are taken slugs.
  for (let attempt = 2; ; attempt += 1) {
    const suffix = `-${attempt}`;
    const trimmed = trimFoldedSlug(base, MODE_SLUG_MAX_LENGTH - suffix.length);
    const candidate = `${trimmed}${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}
