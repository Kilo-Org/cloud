import * as Haptics from 'expo-haptics';
import { Alert, Linking, Pressable, ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import {
  isCancellableReviewStatus,
  isRetriggerableReviewStatus,
} from '@kilocode/app-shared/code-review';
import { statusMeta } from '@/components/code-reviewer/review-list-screen';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useCancelReview, useRetriggerReview, useReviewDetail } from '@/lib/hooks/use-code-reviews';
import { cn, parseTimestamp, timeAgo } from '@/lib/utils';

function MetaRow({
  label,
  value,
  valueClassName,
}: Readonly<{ label: string; value: string; valueClassName?: string }>) {
  return (
    <View className="flex-row items-center justify-between py-1">
      <Text variant="muted" className="text-xs">
        {label}
      </Text>
      <Text className={cn('text-xs', valueClassName)}>{value}</Text>
    </View>
  );
}

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
  const { data, isLoading, isError, error, refetch } = useReviewDetail(reviewId);
  const cancelReview = useCancelReview(scope);
  const retriggerReview = useRetriggerReview(scope);

  if (isError) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Review" />
        <ScrollView className="flex-1 px-6" contentContainerClassName="pt-4 pb-8">
          <Pressable
            className="rounded-lg bg-secondary p-3 active:opacity-70"
            onPress={() => {
              void refetch();
            }}
          >
            <Text className="text-sm text-destructive">{error.message}. Tap to retry.</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  if (isLoading || !data) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Review" />
        <ScrollView className="flex-1 px-6" contentContainerClassName="pt-4 pb-8">
          <Animated.View exiting={FadeOut.duration(150)} className="gap-3">
            <Skeleton className="h-14 w-full rounded-lg" />
            <Skeleton className="h-40 w-full rounded-lg" />
          </Animated.View>
        </ScrollView>
      </View>
    );
  }

  if (!data.success) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Review" />
        <ScrollView className="flex-1 px-6" contentContainerClassName="pt-4 pb-8">
          <Pressable
            className="rounded-lg bg-secondary p-3 active:opacity-70"
            onPress={() => {
              void refetch();
            }}
          >
            <Text className="text-sm text-destructive">{data.error}. Tap to retry.</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  const { review, tokenUsage } = data;
  const meta = statusMeta(review.status);
  const canCancel = isCancellableReviewStatus(review.status);
  const canRetry = isRetriggerableReviewStatus(review.status);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Review" eyebrow={review.repo_full_name} />
      <ScrollView className="flex-1 px-6" contentContainerClassName="gap-4 pt-4 pb-8">
        <Animated.View entering={FadeIn.duration(200)} className="gap-1">
          <Text className="text-base font-medium">{review.pr_title}</Text>
          <Text variant="muted" className="text-xs">
            {review.repo_full_name} #{review.pr_number} by {review.pr_author}
          </Text>
          <Text className={cn('text-xs', meta.className)}>{meta.label}</Text>
        </Animated.View>

        <View className="gap-1 rounded-lg bg-secondary p-4">
          <MetaRow label="Branch" value={`${review.head_ref} → ${review.base_ref}`} />
          <MetaRow label="Platform" value={review.platform} valueClassName="capitalize" />
          {review.model ? <MetaRow label="Model" value={review.model} /> : null}
          <MetaRow label="Created" value={timeAgo(parseTimestamp(review.created_at))} />
          {review.started_at ? (
            <MetaRow label="Started" value={timeAgo(parseTimestamp(review.started_at))} />
          ) : null}
          {review.completed_at ? (
            <MetaRow label="Completed" value={timeAgo(parseTimestamp(review.completed_at))} />
          ) : null}
          {review.total_cost_musd != null && review.total_cost_musd > 0 ? (
            <MetaRow label="Cost" value={`$${(review.total_cost_musd / 1e6).toFixed(2)}`} />
          ) : null}
          {tokenUsage.input > 0 || tokenUsage.output > 0 ? (
            <MetaRow label="Tokens" value={`${tokenUsage.input} in / ${tokenUsage.output} out`} />
          ) : null}
        </View>

        {review.error_message ? (
          <View className="rounded-lg bg-red-100 p-3 dark:bg-red-950">
            <Text className="text-xs text-destructive">{review.error_message}</Text>
          </View>
        ) : null}

        <View className="gap-3">
          <Button
            variant="secondary"
            onPress={() => {
              void Linking.openURL(review.pr_url);
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
      </ScrollView>
    </View>
  );
}
