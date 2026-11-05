/**
 * Lowercase words of an agent name or slug, joined by single spaces.
 *
 * A slug is limited to `[a-z][a-z0-9-]*`, so its separators are hyphens; a name
 * may carry any punctuation or spacing. Comparing only the words lets
 * `Code Reviewer` and `code-reviewer` count as the same text.
 */
function words(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * True when an agent's slug only repeats its display name, so a list row can
 * leave the slug out instead of printing the same words twice.
 *
 * The match ignores case, hyphens and spacing (`Reviewer` / `reviewer`,
 * `Code Reviewer` / `code-reviewer`). A name in a script the Latin-only slug
 * alphabet cannot express never matches, so its slug keeps showing.
 */
export function isRedundantAgentSlug(name: string, slug: string): boolean {
  const slugWords = words(slug);
  return slugWords.length > 0 && slugWords === words(name);
}
