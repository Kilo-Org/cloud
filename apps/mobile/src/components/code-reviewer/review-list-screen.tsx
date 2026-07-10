import { type Href, useRouter } from 'expo-router';
import { GitPullRequest } from 'lucide-react-native';
import { Pressable, ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import {
  CODE_REVIEW_STATUS_LABELS,
  type CodeReviewStatus,
  isCodeReviewStatus,
} from '@kilocode/app-shared/code-review';
import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useReviewList } from '@/lib/hooks/use-code-reviews';
import { cn, parseTimestamp, timeAgo } from '@/lib/utils';

// Tone classes stay mobile-local; labels come from the shared
// CODE_REVIEW_STATUS_LABELS map so they can't drift from web's copy.
const STATUS_CLASSNAME: Record<CodeReviewStatus, string> = {
  pending: 'text-muted-foreground',
  queued: 'text-muted-foreground',
  running: 'text-blue-600 dark:text-blue-400',
  completed: 'text-green-600 dark:text-green-400',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
  interrupted: 'text-amber-600 dark:text-amber-400',
};

type ReviewListData = NonNullable<ReturnType<typeof useReviewList>['data']>;
type Review = Extract<ReviewListData, { success: true }>['reviews'][number];

export function statusMeta(status: string): { label: string; className: string } {
  if (!isCodeReviewStatus(status)) {
    return { label: status, className: 'text-muted-foreground' };
  }
  return { label: CODE_REVIEW_STATUS_LABELS[status], className: STATUS_CLASSNAME[status] };
}

function reviewTime(review: Review): Date {
  return parseTimestamp(review.completed_at ?? review.started_at ?? review.created_at);
}

export function ReviewListScreen({ scope }: Readonly<{ scope: string }>) {
  const router = useRouter();
  const { data, isLoading, isError, error, refetch } = useReviewList(scope);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Recent Reviews" eyebrow="Code Reviewer" />
      <ScrollView className="flex-1 px-6" contentContainerClassName="pt-4 pb-8">
        <Animated.View layout={LinearTransition}>
          {isLoading && (
            <Animated.View exiting={FadeOut.duration(150)} className="gap-3">
              <Skeleton className="h-20 w-full rounded-lg" />
              <Skeleton className="h-20 w-full rounded-lg" />
              <Skeleton className="h-20 w-full rounded-lg" />
            </Animated.View>
          )}

          {/* Only a full-screen error when there's no usable data yet — a transient
              background poll failure with stale data should keep showing that data,
              not hide it behind a retry banner. */}
          {!isLoading && isError && !data && (
            <Pressable
              className="rounded-lg bg-secondary p-3 active:opacity-70"
              onPress={() => {
                void refetch();
              }}
            >
              <Text className="text-sm text-destructive">{error.message}. Tap to retry.</Text>
            </Pressable>
          )}

          {!isLoading && data && !data.success && (
            <Pressable
              className="rounded-lg bg-secondary p-3 active:opacity-70"
              onPress={() => {
                void refetch();
              }}
            >
              <Text className="text-sm text-destructive">{data.error}. Tap to retry.</Text>
            </Pressable>
          )}

          {!isLoading && data?.success && data.reviews.length === 0 && (
            <EmptyState
              icon={GitPullRequest}
              title="No reviews yet"
              description="Reviews appear here once the Code Reviewer runs on a pull request."
              className="pt-12"
            />
          )}

          {!isLoading && data?.success && data.reviews.length > 0 && (
            // no pagination, limit 50 — add offset paging if lists outgrow it
            <Animated.View entering={FadeIn.duration(200)}>
              {data.reviews.map((review, index) => {
                const meta = statusMeta(review.status);
                return (
                  <Pressable
                    key={review.id}
                    className={cn(
                      'py-3 active:opacity-70',
                      index < data.reviews.length - 1 && 'border-b-[0.5px] border-hair-soft'
                    )}
                    onPress={() => {
                      router.push(
                        `/(app)/(tabs)/(3_profile)/code-reviewer/${scope}/reviews/${review.id}` as Href
                      );
                    }}
                  >
                    <Text className="text-sm font-medium" numberOfLines={1}>
                      {review.pr_title}
                    </Text>
                    <Text variant="muted" className="mt-0.5 text-xs">
                      {review.repo_full_name} #{review.pr_number}
                    </Text>
                    <View className="mt-1 flex-row items-center gap-2">
                      <Text className={cn('text-xs', meta.className)}>{meta.label}</Text>
                      <Text variant="muted" className="text-xs">
                        {timeAgo(reviewTime(review))}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </Animated.View>
          )}
        </Animated.View>
      </ScrollView>
    </View>
  );
}
