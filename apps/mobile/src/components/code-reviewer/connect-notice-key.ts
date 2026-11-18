import { type ReviewerPlatform } from '@/lib/code-reviewer-config';

/**
 * Which disconnected notice a provider overview shows. GitHub's app install and
 * GitLab's connect flow have different role gates, so they use different copy;
 * Bitbucket renders its own screen.
 */
export function connectNoticeKey(platform: ReviewerPlatform) {
  return platform === 'gitlab'
    ? ('codeReviewer.gitlab.notConnectedReadOnly' as const)
    : ('codeReviewer.notConnectedReadOnly' as const);
}
