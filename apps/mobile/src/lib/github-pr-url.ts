type GitHubPrUrl = {
  owner: string;
  repo: string;
  number: number;
};

const GITHUB_PR_PATTERN =
  /^https?:\/\/(www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#][^\s]*)?$/i;

function isValidIdentifier(value: string): boolean {
  return value !== '.' && value !== '..';
}

/**
 * Parse a GitHub pull request URL into its owner, repo and PR number.
 *
 * Matches `http(s)://(www.)github.com/<owner>/<repo>/pull/<digits>` and
 * tolerates any trailing subpath (e.g. `/files`), query string and trailing
 * slash. Returns `null` for non-PR URLs (issues, tree, plain repo), uppercase
 * host, non-GitHub hosts, or malformed input.
 */
export function parseGitHubPrUrl(href: string): GitHubPrUrl | null {
  if (typeof href !== 'string' || href.length === 0) {
    return null;
  }
  const match = GITHUB_PR_PATTERN.exec(href);
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
