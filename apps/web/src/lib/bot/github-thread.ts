export type GitHubThreadCoordinates = {
  owner: string;
  repo: string;
  number: number;
  reviewCommentId: number | null;
};

/**
 * Thread ids are assigned by the chat adapter, so a thread can reach bot code
 * before one exists. An absent id is not a GitHub thread and parses to null,
 * which callers already treat as "no repository".
 */
export function parseGitHubThreadId(threadId: string | null | undefined): GitHubThreadCoordinates | null {
  if (!threadId?.startsWith('github:')) return null;

  const withoutPrefix = threadId.slice('github:'.length);
  const reviewCommentMatch = withoutPrefix.match(/^([^/]+)\/([^:]+):(\d+):rc:(\d+)$/);
  if (reviewCommentMatch) {
    return {
      owner: reviewCommentMatch[1],
      repo: reviewCommentMatch[2],
      number: Number.parseInt(reviewCommentMatch[3], 10),
      reviewCommentId: Number.parseInt(reviewCommentMatch[4], 10),
    };
  }

  const issueMatch = withoutPrefix.match(/^([^/]+)\/([^:]+):issue:(\d+)$/);
  if (issueMatch) {
    return {
      owner: issueMatch[1],
      repo: issueMatch[2],
      number: Number.parseInt(issueMatch[3], 10),
      reviewCommentId: null,
    };
  }

  const pullRequestMatch = withoutPrefix.match(/^([^/]+)\/([^:]+):(\d+)$/);
  if (pullRequestMatch) {
    return {
      owner: pullRequestMatch[1],
      repo: pullRequestMatch[2],
      number: Number.parseInt(pullRequestMatch[3], 10),
      reviewCommentId: null,
    };
  }

  return null;
}

export function getGitHubRepositoryFullNameFromThread(
  threadId: string | null | undefined
): string | null {
  const coordinates = parseGitHubThreadId(threadId);
  return coordinates ? `${coordinates.owner}/${coordinates.repo}` : null;
}
