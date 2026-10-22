// First-page states for the PR diff file list, rendered above the list body
// when the first page of files failed. Kept out of `pr-diff-file-list.tsx` so
// the list module only carries its layout and pagination wiring.

import { useTranslation } from 'react-i18next';

import { CenteredState } from '@/components/centered-state';
import { type PrDiffStateCopy } from '@/components/pr-review/diff/pr-diff-state-copy';
import { TabStateMessage } from '@/components/pr-review/diff/pr-diff-rows';
import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';
import { PrReviewUnavailableActions } from '@/components/pr-review/pr-review-unavailable-actions';
import { QueryError } from '@/components/query-error';
import { type PrReviewQueryState } from '@/lib/pr-review/classify-pr-review-query-state';

type PrDiffFileListStateProps = {
  readonly state: PrReviewQueryState;
  readonly copy: PrDiffStateCopy;
  /** GitLab and Bitbucket scopes lose the request to their own connection. */
  readonly isProviderScope: boolean;
  readonly isRetrying: boolean;
  readonly onRetry: () => void;
};

export function PrDiffFileListState({
  state,
  copy,
  isProviderScope,
  isRetrying,
  onRetry,
}: PrDiffFileListStateProps) {
  const { t } = useTranslation();
  if (state.kind === 'not-found') {
    // GitLab folds its connection failures into the same NOT_FOUND a deleted
    // merge request produces, so provider scopes offer the read retry and
    // the connection check instead of a dead end (GitHub keeps the terminal
    // copy — its recovery is the install CTA on the Overview).
    return (
      <TabStateMessage
        title={copy.unavailableTitle}
        message={copy.unavailableMessage}
        action={
          isProviderScope ? (
            <PrReviewUnavailableActions onRetry={onRetry} isRetrying={isRetrying} />
          ) : undefined
        }
      />
    );
  }
  if (state.kind === 'permission') {
    return <TabStateMessage title={t('common.accessDenied')} message={copy.accessDeniedMessage} />;
  }
  if (state.kind === 'reconnect') {
    return (
      <CenteredState contentContainerClassName="px-6">
        <PrReviewReconnectNotice />
      </CenteredState>
    );
  }
  if (state.kind === 'service-unavailable') {
    return (
      <QueryError
        variant="server"
        title={t('prReview.reviewServiceUnavailable')}
        message={t('prReview.reviewServiceUnavailableDescription')}
        onRetry={onRetry}
        isRetrying={isRetrying}
      />
    );
  }
  return <QueryError variant="server" onRetry={onRetry} isRetrying={isRetrying} />;
}
