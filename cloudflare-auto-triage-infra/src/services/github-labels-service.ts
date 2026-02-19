/**
 * GitHubLabelsService
 *
 * Fetches available labels from a GitHub repository.
 * Falls back to default labels on error or empty result.
 */

export const DEFAULT_LABELS = ['bug', 'duplicate', 'question', 'needs clarification'];

// Safety cap: stop paginating after this many pages (100 labels/page = 500 labels max).
const MAX_LABEL_PAGES = 5;

const hasStringName = (item: unknown): item is { name: string } =>
  typeof item === 'object' && item !== null && 'name' in item && typeof item.name === 'string';

/**
 * Parse the URL of the next page from a GitHub API Link header, if present.
 * Returns null when there is no next page.
 */
const parseNextPageUrl = (linkHeader: string | null): string | null => {
  if (!linkHeader) return null;
  // Link header format: <url>; rel="next", <url>; rel="last"
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match?.[1] ?? null;
};

/**
 * Fetch all labels from a GitHub repository, following pagination.
 * Returns DEFAULT_LABELS if the fetch fails or the repo has no labels.
 */
export async function fetchRepoLabels(
  repoFullName: string,
  githubToken: string
): Promise<string[]> {
  console.log('[auto-triage:labels] Fetching labels for repo:', repoFullName);

  const headers = {
    Authorization: `Bearer ${githubToken}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Kilo-Auto-Triage',
  };

  try {
    const allLabels: string[] = [];
    let nextUrl: string | null = `https://api.github.com/repos/${repoFullName}/labels?per_page=100`;
    let pagesFetched = 0;

    while (nextUrl !== null && pagesFetched < MAX_LABEL_PAGES) {
      const response = await fetch(nextUrl, { headers });
      pagesFetched++;

      console.log('[auto-triage:labels] GitHub API response status', {
        repoFullName,
        page: pagesFetched,
        status: response.status,
      });

      if (!response.ok) {
        console.warn(
          '[auto-triage:labels] Non-2xx status from GitHub API, falling back to defaults',
          { repoFullName, status: response.status }
        );
        return DEFAULT_LABELS;
      }

      const body: unknown = await response.json();

      if (!Array.isArray(body)) {
        console.warn('[auto-triage:labels] Unexpected response format, falling back to defaults', {
          repoFullName,
          type: typeof body,
        });
        return DEFAULT_LABELS;
      }

      allLabels.push(...body.filter(hasStringName).map(item => item.name));

      nextUrl = parseNextPageUrl(response.headers.get('Link'));
    }

    if (nextUrl !== null) {
      // Still more pages after hitting the cap — warn but continue with what we have.
      console.warn(
        '[auto-triage:labels] Repo has more than expected labels; only first pages fetched',
        {
          repoFullName,
          pagesFetched,
          labelsFetched: allLabels.length,
        }
      );
    }

    if (allLabels.length === 0) {
      console.warn('[auto-triage:labels] Repo has no labels, falling back to defaults', {
        repoFullName,
      });
      return DEFAULT_LABELS;
    }

    console.log('[auto-triage:labels] Labels fetched from repo', {
      repoFullName,
      pagesFetched,
      count: allLabels.length,
      labels: allLabels,
    });

    return allLabels;
  } catch (error) {
    console.warn('[auto-triage:labels] Failed to fetch labels, falling back to defaults', {
      repoFullName,
      error: error instanceof Error ? error.message : String(error),
    });
    return DEFAULT_LABELS;
  }
}
