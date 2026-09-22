import { type Href, useRouter } from 'expo-router';
import { GitPullRequest } from '@/components/ui/icons';
import { type ReactNode, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Pressable, View } from 'react-native';
import Animated, { FadeOut } from 'react-native-reanimated';

import { type CodeReviewStatus, isCodeReviewStatus } from '@kilocode/app-shared/code-review';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView, useTabBarBottomPadding } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { useGitHubStatus, useGitLabStatus } from '@/lib/hooks/use-code-reviewer';
import { useReviewList } from '@/lib/hooks/use-code-reviews';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { dedupeById } from '@/lib/query/dedupe-by-id';
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
  pending: 'common.pending',
  queued: 'common.queued',
  running: 'codeReviewer.status.running',
  completed: 'codeReviewer.status.completed',
  failed: 'common.failed',
  cancelled: 'common.cancelled',
  interrupted: 'codeReviewer.status.interrupted',
} satisfies Record<CodeReviewStatus, string>;

type Review = Extract<
  NonNullable<ReturnType<typeof useReviewList>['data']>['pages'][number],
  { success: true }
>['reviews'][number];

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

function ReviewListFooter({
  loading,
  error,
  onRetry,
}: Readonly<{ loading: boolean; error: boolean; onRetry: () => void }>) {
  const { t } = useTranslation();
  if (loading) {
    return <Skeleton className="h-20 w-full rounded-lg" />;
  }
  if (error) {
    return (
      <QueryError
        placement="top"
        message={t('codeReviewer.reviewList.couldNotLoad')}
        onRetry={onRetry}
      />
    );
  }
  return null;
}

export function ReviewListScreen({ scope }: Readonly<{ scope: string }>) {
  const router = useRouter();
  const { t } = useTranslation();
  const paddingBottom = useTabBarBottomPadding();
  const {
    data,
    isLoading,
    isError,
    isFetching,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
    error,
    refetch,
  } = useReviewList(scope);
  useRouteForegroundRefresh([[['codeReviews']]]);
  const githubStatus = useGitHubStatus(scope);
  const gitlabStatus = useGitLabStatus(scope);
  const hasConnectedProvider =
    githubStatus.data?.connected === true || gitlabStatus.data?.connected === true;

  const pages = data?.pages;
  const firstPage = pages?.[0];
  const reviews = useMemo(
    () => dedupeById(pages?.flatMap(page => (page.success ? page.reviews : [])) ?? []),
    [pages]
  );

  // A thrown NOT_FOUND/FORBIDDEN/UNAUTHORIZED can't be fixed by retrying — mirror
  // the review-detail screen and show a permanent state with no retry. Any other
  // thrown error (or the resolved success:false shape below) stays transient.
  const errorCode = isError
    ? (error as { data?: { code?: string } } | null)?.data?.code
    : undefined;
  const isPermanentError =
    errorCode === 'NOT_FOUND' || errorCode === 'FORBIDDEN' || errorCode === 'UNAUTHORIZED';
  let errorVariant: 'server' | 'not-found' | 'permission' = 'server';
  if (isPermanentError) {
    errorVariant = errorCode === 'NOT_FOUND' ? 'not-found' : 'permission';
  }

  let body: ReactNode = null;
  if (!isLoading && firstPage?.success && reviews.length === 0) {
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
  } else if (!isLoading && ((isError && !data) || (firstPage && !firstPage.success))) {
    body = (
      <QueryError
        variant={!data ? errorVariant : 'server'}
        title={!data && isPermanentError ? undefined : t('codeReviewer.reviewList.couldNotLoad')}
        onRetry={!data && isPermanentError ? undefined : () => void refetch()}
        isRetrying={isFetching}
      />
    );
  } else if (isLoading) {
    body = (
      <TabScreenScrollView className="flex-1" contentContainerClassName="px-6 pt-4">
        <Animated.View exiting={FadeOut.duration(150)} className="gap-3">
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </Animated.View>
      </TabScreenScrollView>
    );
  } else {
    body = (
      <FlatList
        data={reviews}
        keyExtractor={review => review.id}
        renderItem={({ item: review, index }) => {
          const meta = statusMeta(review.status);
          return (
            <Pressable
              accessibilityRole="button"
              className={cn(
                'py-3 active:opacity-70',
                index < reviews.length - 1 && 'border-b-[0.5px] border-hair-soft'
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
        }}
        contentContainerClassName="px-6 pt-4"
        onEndReached={() => {
          // Once the next page has failed, auto-loading re-fires on every
          // content-size change (the footer grows/shrinks as the fetch
          // flips between loading and error), so the retry footer never
          // settles and its Retry control is unreachable. Leave recovery to
          // the user's Retry tap until a fetch succeeds.
          if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) {
            void fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.5}
        ListFooterComponent={
          <>
            <ReviewListFooter
              loading={isFetchingNextPage}
              error={isFetchNextPageError}
              onRetry={() => void fetchNextPage()}
            />
            <View style={{ height: paddingBottom }} pointerEvents="none" />
          </>
        }
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('codeReviewer.reviewList.title')} eyebrow={t('common.codeReviewer')} />
      {body}
    </View>
  );
}
