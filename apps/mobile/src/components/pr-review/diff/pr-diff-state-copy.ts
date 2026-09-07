// Provider wording for the file list's terminal and empty states.
//
// GitLab calls this a merge request, and its copy must not name the Kilo
// GitHub App or "this pull request"; GitHub and Bitbucket both say pull
// request, so the provider term alone switches the strings and the list keeps
// one set of states for all three providers.

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
  const isMergeRequest = useProviderPrScope(triple).ref.platform === 'gitlab';
  return useMemo(
    () => ({
      unavailableTitle: isMergeRequest
        ? t('prReview.terms.mergeRequestUnavailable')
        : t('prReview.pullRequestUnavailable'),
      unavailableMessage: isMergeRequest
        ? t('prReview.terms.unavailableDescription')
        : t('prReview.pullRequestUnavailableDescription'),
      accessDeniedMessage: isMergeRequest
        ? t('prReview.terms.accessDeniedMergeRequest')
        : t('prReview.accessDeniedDescription'),
      noChangesDescription: isMergeRequest
        ? t('prReview.terms.noFilesChangedDescription')
        : undefined,
    }),
    [isMergeRequest, t]
  );
}
