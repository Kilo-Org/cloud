/**
 * GitHub Issue Comment Helper
 *
 * Posts comments on GitHub issues using the GitHub REST API.
 * Used by the auto-triage system to communicate with issue reporters.
 */

import 'server-only';
import { captureException } from '@sentry/nextjs';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';

export type PostIssueCommentParams = {
  repoFullName: string;
  issueNumber: number;
  body: string;
  githubToken: string;
};

/**
 * Post a comment on a GitHub issue
 *
 * @param params - Comment parameters
 * @throws Error if comment posting fails
 */
export async function postIssueComment(params: PostIssueCommentParams): Promise<void> {
  const { repoFullName, issueNumber, body, githubToken } = params;

  logExceptInTest('[postIssueComment] Posting comment', {
    repoFullName,
    issueNumber,
    bodyLength: body.length,
  });

  // Parse repo owner and name
  const [owner, repo] = repoFullName.split('/');

  if (!owner || !repo) {
    throw new Error(`Invalid repository name format: ${repoFullName}`);
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'Kilo-Auto-Triage',
        },
        body: JSON.stringify({
          body,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      errorExceptInTest('[postIssueComment] GitHub API error', {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
      });

      throw new Error(
        `Failed to post comment (${response.status} ${response.statusText}): ${errorText}`
      );
    }

    logExceptInTest('[postIssueComment] Comment posted successfully', {
      issueNumber,
    });
  } catch (error) {
    errorExceptInTest('[postIssueComment] Error posting comment:', error);
    captureException(error, {
      tags: { operation: 'post-issue-comment' },
      extra: { repoFullName, issueNumber },
    });
    throw error;
  }
}
