/* eslint-disable max-lines -- the screen keeps every existing detail section plus the read-only transcript slot */

import * as Haptics from 'expo-haptics';
import { notificationHaptic } from '@/lib/haptics';
import { type Href } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import {
  isCancellableReviewStatus,
  isRetriggerableReviewStatus,
} from '@kilocode/app-shared/code-review';
import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { statusMeta } from '@/components/code-reviewer/review-list-screen';
import {
  findingsEmptyCopyKey,
  flattenCouncilFindings,
  reviewCancellationLabel,
  reviewFailureLabel,
  selectRetryAction,
} from '@/components/code-reviewer/review-detail-helpers';
import { ReviewSpectatorSheet } from '@/components/code-reviewer/review-spectator-sheet';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import {
  CouncilSection,
  FindingCard,
  GateSection,
  MetaRow,
} from '@/components/code-reviewer/review-detail-sections';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { i18n } from '@/i18n';
import { resolveCodeReviewerOpenPrDestination } from '@/lib/code-reviewer-open-pr-destination';
import { reviewerPlatformLabel } from '@/lib/code-reviewer-config';
import { openExternalUrl } from '@/lib/external-link';
import { formatMoney, formatNumber } from '@/lib/format';
import { isPersonal, useReviewConfig } from '@/lib/hooks/use-code-reviewer';
import { useRelativeTimeNow } from '@/lib/hooks/use-now-ticker';
import { useCancelReview, useRetriggerReview, useReviewDetail } from '@/lib/hooks/use-code-reviews';
import { trpcErrorVariant } from '@/lib/trpc-error';
import { cn, parseTimestamp, timeAgo } from '@/lib/utils';

const FINDINGS_PAGE_SIZE = 20;

function confirmRetry(onConfirm: () => void) {
  Alert.alert(
    i18n.t('codeReviewer.reviewDetail.retryTitle'),
    i18n.t('codeReviewer.reviewDetail.retryMessage'),
    [
      { text: i18n.t('common.cancel'), style: 'cancel' },
      { text: i18n.t('common.retry'), onPress: onConfirm },
    ],
    // Android back dismisses, which equals Cancel: no retrigger starts.
    { cancelable: true }
  );
}

export function ReviewDetailScreen({
  scope,
  reviewId,
}: Readonly<{ scope: string; reviewId: string }>) {
  const pushOnce = useSinglePushRoute();
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  // One shared minute clock for every relative label on the screen, so the
  // timestamps stay current while the review is polled and a row here reads the
  // same age as the same review's row in the list.
  const now = useRelativeTimeNow();
  const { data, isLoading, isError, isFetching, error, refetch } = useReviewDetail(reviewId);
  const cancelReview = useCancelReview(scope);
  const retriggerReview = useRetriggerReview(scope);
  // Set before `mutate` and released when the request settles. The mutation's own
  // `isPending` only flips after `mutate` returns, so a confirmation that arrives
  // twice — a double-tapped alert button, or the screen button pressed again
  // before the pending render lands — would otherwise send a second retrigger
  // that the server rejects with BAD_REQUEST.
  const retryInFlight = useRef(false);
  const [visibleCount, setVisibleCount] = useState(FINDINGS_PAGE_SIZE);
  // The review whose transcript is open, `null` while none is. Keying it by the
  // review id closes an open transcript by itself when the route moves to another
  // review, without an effect that would also fire on a plain re-render.
  const [transcriptReviewId, setTranscriptReviewId] = useState<string | null>(null);
  const loadedReview = data?.success ? data.review : undefined;
  // Only a retriggerable automatic review needs the reviewer config. Bitbucket
  // is org-only, and a personal Bitbucket query would throw in toPersonalPlatform.
  const reviewPlatform = loadedReview?.platform ?? 'github';
  const configQueryEnabled =
    loadedReview != null &&
    loadedReview.manual_config == null &&
    isRetriggerableReviewStatus(loadedReview.status) &&
    !(isPersonal(scope) && reviewPlatform === 'bitbucket');
  const reviewConfig = useReviewConfig(scope, reviewPlatform, { enabled: configQueryEnabled });

  function confirmCancel(onConfirm: () => void) {
    confirm({
      title: i18n.t('codeReviewer.reviewDetail.cancelTitle'),
      message: i18n.t('codeReviewer.reviewDetail.cancelMessage'),
      confirmLabel: i18n.t('codeReviewer.reviewDetail.cancelReview'),
      cancelLabel: i18n.t('common.keepRunning'),
      onConfirm,
    });
  }

  function requestRetry() {
    if (retryInFlight.current) {
      return;
    }
    retryInFlight.current = true;
    retriggerReview.mutate(
      { reviewId },
      {
        onSuccess: () => {
          notificationHaptic(Haptics.NotificationFeedbackType.Success);
        },
        onSettled: () => {
          retryInFlight.current = false;
        },
      }
    );
  }

  if (isLoading) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('codeReviewer.reviewDetail.title')} />
        <TabScreenScrollView className="flex-1" contentContainerClassName="px-6 pt-4">
          <Animated.View exiting={FadeOut.duration(150)} className="gap-3">
            <Skeleton className="h-14 w-full rounded-lg" />
            <Skeleton className="h-40 w-full rounded-lg" />
          </Animated.View>
        </TabScreenScrollView>
        {dialog}
      </View>
    );
  }

  // A thrown NOT_FOUND/FORBIDDEN/UNAUTHORIZED can never be fixed by retrying —
  // show a plain message with no "Retry" affordance. UNAUTHORIZED is what
  // org-scoped reviews throw via ensureOrganizationAccess, so it needs the same
  // permanent classification as FORBIDDEN. Any other thrown error (or a resolved
  // `success: false`, the router's generic-failure shape) is transient.
  if (!data || !data.success) {
    const errorCode = isError ? error.data?.code : undefined;
    if (errorCode === 'NOT_FOUND' || errorCode === 'FORBIDDEN' || errorCode === 'UNAUTHORIZED') {
      return (
        <View className="flex-1 bg-background">
          <ScreenHeader title={t('codeReviewer.reviewDetail.title')} />
          <QueryError variant={errorCode === 'NOT_FOUND' ? 'not-found' : 'permission'} />
          {dialog}
        </View>
      );
    }
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('codeReviewer.reviewDetail.title')} />
        <QueryError
          variant={trpcErrorVariant(error)}
          title={t('codeReviewer.reviewDetail.couldNotLoad')}
          onRetry={() => void refetch()}
          isRetrying={isFetching}
        />
        {dialog}
      </View>
    );
  }

  const { review, tokenUsage } = data;
  const meta = statusMeta(review.status);
  const canCancel = isCancellableReviewStatus(review.status);
  const retryAction = isRetriggerableReviewStatus(review.status)
    ? selectRetryAction({
        hasManualConfig: review.manual_config != null,
        configPending: configQueryEnabled && reviewConfig.isPending,
        config: configQueryEnabled ? reviewConfig.data : undefined,
      })
    : null;

  const allFindings = flattenCouncilFindings(review.council_result);
  const visibleFindings = allFindings.slice(0, visibleCount);
  const hasMoreFindings = visibleCount < allFindings.length;
  // Legacy rows may carry a `manual_config` without `agentConfig` (the strict
  // `ManualCodeReviewConfigSchema` documents this malformed shape), so read the
  // threshold defensively instead of crashing on the missing inner object.
  const gateThreshold = (
    review.manual_config as { agentConfig?: { gate_threshold?: string } } | null
  )?.agentConfig?.gate_threshold;
  // A cancelled or interrupted row explains its outcome in the reader's own
  // words; only a failure or an unmapped diagnostic keeps the raw message.
  const cancellationLabel = reviewCancellationLabel(t, {
    status: review.status,
    errorMessage: review.error_message,
    terminalReason: review.terminal_reason,
    platformLabel: reviewerPlatformLabel(review.platform),
  });
  // The single message the conclusion block renders: the cancellation sentence,
  // the failure copy, or a diagnostic we have no copy for.
  const reviewMessage =
    cancellationLabel ??
    (review.status === 'failed'
      ? reviewFailureLabel(t, review.error_message, review.terminal_reason)
      : review.error_message);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('codeReviewer.reviewDetail.title')} eyebrow={review.repo_full_name} />
      <ReviewSpectatorSheet
        key={reviewId}
        visible={transcriptReviewId === reviewId}
        onClose={() => {
          setTranscriptReviewId(null);
        }}
        reviewId={reviewId}
        status={review.status}
        prTitle={review.pr_title}
        statusLabel={meta.label}
      />
      <TabScreenScrollView className="flex-1" contentContainerClassName="px-6 gap-4 pt-4">
        {/* The transcript entry is the first row of the content, not a pinned band
            above the list: a fixed trigger between the header and the scroll view
            leaves a strip where a vertical drag never reaches the content. */}
        <Button
          variant="secondary"
          accessibilityLabel={t('agentChat.session.transcriptAccessibility')}
          onPress={() => {
            setTranscriptReviewId(reviewId);
          }}
        >
          <Text>{t('agentChat.session.transcriptAccessibility')}</Text>
        </Button>

        {/* A background poll failure must not blank out an already-loaded review. */}
        {isError && (
          <Text variant="muted" className="text-center text-xs">
            {t('codeReviewer.reviewDetail.couldNotGetLatest')}
          </Text>
        )}

        <Animated.View entering={FadeIn.duration(200)} className="gap-1">
          <Text className="text-base font-medium">{review.pr_title}</Text>
          <Text variant="muted" className="text-xs">
            {t('codeReviewer.reviewDetail.byline', {
              repo: review.repo_full_name,
              number: review.pr_number,
              author: review.pr_author,
            })}
          </Text>
        </Animated.View>

        {/* Conclusion: the outcome leads — status first, then the reason. */}
        <View className="gap-2">
          <Text className={cn('text-sm font-semibold', meta.className)}>{meta.label}</Text>
          {reviewMessage ? (
            <View
              className={cn(
                'rounded-lg p-3',
                cancellationLabel ? 'bg-secondary' : 'bg-danger-tile-bg'
              )}
            >
              <Text
                variant={cancellationLabel ? 'muted' : undefined}
                className={cn('text-xs', !cancellationLabel && 'text-destructive')}
                numberOfLines={4}
              >
                {reviewMessage}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Findings: flattened from the council result, paginated in memory. */}
        <View className="gap-2">
          <Text className="text-sm font-medium">{t('common.findings')}</Text>
          {visibleFindings.length === 0 ? (
            <Text variant="muted" className="text-xs">
              {t(findingsEmptyCopyKey(review.status))}
            </Text>
          ) : (
            <View className="gap-2">
              {visibleFindings.map((finding, index) => (
                <FindingCard key={index} finding={finding} />
              ))}
              {hasMoreFindings ? (
                <Button
                  variant="secondary"
                  onPress={() => {
                    setVisibleCount(count => count + FINDINGS_PAGE_SIZE);
                  }}
                >
                  <Text>{t('codeReviewer.reviewDetail.showMore')}</Text>
                </Button>
              ) : null}
            </View>
          )}
        </View>

        {/* Council: decision plus specialist names/votes as text. */}
        {review.council_result ? <CouncilSection councilResult={review.council_result} /> : null}

        {/* Gate: check-run presence, review status, and threshold when set. */}
        <GateSection
          checkRunId={review.check_run_id}
          checkRunRedacted={review.rawIdsRedacted}
          statusLabel={meta.label}
          gateThreshold={gateThreshold}
        />

        {/* Metadata: technical details after the outcome. */}
        <View className="gap-2">
          <Text className="text-sm font-medium">{t('common.details')}</Text>
          <View className="gap-1 rounded-lg bg-secondary p-4">
            <MetaRow label={t('common.branch')} value={`${review.head_ref} → ${review.base_ref}`} />
            <MetaRow label={t('common.platform')} value={reviewerPlatformLabel(review.platform)} />
            {review.model ? <MetaRow label={t('common.model')} value={review.model} /> : null}
            <MetaRow
              label={t('codeReviewer.reviewDetail.created')}
              value={timeAgo(parseTimestamp(review.created_at), undefined, now)}
            />
            {review.started_at ? (
              <MetaRow
                label={t('codeReviewer.reviewDetail.started')}
                value={timeAgo(parseTimestamp(review.started_at), undefined, now)}
              />
            ) : null}
            {review.completed_at ? (
              <MetaRow
                label={t(
                  review.status === 'completed'
                    ? 'common.completed'
                    : 'codeReviewer.reviewDetail.reviewEnded'
                )}
                value={timeAgo(parseTimestamp(review.completed_at), undefined, now)}
              />
            ) : null}
            {review.total_cost_musd != null && review.total_cost_musd > 0 ? (
              <MetaRow
                label={t('common.cost')}
                value={formatMoney(fromMicrodollars(review.total_cost_musd), i18n.language)}
              />
            ) : null}
            {tokenUsage.input > 0 || tokenUsage.output > 0 ? (
              <MetaRow
                label={t('codeReviewer.reviewDetail.tokens')}
                value={t('codeReviewer.reviewDetail.tokensInOut', {
                  input: formatNumber(tokenUsage.input, i18n.language),
                  output: formatNumber(tokenUsage.output, i18n.language),
                })}
              />
            ) : null}
          </View>
        </View>

        {/* Actions. */}
        <View className="gap-3">
          <Button
            variant="secondary"
            onPress={() => {
              if (isPersonal(scope)) {
                const destination = resolveCodeReviewerOpenPrDestination(review.pr_url);
                if (destination.kind === 'in-app') {
                  pushOnce(destination.href);
                  return;
                }
              }
              void openExternalUrl(review.pr_url, {
                label: t('common.pullRequest'),
              });
            }}
          >
            {/* i18n-dup-ok: agentChat.prBadge.open names a pull request's open state;
                this key is the verb CTA — cs/pl/be translate the two apart. */}
            <Text>{t('common.openPullRequest')}</Text>
          </Button>

          {canCancel ? (
            <Button
              variant="destructive"
              disabled={cancelReview.isPending}
              onPress={() => {
                confirmCancel(() => {
                  cancelReview.mutate(
                    { reviewId },
                    {
                      onSuccess: () => {
                        notificationHaptic(Haptics.NotificationFeedbackType.Warning);
                      },
                    }
                  );
                });
              }}
            >
              <Text>{t('codeReviewer.reviewDetail.cancelReview')}</Text>
            </Button>
          ) : null}

          {retryAction === 'retry' ? (
            <Button
              variant="secondary"
              loading={retriggerReview.isPending}
              disabled={retriggerReview.isPending}
              onPress={() => {
                if (retriggerReview.isPending) {
                  return;
                }
                confirmRetry(requestRetry);
              }}
            >
              <Text>{t('codeReviewer.reviewDetail.retryReview')}</Text>
            </Button>
          ) : null}

          {retryAction === 'fix-settings' ? (
            <View className="gap-2">
              <Text variant="muted" className="text-xs">
                {t('codeReviewer.reviewDetail.retryNeedsSettings')}
              </Text>
              <Button
                variant="secondary"
                onPress={() => {
                  pushOnce(`/(app)/code-reviewer/${scope}/${review.platform}` as Href);
                }}
              >
                <Text>{t('codeReviewer.reviewDetail.fixSettings')}</Text>
              </Button>
            </View>
          ) : null}
        </View>
      </TabScreenScrollView>
      {dialog}
    </View>
  );
}
