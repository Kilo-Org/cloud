/**
 * Shared parser that decides whether a free-form text body (typically a
 * GitHub PR review comment) should be admitted as a request for Kilo to
 * auto-fix the issue it discusses.
 *
 * Why this lives in @kilocode/app-shared and not in the webhook consumer:
 * the canonical "what command admits a fix" rule has to stay in lock-step
 * with the user-facing footer that the code-review prompt advertises in
 * inline review comments (see
 * apps/web/src/lib/code-reviews/prompts/default-prompt-template.json,
 * field inlineCommentFooter). The drift-guard test in apps/web
 * (default-prompt-template.drift-guard.test.ts) reads that footer literal
 * and asserts this parser still admits the exact command it advertises, so a
 * future change to the footer or the parser that breaks the contract fails
 * the test instead of silently regressing the product.
 *
 * The mention pattern is deliberately broadened from the previous strict
 * one (which rejected the product-advertised "@kilocode-bot fix it"
 * because the word-boundary assertion did not match between the letters of
 * "kilocode"): the new pattern admits @kilo, @kilocode, and
 * @kilocode-bot (and any future @kilo… variant) while still requiring a
 * fix-or-patch keyword. A bare "fix" or "patch" with no @kilo* mention is
 * rejected so unrelated comment text does not trigger Auto Fix.
 */

/**
 * The mention pattern admits the known Kilo handles — @kilo, @kilocode,
 * and @kilocode-bot — without matching unrelated tokens that start with the
 * "kilo" prefix (e.g. @kilocorp, @kilogram). The first alternative matches a
 * standalone @kilo; the second matches @kilocode with an optional suffix.
 */
const MENTION_PATTERN = /@kilo(?:\b|code[\w-]*\b)/i;
const FIX_KEYWORD_PATTERN = /\b(?:fix|patch)\b/i;

export function parseFixCommand(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) {
    return false;
  }
  return MENTION_PATTERN.test(text) && FIX_KEYWORD_PATTERN.test(text);
}
