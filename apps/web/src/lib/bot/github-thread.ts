export type GitHubThreadCoordinates = {
  owner: string;
  repo: string;
  number: number;
  reviewCommentId: number | null;
};

export function parseGitHubThreadId(threadId: string): GitHubThreadCoordinates | null {
  if (!threadId.startsWith('github:')) return null;

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

export function getGitHubRepositoryFullNameFromThread(threadId: string): string | null {
  const coordinates = parseGitHubThreadId(threadId);
  return coordinates ? `${coordinates.owner}/${coordinates.repo}` : null;
}
