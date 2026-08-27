/**
 * Fetch a GitHub issue with repository-scoped authorization.
 *
 * Used by the admin "submit issue for triage" form to populate the
 * `issue_title` / `issue_body` / `issue_author` / `issue_labels` fields
 * from a pasted issue URL, matching exactly what the issues.opened
 * webhook would have delivered.
 */

import 'server-only';

export type ParsedIssueUrl = {
  repoOwner: string;
  repoName: string;
  repoFullName: string;
  issueNumber: number;
  issueUrl: string;
};

/**
 * Parse a GitHub issue URL.
 *
 * Accepts the canonical html_url form:
 *   https://github.com/<owner>/<repo>/issues/<number>
 *
 * Rejects PR URLs (`/pull/`) — auto-triage is for issues only.
 */
export function parseGitHubIssueUrl(input: string): ParsedIssueUrl {
  const trimmed = input.trim();
  const match = trimmed.match(
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)(?:[/?#].*)?$/
  );
  if (!match) {
    throw new Error(
      'Must be a GitHub issue URL like https://github.com/<owner>/<repo>/issues/<number>'
    );
  }
  const [, repoOwner, repoName, numberStr] = match;
  const issueNumber = parseInt(numberStr, 10);
  return {
    repoOwner,
    repoName,
    repoFullName: `${repoOwner}/${repoName}`,
    issueNumber,
    issueUrl: `https://github.com/${repoOwner}/${repoName}/issues/${issueNumber}`,
  };
}

export type FetchedIssue = {
  title: string;
  body: string | null;
  authorLogin: string;
  labels: string[];
};

/**
 * Fetch an issue via the GitHub REST API using authorization already resolved
 * for this exact repository.
 *
 * Throws with a user-facing message for the common failure modes
 * (no installation, not found, etc.) so the admin UI can surface them.
 */
export async function fetchIssue(url: ParsedIssueUrl, githubToken: string): Promise<FetchedIssue> {
  const apiUrl = `https://api.github.com/repos/${url.repoOwner}/${url.repoName}/issues/${url.issueNumber}`;
  const response = await fetch(apiUrl, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (response.status === 404) {
    throw new Error(
      `Issue not found, or the Kilo GitHub App does not have access to ${url.repoFullName}.`
    );
  }
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub API returned ${response.status}: ${errorText.slice(0, 500)}`);
  }

  const data: unknown = await response.json();
  if (typeof data !== 'object' || data === null) {
    throw new Error('Unexpected GitHub API response shape');
  }

  const issue = data as {
    title?: unknown;
    body?: unknown;
    user?: { login?: unknown };
    labels?: unknown;
    pull_request?: unknown;
  };

  if (issue.pull_request) {
    throw new Error(
      `${url.issueUrl} is a pull request, not an issue. Auto-triage only works on issues.`
    );
  }

  if (typeof issue.title !== 'string') {
    throw new Error('GitHub API response missing issue title');
  }
  const authorLogin = issue.user?.login;
  if (typeof authorLogin !== 'string') {
    throw new Error('GitHub API response missing issue author');
  }

  const labels = Array.isArray(issue.labels)
    ? issue.labels
        .map((l: unknown) =>
          typeof l === 'string'
            ? l
            : typeof l === 'object' && l !== null && 'name' in l && typeof l.name === 'string'
              ? l.name
              : null
        )
        .filter((l): l is string => l !== null)
    : [];

  return {
    title: issue.title,
    body: typeof issue.body === 'string' ? issue.body : null,
    authorLogin,
    labels,
  };
}
