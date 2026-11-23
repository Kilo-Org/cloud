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

/** Deepest wrapper stack the peeler walks before it gives up. */
const MAX_PEEL_STEPS = 64;
const SCHEME_PREFIX = /^https?:\/\//i;
// Quote glyphs platforms borrow as link delimiters, peeled at string edges.
const EDGE_QUOTES =
  /^["'\u00AB\u00BB\u201A\u201E\u2019\u2018\u201C\u201D`]+|["'\u00AB\u00BB\u201A\u201E\u2019\u2018\u201C\u201D`]+$/g;
// A whole trailing punctuation run, so an ellipsis is decoration too.
const TRAILING_PUNCT_RUN = /[.,;:!?\u2026\u3002\uFF0C\uFF01\uFF1F]+$/;
const DIGIT_END = /\d$/;

/**
 * Whitespace as `\s` defines it, tested one code unit at a time. The code
 * points stay hexadecimal so the ranges read as Unicode, and oxfmt writes them
 * lowercase, which `unicorn/number-literal-case` rejects.
 */
/* oxlint-disable unicorn/number-literal-case -- oxfmt writes lowercase hex */
function isWhitespaceChar(char: string): boolean {
  const code = char.codePointAt(0);
  if (code === undefined) {
    return false;
  }
  if (code <= 0x20) {
    return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  }
  return (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}
/* oxlint-enable unicorn/number-literal-case */

/** The outcome of scanning a markdown target from the `(` at `open`. */
type TargetScan =
  | Readonly<{ kind: 'target'; target: string }>
  | Readonly<{ kind: 'dead'; whitespaceAt: number }>
  | Readonly<{ kind: 'end' }>;

/** The one outcome that carries no position: the text ended first. */
const SCAN_END: TargetScan = { kind: 'end' };

/**
 * Scan the markdown target that starts after the `(` at `open`, up to the
 * first `)` or whitespace, and report why the scan stopped. A `)` closes the
 * target, a whitespace character makes it dead at that index, and the end of
 * the text ends the scan with no `)`.
 */
function scanMarkdownTarget(text: string, open: number): TargetScan {
  let end = open + 1;
  for (;;) {
    const char = text[end];
    if (char === undefined) {
      return SCAN_END;
    }
    if (char === ')') {
      return { kind: 'target', target: text.slice(open + 1, end) };
    }
    if (isWhitespaceChar(char)) {
      return { kind: 'dead', whitespaceAt: end };
    }
    end += 1;
  }
}

/**
 * The target of the first `[title](target)` link in free text, where the
 * target holds no `)` and no whitespace. One left-to-right pass over the text,
 * with each failed suffix visited once.
 */
function embeddedMarkdownTarget(text: string): string | null {
  let runStart = -1;
  // Index of the whitespace that ended the last dead scan. That scan covered
  // every character from its `(` up to the whitespace, and a later `(` at or
  // before it would read the same characters, so its scan is skipped. Scans
  // therefore cover disjoint ranges and the whole walk costs one pass.
  let deadAt = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\n') {
      runStart = -1;
    } else if (char === '[') {
      // Keep the first `[` of the run: it is the leftmost match start, and a
      // later `[` in the same run closes on the same `]`.
      if (runStart < 0) {
        runStart = index;
      }
    } else if (char === ']') {
      const open = index + 1;
      // A `]` always ends the run it closes.
      if (runStart >= 0 && text[open] === '(' && open > deadAt) {
        const scan = scanMarkdownTarget(text, open);
        if (scan.kind === 'target') {
          return scan.target;
        }
        if (scan.kind === 'end') {
          // No `)` follows this `(`, and a later candidate starts further
          // right, so it reaches the same end and cannot match either.
          return null;
        }
        deadAt = scan.whitespaceAt;
      }
      runStart = -1;
    }
  }
  return null;
}

/**
 * The target of a whole-string `[title](target)` link, where the title ends at
 * the first `]` and the target holds no `)`.
 */
function wholeMarkdownTarget(text: string): string | null {
  if (text.length < 4 || !text.startsWith('[') || !text.endsWith(')')) {
    return null;
  }
  // The title class cannot cross a `]`, so only the first `]` can close it.
  const close = text.indexOf(']');
  if (close < 1 || text[close + 1] !== '(') {
    return null;
  }
  const target = text.slice(close + 2, -1);
  if (target.includes(')')) {
    return null;
  }
  return target;
}

/** Whether a sentence may punctuate this text: it ends in a digit, or in a
 * wrapper whose own inside ends in a digit (`(…/pull/42)` and `<…/pull/42>`). */
function endsWherePunctuationStops(text: string): boolean {
  if (DIGIT_END.test(text)) {
    return true;
  }
  const closer = text.at(-1);
  let opener: string | null = null;
  if (closer === ')') {
    opener = '(';
  } else if (closer === '>') {
    opener = '<';
  }
  if (opener === null || !text.startsWith(opener)) {
    return false;
  }
  return DIGIT_END.test(text.slice(1, -1));
}

/** Trim the edges, then strip a trailing punctuation run that follows a digit
 * (or a wrapper around one), so `…/pull/42...` and `(…/pull/42).` settle on
 * the URL while `/path.md` keeps its dot. */
function stripDecoration(text: string): string {
  let candidate = text.trim().replace(EDGE_QUOTES, '');
  for (;;) {
    const run = TRAILING_PUNCT_RUN.exec(candidate);
    if (run === null) {
      break;
    }
    const remainder = candidate.slice(0, run.index);
    if (!endsWherePunctuationStops(remainder)) {
      break;
    }
    candidate = remainder;
  }
  return candidate;
}

/** Strip the innermost string, then unwind the enclosing wrappers. */
function settle(innermost: string, layers: string[]): string {
  let tidied = stripDecoration(innermost);
  while (layers.length > 0) {
    const enclosing = layers.pop();
    if (enclosing === undefined) {
      break;
    }
    if (SCHEME_PREFIX.test(tidied)) {
      // Every outer layer would accept this value, so the walk is done.
      break;
    }
    tidied = stripDecoration(enclosing);
  }
  return tidied;
}

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
 *   3. A trailing punctuation run, stripped when the remainder ends in a digit
 *      or in a wrapper around one, so `/path.md` survives while `/pull/42.`
 *      and `(…/pull/42).` stop at the URL. The strip runs before each wrapper
 *      peel, so a wrapper followed by sentence punctuation still unwraps.
 *
 * The walk is iterative and stops after `MAX_PEEL_STEPS` layers, so deeply
 * nested input costs a bounded amount of work. An exhausted walk returns the
 * empty string, which every caller reads as "no match".
 */
export function tidyReviewLinkCandidate(href: string): string {
  let candidate = href;
  // Enclosing wrapper strings, innermost last; unwound once the inside settles.
  const layers: string[] = [];
  for (let step = 0; step <= MAX_PEEL_STEPS; step += 1) {
    candidate = stripDecoration(candidate);
    // A markdown link inside prose ("see [PR 42](url).") never matches the
    // anchored whole-string form, so the finder's retry loses the URL. A
    // matching embedded link whose target carries a scheme wins; otherwise a
    // whole-string markdown link unwraps to its target.
    const embedded = embeddedMarkdownTarget(candidate);
    const unwrapped =
      embedded !== null && SCHEME_PREFIX.test(embedded) ? embedded : wholeMarkdownTarget(candidate);
    if (unwrapped !== null) {
      candidate = unwrapped;
    } else if (candidate.length >= 2 && candidate.startsWith('(') && candidate.endsWith(')')) {
      // A paren/angle layer peels when the inside, itself tidied, still starts
      // with a scheme — the gate keeps `(see <url>)` or plain `(text)` intact
      // while `(<url>)` and `(url)` unwrap. Remember the enclosing string and
      // descend; the gate is applied while unwinding.
      layers.push(candidate);
      candidate = candidate.slice(1, -1);
    } else if (candidate.length >= 2 && candidate.startsWith('<') && candidate.endsWith('>')) {
      layers.push(candidate);
      candidate = candidate.slice(1, -1);
    } else {
      return settle(candidate, layers);
    }
  }
  // The step budget ran out. The empty string is the value both callers
  // already treat as no match, so an exhausted walk needs no error channel.
  return '';
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
