// The PR inbox's empty slot: the body drawn when the merged list has no rows.
//
// It owns one contract the list depends on: every state renders under its own
// element identity, because two states that draw the same element type at the
// same position otherwise reconcile into ONE host view and Android keeps the
// previous state's accessibility props on it (the reconnect card was announced
// as "Loading inbox").
//
// The slot no longer reserves the skeleton height for its settled body. It was
// there to stop the RECENT section below it from moving when the skeletons
// became something shorter, and that space is what kept the RECENT state under
// the tab bar on a compact phone. The list now leaves RECENT out while this
// body loads, so nothing sits below the skeletons to be pushed: the settled
// body lays itself out and RECENT appears under it where it stays.
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';
import { type PrInboxView } from '@/components/pr-review/pr-review-inbox-view';
import { Button } from '@/components/ui/button';
import { GitPullRequest } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { type ProviderPrPlatform } from '@/lib/pr-review/provider-pr-ref';

const SKELETON_ROW_COUNT = 5;

type InboxEmptyProps = {
  view: PrInboxView;
  onRetry: () => void;
  isRetrying: boolean;
  /** The provider whose failure produced the reconnect view, when known. */
  reconnectPlatform: ProviderPrPlatform | null;
  /** The organization scope the inbox read failed in; null for personal. */
  organizationId: string | null;
  /** Leaves a refused organization for the personal scope. */
  onContinueInPersonal: () => void;
};

export function InboxEmpty(props: Readonly<InboxEmptyProps>) {
  const { t } = useTranslation();
  // The loading announcement lives on this keyed node. A keyed node is one host
  // view per state, so the announcement cannot survive into a settled body; a
  // label one level below it never reaches Android's accessibility tree.
  return (
    <View
      key={props.view.kind}
      accessibilityLabel={props.view.kind === 'loading' ? t('prReview.inbox.loading') : undefined}
    >
      <InboxBody {...props} />
    </View>
  );
}

function InboxBody({
  view,
  onRetry,
  isRetrying,
  reconnectPlatform,
  organizationId,
  onContinueInPersonal,
}: Readonly<InboxEmptyProps>) {
  const { t } = useTranslation();
  if (view.kind === 'loading') {
    return (
      <View>
        {Array.from({ length: SKELETON_ROW_COUNT }).map((_, index) => (
          // eslint-disable-next-line react/no-array-index-key -- skeleton placeholders have no stable id
          <View key={index} className="gap-2 border-b-[0.5px] border-hair-soft px-6 py-3">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </View>
        ))}
      </View>
    );
  }

  if (view.kind === 'empty') {
    // Both empty states of this screen are section bodies of one scroll: this
    // one always has the RECENT section below it, so it never owns a clear
    // region of its own. The full-size `top` form put a 56 dp bubble over a
    // 64 dp pin, which held the title 133 dp under the INBOX eyebrow and pushed
    // the RECENT state under the tab bar on a compact phone. Compact drops both;
    // `pt-4` is the separation the dropped pin used to give the eyebrow.
    return (
      <EmptyState
        icon={GitPullRequest}
        title={t('prReview.inbox.noReviewRequests')}
        description={t('prReview.inbox.noReviewRequestsDescription')}
        placement="top"
        compact
        className="pt-4"
      />
    );
  }

  if (view.kind === 'permission') {
    return <QueryError variant="permission" placement="top" />;
  }

  if (view.kind === 'not-found') {
    return <QueryError variant="not-found" placement="top" />;
  }

  if (view.kind === 'access-denied' || view.kind === 'organization-unavailable') {
    const unavailable = view.kind === 'organization-unavailable';
    return (
      <QueryError
        variant={unavailable ? 'not-found' : 'permission'}
        title={t(
          unavailable
            ? 'prReview.inbox.organizationUnavailableTitle'
            : 'prReview.inbox.accessLostTitle'
        )}
        message={t(
          unavailable
            ? 'prReview.inbox.organizationUnavailableDescription'
            : 'prReview.inbox.accessLostDescription'
        )}
        placement="top"
        action={
          // No retry here: the server refuses this organization, so repeating
          // the same read can only be refused again. The way out is the
          // personal scope, which needs no organization membership.
          <Button
            className={STATE_ACTION_CLASS}
            variant="outline"
            onPress={onContinueInPersonal}
            accessibilityLabel={t('prReview.inbox.continueInPersonal')}
          >
            <Text>{t('prReview.inbox.continueInPersonal')}</Text>
          </Button>
        }
      />
    );
  }

  if (view.kind === 'reconnect') {
    return (
      <View className="px-6 py-6">
        <PrReviewReconnectNotice
          platform={reconnectPlatform ?? undefined}
          organizationId={organizationId}
        />
      </View>
    );
  }

  // retryable / service-unavailable: a BAD_GATEWAY names its own cause (the
  // review service is temporarily unavailable); every other failure keeps the
  // generic could-not-load copy. Both offer Retry.
  const isServiceUnavailable = view.kind === 'service-unavailable';
  return (
    <QueryError
      variant="server"
      title={
        isServiceUnavailable
          ? t('prReview.reviewServiceUnavailable')
          : t('prReview.inbox.couldNotLoad')
      }
      message={isServiceUnavailable ? t('prReview.reviewServiceUnavailableDescription') : undefined}
      placement="top"
      onRetry={onRetry}
      isRetrying={isRetrying}
    />
  );
}
