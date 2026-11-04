import { type TFunction } from 'i18next';

import { type ReviewerPlatform } from '@/lib/code-reviewer-config';

const EMPTY_COPY_KEYS = {
  github: {
    title: 'codeReviewer.repos.installGithubApp',
    description: 'codeReviewer.repos.installGithubAppDescription',
  },
  gitlab: {
    title: 'common.noRepositoriesFound',
    description: 'codeReviewer.repos.gitlabNoRepositoriesDescription',
  },
  bitbucket: {
    title: 'common.noRepositoriesFound',
    description: 'codeReviewer.repos.bitbucketNoRepositoriesDescription',
  },
} as const satisfies Record<ReviewerPlatform, { title: string; description: string }>;

/**
 * The empty-repositories copy of a platform: only GitHub has an app to install,
 * while GitLab and Bitbucket list whatever the connected account can reach.
 */
export function repositoryEmptyCopy(platform: ReviewerPlatform, t: TFunction) {
  const copy = EMPTY_COPY_KEYS[platform];
  return { title: t(copy.title), description: t(copy.description) };
}
