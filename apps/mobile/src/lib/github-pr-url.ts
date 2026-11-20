export type GitHubPrUrl = {
  owner: string;
  repo: string;
  number: number;
};

const GITHUB_PR_PATTERN =
  /^https?:\/\/(www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#][^\s]*)?$/i;

function isValidIdentifier(value: string): boolean {
  return value !== '.' && value !== '..';
}

/** Every wrapper layer the helper recognizes, in peel order (see below). */
const PAREN_WRAPPER = /^\((.*)\)$/s;
const ANGLE_WRAPPER = /^<(.*)>$/s;
const MARKDOWN_LINK = /^\[[^\]]*]\(([^)]*)\)$/s;
/** A markdown link anywhere in free text — the finder's retry peels its URL out. */
const MARKDOWN_LINK_IN_TEXT = /\[[^\]\n]*]\(([^)\s]*)\)/;
const SCHEME_PREFIX = /^https?:\/\//i;
// Quote glyphs platforms borrow as link delimiters, peeled at string edges.
const EDGE_QUOTES =
  /^["'\u00AB\u00BB\u201A\u201E\u2019\u2018\u201C\u201D`]+|["'\u00AB\u00BB\u201A\u201E\u2019\u2018\u201C\u201D`]+$/g;
// Sentence punctuation stripped only while a digit still ends the string.
const TRAILING_SENTENCE_PUNCT = /[.,;:!?\u2026\u3002\uFF0C\uFF01\uFF1F]$/;
const DIGIT_END = /\d$/;

/**
 * Peel review-link decoration from a pasted URL candidate, so URLs that
 * arrive wrapped (markdown links, quoted shares, `<...>` autolinks, trailing
 * sentence punctuation) still parse. Pure text shaping only: it never promotes
 * a non-review URL — every checker (scheme, credentials, host, strict digits)
 * still sees and rejects its input.
 *
 * Layer order matters and each layer repeats until it no longer matches:
 *   1. A wrapper the inner layer leaves intact: `(...)`, `<...>` — only when
 *      the inside starts with a scheme — and markdown `[title](url)`.
 *   2. Whitespace and edge quote glyphs (" ' « » „ " ' ' `).
 *   3. Trailing sentence punctuation, but only while the remainder still ends
 *      in a digit, so `/path.md` survives and `/pull/42.` stops at the 2.
 */
export function tidyReviewLinkCandidate(href: string): string {
  // A markdown link inside prose ("see [PR 42](url).") never matches the
  // anchored whole-string form, so the finder's retry loses the URL. Scan the
  // candidate for any embedded markdown link whose target carries a scheme,
  // and unwrap to that target.
  const embedded = MARKDOWN_LINK_IN_TEXT.exec(href);
  if (embedded?.[1] !== undefined && SCHEME_PREFIX.test(embedded[1])) {
    return tidyReviewLinkCandidate(embedded[1]);
  }
  const markdown = MARKDOWN_LINK.exec(href);
  if (markdown?.[1] !== undefined) {
    return tidyReviewLinkCandidate(markdown[1]);
  }
  // A paren/angle layer peels when the inside, itself tidied, still starts
  // with a scheme — the gate keeps `(see <url>)` or plain `(text)` intact
  // while `(<url>)` and `(url)` unwrap, and the recursion collapses nested
  // layers in one call. The tidied inside is computed ONCE and reused as the
  // return value, so the cost per nesting level stays linear.
  const parenInner = PAREN_WRAPPER.exec(href)?.[1];
  if (parenInner !== undefined) {
    const tidied = tidyReviewLinkCandidate(parenInner);
    if (SCHEME_PREFIX.test(tidied)) {
      return tidied;
    }
  }
  const angleInner = ANGLE_WRAPPER.exec(href)?.[1];
  if (angleInner !== undefined) {
    const tidied = tidyReviewLinkCandidate(angleInner);
    if (SCHEME_PREFIX.test(tidied)) {
      return tidied;
    }
  }
  let candidate = href.trim().replace(EDGE_QUOTES, '');
  for (;;) {
    // Strip the trailing punct only while WHAT REMAINS after it still ends in
    // a digit: `/pull/42.` → `/pull/42`, but `/path.md` keeps its dot.
    const endsInPunct = TRAILING_SENTENCE_PUNCT.test(candidate);
    const remainderEndsInDigit = DIGIT_END.test(candidate.slice(0, -1));
    if (!endsInPunct || !remainderEndsInDigit) {
      break;
    }
    candidate = candidate.slice(0, -1);
  }
  return candidate;
}

/**
 * Parse a GitHub pull request URL into its owner, repo and PR number.
 *
 * The candidate first passes through `tidyReviewLinkCandidate`, so review-link
 * decoration (markdown/quoted/paren wrappers, trailing sentence punctuation)
 * does not hide an otherwise parseable PR link. Then matches
 * `http(s)://(www.)github.com/<owner>/<repo>/pull/<digits>`
 * case-insensitively and tolerates any trailing subpath (e.g. `/files`), query
 * string and trailing slash. Returns `null` for non-PR URLs (issues, tree, plain
 * repo), non-GitHub hosts, or malformed input.
 */
export function parseGitHubPrUrl(href: string): GitHubPrUrl | null {
  const candidate = tidyReviewLinkCandidate(href);
  if (candidate.length === 0) {
    return null;
  }
  const match = GITHUB_PR_PATTERN.exec(candidate);
  if (!match) {
    return null;
  }
  // The pattern guarantees the digit group is present when exec returns.
  const numberString = match[4];
  if (numberString === undefined) {
    return null;
  }
  const number = Number.parseInt(numberString, 10);
  if (!Number.isInteger(number) || number <= 0) {
    return null;
  }
  const owner = match[2] ?? '';
  const repo = match[3] ?? '';
  if (!isValidIdentifier(owner) || !isValidIdentifier(repo)) {
    return null;
  }
  return { owner, repo, number };
}
