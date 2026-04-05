/**
 * GitHub Issue Label Helper
 *
 * Adds labels to GitHub issues using the GitHub REST API.
 * Used by the auto-triage system to add the kilo-auto-fix label.
 */

import 'server-only';
import { captureException } from '@sentry/nextjs';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';

const LABEL_COLOR = 'faf74f'; // Kilo label color (hex without #)

export type AddIssueLabelParams = {
  repoFullName: string;
  issueNumber: number;
  label: string;
  githubToken: string;
};

/**
 * Ensure a label exists in a GitHub repository with the specified color
 *
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param label - Label name
 * @param color - Label color (hex without #)
 * @param githubToken - GitHub API token
 */
async function ensureLabelExists(
  owner: string,
  repo: string,
  label: string,
  color: string,
  githubToken: string
): Promise<void> {
  // Check if label exists
  const checkResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/labels/${encodeURIComponent(label)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Kilo-Auto-Triage',
      },
    }
  );

  if (checkResponse.ok) {
    logExceptInTest('[ensureLabelExists] Label already exists', { label });
    return;
  }

  // Label doesn't exist, create it
  logExceptInTest('[ensureLabelExists] Creating label', {
    owner,
    repo,
    label,
    color,
  });

  const createResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/labels`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'Kilo-Auto-Triage',
    },
    body: JSON.stringify({
      name: label,
      color,
      description: 'Auto-generated label by Kilo',
    }),
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();

    // If label already exists (race condition), that's fine
    if (createResponse.status === 422 && errorText.includes('already_exists')) {
      logExceptInTest('[ensureLabelExists] Label already exists (race condition)', {
        label,
      });
      return;
    }

    errorExceptInTest('[ensureLabelExists] GitHub API error', {
      status: createResponse.status,
      statusText: createResponse.statusText,
      error: errorText,
    });

    throw new Error(
      `Failed to create label (${createResponse.status} ${createResponse.statusText}): ${errorText}`
    );
  }

  logExceptInTest('[ensureLabelExists] Label created successfully', { label });
}

/**
 * Add a label to a GitHub issue
 *
 * @param params - Label parameters
 * @throws Error if label addition fails
 */
export async function addIssueLabel(params: AddIssueLabelParams): Promise<void> {
  const { repoFullName, issueNumber, label, githubToken } = params;

  logExceptInTest('[addIssueLabel] Adding label', {
    repoFullName,
    issueNumber,
    label,
  });

  // Parse repo owner and name
  const [owner, repo] = repoFullName.split('/');

  if (!owner || !repo) {
    throw new Error(`Invalid repository name format: ${repoFullName}`);
  }

  try {
    // Ensure the label exists with the correct color before adding it
    await ensureLabelExists(owner, repo, label, LABEL_COLOR, githubToken);

    // Add the label to the issue
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/labels`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'Kilo-Auto-Triage',
        },
        body: JSON.stringify({
          labels: [label],
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      errorExceptInTest('[addIssueLabel] GitHub API error', {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
      });

      throw new Error(
        `Failed to add label (${response.status} ${response.statusText}): ${errorText}`
      );
    }

    logExceptInTest('[addIssueLabel] Label added successfully', {
      issueNumber,
      label,
    });
  } catch (error) {
    errorExceptInTest('[addIssueLabel] Error adding label:', error);
    captureException(error, {
      tags: { operation: 'add-issue-label' },
      extra: { repoFullName, issueNumber, label },
    });
    throw error;
  }
}
