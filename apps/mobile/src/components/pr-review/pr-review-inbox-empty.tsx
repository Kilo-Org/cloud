// The PR inbox's empty slot: the body drawn when the merged list has no rows.
//
// It owns two contracts the list depends on. Every state renders under its own
// element identity, because two states that draw the same element type at the
// same position otherwise reconcile into ONE host view and Android keeps the
// previous state's accessibility props on it (the reconnect card was announced
// as "Loading inbox"). And the slot keeps the height its loading placeholder
// measured, so a settled body that is shorter than the skeletons does not pull
// the RECENT section below it up after the screen has settled.
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
import { useEmptySlotHeight } from '@/lib/pr-review/use-empty-slot-height';

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
  const slot = useEmptySlotHeight(props.view.kind === 'loading');
  return (
    <View onLayout={slot.handleLayout} style={slot.style}>
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
      <View key={view.kind} accessibilityLabel={t('prReview.inbox.loading')}>
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
    return (
      <EmptyState
        key={view.kind}
        icon={GitPullRequest}
        title={t('prReview.inbox.noReviewRequests')}
        description={t('prReview.inbox.noReviewRequestsDescription')}
        placement="top"
      />
    );
  }

  if (view.kind === 'permission') {
    return <QueryError key={view.kind} variant="permission" placement="top" />;
  }

  if (view.kind === 'not-found') {
    return <QueryError key={view.kind} variant="not-found" placement="top" />;
  }

  if (view.kind === 'access-denied' || view.kind === 'organization-unavailable') {
    const unavailable = view.kind === 'organization-unavailable';
    return (
      <QueryError
        key={view.kind}
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
      <View key={view.kind} className="px-6 py-6">
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
      key={view.kind}
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
