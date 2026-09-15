// Provider wording for the file list's terminal and empty states.
//
// GitLab calls this a merge request, and its copy must not name the Kilo
// GitHub App or "this pull request"; GitHub and Bitbucket both say pull
// request, so the provider term alone switches the noun and the list keeps
// one set of states for all three providers.
//
// The GitHub-only App sentence is GitHub-only for a second reason: Bitbucket
// Cloud has no Kilo GitHub App, so its terminal state shares GitLab's neutral
// description while keeping the pull-request noun.

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { type ProviderPrTriple, useProviderPrScope } from '@/lib/pr-review/provider-pr-ref';

type PrDiffStateCopy = {
  readonly unavailableTitle: string;
  readonly unavailableMessage: string;
  readonly accessDeniedMessage: string;
  /** Undefined keeps the GitHub wording inside `EmptyFilesView`. */
  readonly noChangesDescription: string | undefined;
};

export function usePrDiffStateCopy(triple: ProviderPrTriple): PrDiffStateCopy {
  const { t } = useTranslation();
  const platform = useProviderPrScope(triple).ref.platform;
  const isMergeRequest = platform === 'gitlab';
  const isGitHub = platform === 'github';
  return useMemo(
    () => ({
      unavailableTitle: isMergeRequest
        ? t('prReview.terms.mergeRequestUnavailable')
        : t('prReview.pullRequestUnavailable'),
      // Only GitHub can blame a missing Kilo GitHub App.
      unavailableMessage: isGitHub
        ? t('prReview.pullRequestUnavailableDescription')
        : t('prReview.terms.unavailableDescription'),
      accessDeniedMessage: isMergeRequest
        ? t('prReview.terms.accessDeniedMergeRequest')
        : t('prReview.accessDeniedDescription'),
      noChangesDescription: isMergeRequest
        ? t('prReview.terms.noFilesChangedDescription')
        : undefined,
    }),
    [isMergeRequest, isGitHub, t]
  );
}
