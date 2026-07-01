export type CodeReviewUiPlatform = 'github' | 'gitlab' | 'bitbucket';

const REVIEW_URL_SUFFIXES: Record<CodeReviewUiPlatform, RegExp> = {
  github: /\/pull\/\d+\/?(?:[?#].*)?$/,
  gitlab: /\/-\/merge_requests\/\d+\/?(?:[?#].*)?$/,
  bitbucket: /\/pull-requests\/\d+\/?(?:[?#].*)?$/,
};

export function getCodeReviewRepositoryUrl(
  platform: CodeReviewUiPlatform,
  reviewUrl: string
): string {
  return reviewUrl.replace(REVIEW_URL_SUFFIXES[platform], '');
}

export function getCodeReviewJobsHref(
  platform: CodeReviewUiPlatform,
  organizationId?: string | null
): string {
  const params = new URLSearchParams({ platform });
  if (organizationId) params.set('view', 'jobs');

  const basePath = organizationId
    ? `/organizations/${organizationId}/code-reviews`
    : '/code-reviews';
  return `${basePath}?${params.toString()}`;
}
