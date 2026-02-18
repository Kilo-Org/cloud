/**
 * GitHubLabelsService
 *
 * Fetches available labels from a GitHub repository.
 * Falls back to default labels on error or empty result.
 */

export const DEFAULT_LABELS = ['bug', 'duplicate', 'question', 'needs clarification'];

type GitHubLabelResponse = {
  name: string;
};

/**
 * Fetch all labels from a GitHub repository.
 * Returns DEFAULT_LABELS if the fetch fails or the repo has no labels.
 */
export async function fetchRepoLabels(
  repoFullName: string,
  githubToken: string
): Promise<string[]> {
  console.log('[auto-triage:labels] Fetching labels for repo:', repoFullName);

  try {
    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}/labels?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Kilo-Auto-Triage',
        },
      }
    );

    console.log('[auto-triage:labels] GitHub API response status', {
      repoFullName,
      status: response.status,
    });

    if (!response.ok) {
      console.warn(
        '[auto-triage:labels] Non-2xx status from GitHub API, falling back to defaults',
        {
          repoFullName,
          status: response.status,
        }
      );
      return DEFAULT_LABELS;
    }

    const labels: GitHubLabelResponse[] = await response.json();

    if (labels.length === 0) {
      console.warn('[auto-triage:labels] Repo has no labels, falling back to defaults', {
        repoFullName,
      });
      return DEFAULT_LABELS;
    }

    const labelNames = labels.map(l => l.name);
    console.log('[auto-triage:labels] Labels fetched from repo', {
      repoFullName,
      count: labelNames.length,
      labels: labelNames,
    });

    return labelNames;
  } catch (error) {
    console.warn('[auto-triage:labels] Failed to fetch labels, falling back to defaults', {
      repoFullName,
      error: error instanceof Error ? error.message : String(error),
    });
    return DEFAULT_LABELS;
  }
}
