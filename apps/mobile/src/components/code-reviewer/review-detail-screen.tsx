/* eslint-disable max-lines -- the screen keeps every existing detail section plus the read-only transcript slot */

import * as Haptics from 'expo-haptics';
import { notificationHaptic } from '@/lib/haptics';
import { type Href } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { canRetriggerReview, isCancellableReviewStatus } from '@kilocode/app-shared/code-review';
import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { statusMeta } from '@/components/code-reviewer/review-list-rows';
import {
  findingsEmptyCopyKey,
  flattenCouncilFindings,
  reviewCancellationCopy,
  reviewFailureCopy,
  selectRetryAction,
} from '@/components/code-reviewer/review-detail-helpers';
import { ReviewSpectatorSheet } from '@/components/code-reviewer/review-spectator-sheet';
import { ReviewStatusBadge } from '@/components/code-reviewer/review-status-badge';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import {
  CouncilSection,
  FindingCard,
  GateSection,
} from '@/components/code-reviewer/review-detail-sections';
import { StateAction } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ReviewerHeader } from '@/components/code-reviewer/reviewer-header';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { Card } from '@/components/ui/card';
import { RotateCcw, Settings } from '@/components/ui/icons';
import { KvRow } from '@/components/ui/kv-row';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Section } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { i18n } from '@/i18n';
import { resolveCodeReviewerOpenPrDestination } from '@/lib/code-reviewer-open-pr-destination';
import { reviewerPlatformLabel } from '@/lib/code-reviewer-config';
import { openExternalUrl } from '@/lib/external-link';
import { formatNumber, formatPrefixedMoney } from '@/lib/format';
import { isPersonal, useReviewConfig } from '@/lib/hooks/use-code-reviewer';
import { useRelativeTimeNow } from '@/lib/hooks/use-now-ticker';
import { useCancelReview, useRetriggerReview, useReviewDetail } from '@/lib/hooks/use-code-reviews';
import { trpcErrorVariant } from '@/lib/trpc-error';
import { useTRPC } from '@/lib/trpc';
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
  // Only a retriggerable automatic review needs the reviewer config, and a
  // review a newer commit replaced can never be retried. Bitbucket is org-only,
  // and a personal Bitbucket query would throw in toPersonalPlatform.
  const reviewPlatform = loadedReview?.platform ?? 'github';
  const configQueryEnabled =
    loadedReview != null &&
    loadedReview.manual_config == null &&
    canRetriggerReview(loadedReview) &&
    !(isPersonal(scope) && reviewPlatform === 'bitbucket');
  const reviewConfig = useReviewConfig(scope, reviewPlatform, { enabled: configQueryEnabled });

  // The in-app pull-request reader is gated on the user's own GitHub
  // authorization, and a Code Reviewer user can own a review without one. The
  // read is the stored status, not a GitHub call. It is enabled from the same
  // URL-derived provider the button decides on, never the review row's column,
  // so a row whose column disagrees with its URL still decides on one source.
  const openPrDestination = useMemo(
    () => resolveCodeReviewerOpenPrDestination(loadedReview?.pr_url ?? ''),
    [loadedReview?.pr_url]
  );
  const needsGitHubAuthorization =
    isPersonal(scope) &&
    openPrDestination.kind === 'in-app' &&
    openPrDestination.platform === 'github';
  const trpc = useTRPC();
  const githubAuthorization = useQuery({
    ...trpc.githubApps.getUserAuthorization.queryOptions(),
    enabled: needsGitHubAuthorization,
  });

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

  // One header for every state. The subtitle is the review's repository, which
  // only the payload knows, so its line stays reserved in every state. While the
  // read is pending the placeholder bar paints over it, because the name is on
  // its way; after the read stopped the line stays blank so the title keeps its
  // place without an animation: a retry re-enters the loading state on that
  // line, so neither the failure nor the retry moves the title.
  const header = (
    <ReviewerHeader
      title={t('codeReviewer.reviewDetail.title')}
      subtitle={loadedReview?.repo_full_name}
      reserveSubtitle
      subtitlePlaceholder={
        !loadedReview && isLoading ? <Skeleton className="h-3.5 w-28 rounded-full" /> : undefined
      }
      // The outcome word rides the title line, the way the list row and the web
      // detail page both state it, so no block in the body has to label it.
      titleAccessory={loadedReview ? <ReviewStatusBadge status={loadedReview.status} /> : undefined}
    />
  );

  if (isLoading) {
    return (
      <View className="flex-1 bg-background">
        {header}
        <TabScreenScrollView className="flex-1" contentContainerClassName={SCREEN_BODY_CLASS}>
          <Animated.View exiting={FadeOut.duration(150)} className="gap-3">
            <RowSkeleton subtitle />
            <RowSkeleton subtitle />
            <RowSkeleton subtitle />
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
          {header}
          <QueryError variant={errorCode === 'NOT_FOUND' ? 'not-found' : 'permission'} />
          {dialog}
        </View>
      );
    }
    return (
      <View className="flex-1 bg-background">
        {header}
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
  const retryAction = canRetriggerReview(review)
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
  const cancellationCopy = reviewCancellationCopy(t, {
    status: review.status,
    errorMessage: review.error_message,
    terminalReason: review.terminal_reason,
    platformLabel: reviewerPlatformLabel(review.platform),
  });
  const cancellationLabel = cancellationCopy?.message;
  // The single message the conclusion block renders: the cancellation sentence,
  // the failure copy, or a diagnostic we have no copy for. `namesRecovery` says
  // whether that sentence already ends with its own next step, so the card never
  // prints a second instruction under it. Only the sentences that carry their own
  // instruction set it; a raw diagnostic and a missing sentence name nothing, so
  // they get the caller's own line.
  const failureCopy =
    review.status === 'failed'
      ? reviewFailureCopy(t, review.error_message, review.terminal_reason)
      : undefined;
  const reviewMessage = cancellationLabel ?? failureCopy?.message ?? review.error_message;
  const messageNamesRecovery =
    cancellationCopy?.namesRecovery === true || failureCopy?.namesRecovery === true;

  return (
    <View className="flex-1 bg-background">
      {header}
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
      <TabScreenScrollView className="flex-1" contentContainerClassName={SCREEN_BODY_CLASS}>
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
              number: review.pr_number,
              author: review.pr_author,
            })}
          </Text>
          {/* The conclusion's reason belongs to the title it describes. As its
              own block at the body's section gap it floated equidistant from
              the PR title above it and FINDINGS below. The outcome word rides
              the header's badge, so this block carries only the reason. */}
          {reviewMessage || retryAction ? (
            // A failure keeps the danger tile under it: the red ink alone on
            // the card surface read as ordinary copy, and the tint is the
            // palette's own danger token, not a hand-built card fill. The tint
            // belongs to that sentence, so a card that carries only a recovery
            // control (a terminal review with no stored explanation) stays
            // neutral instead of dressing a way out as a failure.
            //
            // The sentence and its way out are one block: nothing below the
            // fold is the only exit. A failed review's recovery control sits
            // under its own explanation, at the card's gap-3, so the person
            // reads why it failed and what they can do without leaving the
            // conclusion. A retry opens the same confirmation as before; the
            // other way out is the settings link when the server would refuse a
            // retry. `namesRecovery` raises the settings line only when the
            // sentence above does not already say it.
            <Card
              className={cn('mt-2', reviewMessage && !cancellationLabel && 'bg-danger-tile-bg')}
            >
              {reviewMessage ? (
                <Text
                  variant={cancellationLabel ? 'muted' : undefined}
                  className={cn('text-xs', !cancellationLabel && 'text-destructive')}
                  numberOfLines={4}
                >
                  {reviewMessage}
                </Text>
              ) : null}
              {retryAction === 'retry' ? (
                <View className="self-start">
                  <StateAction
                    testID="review-detail-retry"
                    label={t('codeReviewer.reviewDetail.retryReview')}
                    icon={RotateCcw}
                    loading={retriggerReview.isPending}
                    onPress={() => {
                      if (retriggerReview.isPending) {
                        return;
                      }
                      confirmRetry(requestRetry);
                    }}
                  />
                </View>
              ) : null}
              {retryAction === 'fix-settings' ? (
                <>
                  {messageNamesRecovery ? null : (
                    <Text variant="muted" className="text-xs">
                      {t('codeReviewer.reviewDetail.retryNeedsSettings')}
                    </Text>
                  )}
                  <View className="self-start">
                    <StateAction
                      testID="review-detail-fix-settings"
                      label={t('codeReviewer.reviewDetail.fixSettings')}
                      icon={Settings}
                      onPress={() => {
                        pushOnce(`/(app)/code-reviewer/${scope}/${review.platform}` as Href);
                      }}
                    />
                  </View>
                </>
              ) : null}
              {/* A superseded review has no head to re-review and a review still
                  loading its config is not known to be retryable, so both get no
                  control here: the sentence above makes no promise to keep. */}
            </Card>
          ) : null}
        </Animated.View>

        {/* Findings: flattened from the council result, paginated in memory. */}
        <Section label={t('common.findings')}>
          {visibleFindings.length === 0 ? (
            // The empty result sits in the same card as every other section's
            // body, so an ended review reads as a filled section, not a caption.
            // Its line takes the muted body size the GATE card's rows read at.
            <Card>
              <Text variant="muted">{t(findingsEmptyCopyKey(review.status))}</Text>
            </Card>
          ) : (
            <View className="gap-3">
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
        </Section>

        {/* Council: decision plus specialist names/votes as text. */}
        {review.council_result ? <CouncilSection councilResult={review.council_result} /> : null}

        {/* Gate: check-run presence and threshold when set. The review status is
            the conclusion above, so the card never repeats it. */}
        <GateSection
          checkRunId={review.check_run_id}
          checkRunRedacted={review.rawIdsRedacted}
          gateThreshold={gateThreshold}
        />

        {/* Metadata: technical details after the outcome. */}
        <Section label={t('common.details')}>
          {/* One row height for every key/value row on this screen, the
              shared one: the gate's check run and the council's votes above
              stand at this same pitch. */}
          <RowGroup>
            <KvRow label={t('common.branch')} value={`${review.head_ref} → ${review.base_ref}`} />
            <KvRow
              label={t('common.platform')}
              value={reviewerPlatformLabel(review.platform)}
              valueFace="text"
            />
            {review.model ? <KvRow label={t('common.model')} value={review.model} /> : null}
            <KvRow
              label={t('codeReviewer.reviewDetail.created')}
              value={timeAgo(parseTimestamp(review.created_at), undefined, now)}
              valueFace="text"
            />
            {review.started_at ? (
              <KvRow
                label={t('codeReviewer.reviewDetail.started')}
                value={timeAgo(parseTimestamp(review.started_at), undefined, now)}
                valueFace="text"
              />
            ) : null}
            {review.completed_at ? (
              <KvRow
                label={t(
                  review.status === 'completed'
                    ? 'common.completed'
                    : 'codeReviewer.reviewDetail.reviewEnded'
                )}
                value={timeAgo(parseTimestamp(review.completed_at), undefined, now)}
                valueFace="text"
              />
            ) : null}
            {review.total_cost_musd != null && review.total_cost_musd > 0 ? (
              <KvRow
                label={t('common.cost')}
                value={formatPrefixedMoney(fromMicrodollars(review.total_cost_musd), i18n.language)}
                valueFace="text"
              />
            ) : null}
            {tokenUsage.input > 0 || tokenUsage.output > 0 ? (
              <KvRow
                label={t('codeReviewer.reviewDetail.tokens')}
                value={t('codeReviewer.reviewDetail.tokensInOut', {
                  input: formatNumber(tokenUsage.input, i18n.language),
                  output: formatNumber(tokenUsage.output, i18n.language),
                })}
                valueFace="text"
              />
            ) : null}
          </RowGroup>
        </Section>

        {/* Actions. The pull request is the screen's primary action, so it takes
            the filled primary style; every other action stays secondary. */}
        <View className="gap-3">
          <Button
            onPress={() => {
              // A github.com pull request reads in the app only with the user's
              // own GitHub authorization; without it that route is the Connect
              // wall, so the pull request opens in the browser instead. A
              // pending or failed read keeps that fallback. Other providers
              // keep their in-app route, whose own gate owns their connection.
              if (
                isPersonal(scope) &&
                openPrDestination.kind === 'in-app' &&
                (!needsGitHubAuthorization || githubAuthorization.data?.connected === true)
              ) {
                pushOnce(openPrDestination.href);
                return;
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

          {/* The transcript is a secondary way to read the same review, so it
              sits beside the primary action and never above the title. */}
          <Button
            variant="outline"
            accessibilityLabel={t('agentChat.session.transcriptAccessibility')}
            onPress={() => {
              setTranscriptReviewId(reviewId);
            }}
          >
            <Text>{t('agentChat.session.transcriptAccessibility')}</Text>
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
          {/* The retry and settings links live in the conclusion card above, so
              this block keeps only the actions that are not a failure's way out. */}
        </View>
      </TabScreenScrollView>
      {dialog}
    </View>
  );
}
