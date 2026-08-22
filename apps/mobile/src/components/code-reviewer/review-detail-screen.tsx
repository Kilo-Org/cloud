import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import {
  isCancellableReviewStatus,
  isRetriggerableReviewStatus,
} from '@kilocode/app-shared/code-review';
import { formatDollars, fromMicrodollars } from '@kilocode/app-shared/utils';
import { statusMeta } from '@/components/code-reviewer/review-list-screen';
import { flattenCouncilFindings } from '@/components/code-reviewer/review-detail-helpers';
import {
  CouncilSection,
  FindingCard,
  GateSection,
  MetaRow,
} from '@/components/code-reviewer/review-detail-sections';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { FEATURE_FLAG_PR_REVIEW, useFeatureFlag } from '@/lib/analytics/posthog';
import { resolveCodeReviewerOpenPrDestination } from '@/lib/code-reviewer-open-pr-destination';
import { reviewerPlatformLabel } from '@/lib/code-reviewer-config';
import { openExternalUrl } from '@/lib/external-link';
import { useCancelReview, useRetriggerReview, useReviewDetail } from '@/lib/hooks/use-code-reviews';
import { getPrReviewPath } from '@/lib/profile-agent-navigation';
import { cn, parseTimestamp, timeAgo } from '@/lib/utils';

const FINDINGS_PAGE_SIZE = 20;

function confirmCancel(onConfirm: () => void) {
  Alert.alert('Cancel review?', 'This will stop the in-progress code review.', [
    { text: 'Keep running', style: 'cancel' },
    { text: 'Cancel review', style: 'destructive', onPress: onConfirm },
  ]);
}

function confirmRetry(onConfirm: () => void) {
  Alert.alert('Retry review?', 'This will re-run the code review.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Retry', onPress: onConfirm },
  ]);
}

export function ReviewDetailScreen({
  scope,
  reviewId,
}: Readonly<{ scope: string; reviewId: string }>) {
  const router = useRouter();
  const prReviewEnabled = useFeatureFlag(FEATURE_FLAG_PR_REVIEW, true);
  const { data, isLoading, isError, isFetching, error, refetch } = useReviewDetail(reviewId);
  const cancelReview = useCancelReview(scope);
  const retriggerReview = useRetriggerReview(scope);
  const [visibleCount, setVisibleCount] = useState(FINDINGS_PAGE_SIZE);

  if (isLoading) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Review" />
        <TabScreenScrollView className="flex-1 px-6" contentContainerClassName="pt-4">
          <Animated.View exiting={FadeOut.duration(150)} className="gap-3">
            <Skeleton className="h-14 w-full rounded-lg" />
            <Skeleton className="h-40 w-full rounded-lg" />
          </Animated.View>
        </TabScreenScrollView>
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
          <ScreenHeader title="Review" />
          <TabScreenScrollView className="flex-1 px-6" contentContainerClassName="flex-1 pt-4">
            <QueryError variant={errorCode === 'NOT_FOUND' ? 'not-found' : 'permission'} />
          </TabScreenScrollView>
        </View>
      );
    }
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Review" />
        <TabScreenScrollView className="flex-1 px-6" contentContainerClassName="flex-1 pt-4">
          <QueryError
            variant="server"
            title="Could not load review"
            onRetry={() => void refetch()}
            isRetrying={isFetching}
          />
        </TabScreenScrollView>
      </View>
    );
  }

  const { review, tokenUsage } = data;
  const meta = statusMeta(review.status);
  const canCancel = isCancellableReviewStatus(review.status);
  const canRetry = isRetriggerableReviewStatus(review.status);

  const allFindings = flattenCouncilFindings(review.council_result);
  const visibleFindings = allFindings.slice(0, visibleCount);
  const hasMoreFindings = visibleCount < allFindings.length;
  // Legacy rows may carry a `manual_config` without `agentConfig` (the strict
  // `ManualCodeReviewConfigSchema` documents this malformed shape), so read the
  // threshold defensively instead of crashing on the missing inner object.
  const gateThreshold = (
    review.manual_config as { agentConfig?: { gate_threshold?: string } } | null
  )?.agentConfig?.gate_threshold;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Review" eyebrow={review.repo_full_name} />
      <TabScreenScrollView className="flex-1 px-6" contentContainerClassName="gap-4 pt-4">
        {/* A background poll failure must not blank out an already-loaded review. */}
        {isError && (
          <Text variant="muted" className="text-center text-xs">
            Couldn't get the latest.
          </Text>
        )}

        <Animated.View entering={FadeIn.duration(200)} className="gap-1">
          <Text className="text-base font-medium">{review.pr_title}</Text>
          <Text variant="muted" className="text-xs">
            {review.repo_full_name} #{review.pr_number} by {review.pr_author}
          </Text>
        </Animated.View>

        {/* Conclusion: the outcome leads — status first, then the failure reason. */}
        <View className="gap-2">
          <Text className={cn('text-sm font-semibold', meta.className)}>{meta.label}</Text>
          {review.error_message ? (
            <View className="rounded-lg bg-danger-tile-bg p-3">
              <Text className="text-xs text-destructive">{review.error_message}</Text>
            </View>
          ) : null}
        </View>

        {/* Findings: flattened from the council result, paginated in memory. */}
        <View className="gap-2">
          <Text className="text-sm font-medium">Findings</Text>
          {visibleFindings.length === 0 ? (
            <Text variant="muted" className="text-xs">
              No findings
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
                  <Text>Show more</Text>
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
          <Text className="text-sm font-medium">Details</Text>
          <View className="gap-1 rounded-lg bg-secondary p-4">
            <MetaRow label="Branch" value={`${review.head_ref} → ${review.base_ref}`} />
            <MetaRow label="Platform" value={reviewerPlatformLabel(review.platform)} />
            {review.model ? <MetaRow label="Model" value={review.model} /> : null}
            <MetaRow label="Created" value={timeAgo(parseTimestamp(review.created_at))} />
            {review.started_at ? (
              <MetaRow label="Started" value={timeAgo(parseTimestamp(review.started_at))} />
            ) : null}
            {review.completed_at ? (
              <MetaRow label="Completed" value={timeAgo(parseTimestamp(review.completed_at))} />
            ) : null}
            {review.total_cost_musd != null && review.total_cost_musd > 0 ? (
              <MetaRow
                label="Cost"
                value={formatDollars(fromMicrodollars(review.total_cost_musd))}
              />
            ) : null}
            {tokenUsage.input > 0 || tokenUsage.output > 0 ? (
              <MetaRow label="Tokens" value={`${tokenUsage.input} in / ${tokenUsage.output} out`} />
            ) : null}
          </View>
        </View>

        {/* Actions. */}
        <View className="gap-3">
          <Button
            variant="secondary"
            onPress={() => {
              const destination = resolveCodeReviewerOpenPrDestination(
                review.pr_url,
                prReviewEnabled
              );
              if (destination.kind === 'in-app') {
                router.push(
                  getPrReviewPath(destination.owner, destination.repo, destination.number)
                );
                return;
              }
              void openExternalUrl(review.pr_url, { label: 'pull request' });
            }}
          >
            <Text>Open pull request</Text>
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
                        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                      },
                    }
                  );
                });
              }}
            >
              <Text>Cancel review</Text>
            </Button>
          ) : null}

          {canRetry ? (
            <Button
              variant="secondary"
              disabled={retriggerReview.isPending}
              onPress={() => {
                confirmRetry(() => {
                  retriggerReview.mutate(
                    { reviewId },
                    {
                      onSuccess: () => {
                        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                      },
                    }
                  );
                });
              }}
            >
              <Text>Retry review</Text>
            </Button>
          ) : null}
        </View>
      </TabScreenScrollView>
    </View>
  );
}
