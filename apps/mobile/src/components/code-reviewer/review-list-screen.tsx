import { type Href, useRouter } from 'expo-router';
import { GitPullRequest } from '@/components/ui/icons';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { type CodeReviewStatus, isCodeReviewStatus } from '@kilocode/app-shared/code-review';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { i18n } from '@/i18n';
import { useGitHubStatus, useGitLabStatus } from '@/lib/hooks/use-code-reviewer';
import { useReviewList } from '@/lib/hooks/use-code-reviews';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { cn, parseTimestamp, timeAgo } from '@/lib/utils';

// Tone classes stay mobile-local; the label is the translated catalog key
// for the same stable status code web reads, so it can't drift from web.
const STATUS_CLASSNAME = {
  pending: 'text-muted-foreground',
  queued: 'text-muted-foreground',
  running: 'text-info',
  completed: 'text-good',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
  interrupted: 'text-warn',
} satisfies Record<CodeReviewStatus, string>;

const STATUS_KEY = {
  pending: 'codeReviewer.status.pending',
  queued: 'common.queued',
  running: 'codeReviewer.status.running',
  completed: 'codeReviewer.status.completed',
  failed: 'codeReviewer.status.failed',
  cancelled: 'common.cancelled',
  interrupted: 'codeReviewer.status.interrupted',
} satisfies Record<CodeReviewStatus, string>;

type ReviewListData = NonNullable<ReturnType<typeof useReviewList>['data']>;
type Review = Extract<ReviewListData, { success: true }>['reviews'][number];

export function statusMeta(status: string) {
  if (!isCodeReviewStatus(status)) {
    return { label: status, className: 'text-muted-foreground' };
  }
  return {
    label: i18n.t(STATUS_KEY[status]),
    className: STATUS_CLASSNAME[status],
  };
}

function reviewTime(review: Review): Date {
  return parseTimestamp(review.completed_at ?? review.started_at ?? review.created_at);
}

export function ReviewListScreen({ scope }: Readonly<{ scope: string }>) {
  const router = useRouter();
  const { t } = useTranslation();
  const { data, isLoading, isError, isFetching, error, refetch } = useReviewList(scope);
  useRouteForegroundRefresh([[['codeReviews']]]);
  const githubStatus = useGitHubStatus(scope);
  const gitlabStatus = useGitLabStatus(scope);
  const hasConnectedProvider =
    githubStatus.data?.connected === true || gitlabStatus.data?.connected === true;

  // A thrown NOT_FOUND/FORBIDDEN/UNAUTHORIZED can't be fixed by retrying — mirror
  // the review-detail screen and show a permanent state with no retry. Any other
  // thrown error (or the resolved success:false shape below) stays transient.
  const errorCode = isError ? error.data?.code : undefined;
  const isPermanentError =
    errorCode === 'NOT_FOUND' || errorCode === 'FORBIDDEN' || errorCode === 'UNAUTHORIZED';
  let errorVariant: 'server' | 'not-found' | 'permission' = 'server';
  if (isPermanentError) {
    errorVariant = errorCode === 'NOT_FOUND' ? 'not-found' : 'permission';
  }

  let body: ReactNode = null;
  if (!isLoading && data?.success && data.reviews.length === 0) {
    body = (
      <EmptyState
        icon={GitPullRequest}
        title={t('codeReviewer.reviewList.noReviews')}
        description={t('codeReviewer.reviewList.noReviewsDescription')}
        action={
          <Button
            onPress={() => {
              router.push(
                (hasConnectedProvider
                  ? `/(app)/(tabs)/(3_profile)/code-reviewer/${scope}/manual-review`
                  : `/(app)/(tabs)/(3_profile)/code-reviewer/${scope}`) as Href
              );
            }}
          >
            <Text>
              {hasConnectedProvider
                ? t('codeReviewer.reviewList.startManualReview')
                : t('codeReviewer.reviewList.configureProvider')}
            </Text>
          </Button>
        }
      />
    );
  } else if (!isLoading && ((isError && !data) || (data && !data.success))) {
    body = (
      <QueryError
        variant={!data ? errorVariant : 'server'}
        title={!data && isPermanentError ? undefined : t('codeReviewer.reviewList.couldNotLoad')}
        onRetry={!data && isPermanentError ? undefined : () => void refetch()}
        isRetrying={isFetching}
      />
    );
  } else {
    body = (
      <TabScreenScrollView className="flex-1" contentContainerClassName="px-6 pt-4">
        <Animated.View layout={LinearTransition}>
          {isLoading && (
            <Animated.View exiting={FadeOut.duration(150)} className="gap-3">
              <Skeleton className="h-20 w-full rounded-lg" />
              <Skeleton className="h-20 w-full rounded-lg" />
              <Skeleton className="h-20 w-full rounded-lg" />
            </Animated.View>
          )}

          {!isLoading && data?.success && data.reviews.length > 0 && (
            // no pagination, limit 50 — add offset paging if lists outgrow it
            <Animated.View entering={FadeIn.duration(200)}>
              {data.reviews.map((review, index) => {
                const meta = statusMeta(review.status);
                return (
                  <Pressable
                    key={review.id}
                    accessibilityRole="button"
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
      </TabScreenScrollView>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('codeReviewer.reviewList.title')} eyebrow={t('common.codeReviewer')} />
      {body}
    </View>
  );
}
