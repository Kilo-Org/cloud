import { type TFunction } from 'i18next';

import { type ReviewerPlatform } from '@/lib/code-reviewer-config';

type EmptyCopyKeys = { title: string; description: string };

const EMPTY_COPY_KEYS = {
  gitlab: {
    title: 'common.noRepositoriesFound',
    description: 'codeReviewer.repos.gitlabNoRepositoriesDescription',
  },
  bitbucket: {
    title: 'common.noRepositoriesFound',
    description: 'codeReviewer.repos.bitbucketNoRepositoriesDescription',
  },
} as const satisfies Record<Exclude<ReviewerPlatform, 'github'>, EmptyCopyKeys>;

// GitHub's empty copy splits on the integration: without the app the account
// can review nothing, so the state is an install prompt; an installed app that
// lists no repository has an installation to widen instead, and a status that
// has not answered yet is not evidence the app is missing, so it reads the
// same as installed. The title already says no repositories were found, so the
// installed description only names widening the installation's access.
const GITHUB_EMPTY_COPY_KEYS = {
  installed: {
    title: 'common.noRepositoriesFound',
    description: 'codeReviewer.repos.githubNoRepositoriesDescription',
  },
  notInstalled: {
    title: 'codeReviewer.repos.installGithubApp',
    description: 'codeReviewer.repos.installGithubAppDescription',
  },
} as const satisfies Record<'installed' | 'notInstalled', EmptyCopyKeys>;

/**
 * The empty-repositories copy of a platform: GitHub asks for the app install
 * only when the integration is confirmed missing, while an installed or not yet
 * known integration points at its repository access; GitLab and Bitbucket list
 * whatever the connected account can reach.
 */
export function repositoryEmptyCopy(
  platform: ReviewerPlatform,
  t: TFunction,
  options?: { githubAppInstalled?: boolean }
): EmptyCopyKeys {
  const copy =
    platform === 'github'
      ? GITHUB_EMPTY_COPY_KEYS[options?.githubAppInstalled === false ? 'notInstalled' : 'installed']
      : EMPTY_COPY_KEYS[platform];
  return { title: t(copy.title), description: t(copy.description) };
}
