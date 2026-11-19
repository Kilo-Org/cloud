import { type Href } from 'expo-router';
import { ArrowRight, GitPullRequest, Settings } from '@/components/ui/icons';
import { FlashList } from '@shopify/flash-list';
import { type ReactNode, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View, type ViewStyle } from 'react-native';
import Animated, { FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { EmptyState, StateAction } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ReviewerHeader } from '@/components/code-reviewer/reviewer-header';
import { ReviewListFooter, ReviewRow } from '@/components/code-reviewer/review-list-rows';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { RowSkeleton } from '@/components/ui/row-skeleton';

import { canConnectAnyProvider } from '@/lib/code-reviewer-status';
import { isPersonal } from '@/lib/code-reviewer-config';
import { useReviewerScopeTitle } from '@/lib/hooks/use-reviewer-scope-title';
import {
  useBitbucketReadiness,
  useGitHubStatus,
  useGitLabStatus,
} from '@/lib/hooks/use-code-reviewer';
import { useReviewList } from '@/lib/hooks/use-code-reviews';
import { queryBodyFailure, useQueryBodyState } from '@/lib/hooks/use-query-body-state';
import { useReviewerPermission } from '@/lib/hooks/use-reviewer-permission';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { useRelativeTimeNow } from '@/lib/hooks/use-now-ticker';
import { dedupeById } from '@/lib/query/dedupe-by-id';
import { isRetryableTrpcError, readTrpcErrorField, trpcErrorVariant } from '@/lib/trpc-error';

const listStyle = { flex: 1 } satisfies ViewStyle;

export function ReviewListScreen({ scope }: Readonly<{ scope: string }>) {
  const pushOnce = useSinglePushRoute();
  const { t } = useTranslation();
  const scopeTitle = useReviewerScopeTitle(scope);
  // The page-one probe refetches unchanged rows while a review is in flight, so
  // the row objects keep their identity and nothing re-renders. A shared minute
  // clock is the row's one changing input: it advances the relative label, and
  // it is the same instant the review's detail screen reads.
  const now = useRelativeTimeNow();
  const paddingBottom = useTabBarBottomPadding();
  const insets = useSafeAreaInsets();
  // One style for the whole content container: every row keeps the screen's own
  // side insets, and the rows draw the page gutter themselves.
  const listContentContainerStyle = useMemo<ViewStyle>(
    () => ({
      paddingLeft: insets.left,
      paddingRight: insets.right,
    }),
    [insets.left, insets.right]
  );
  const {
    data,
    isLoading,
    isError,
    isFetching,
    fetchStatus,
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
  // The manual-review action exists only for the platforms whose review it can
  // start, so the connected check behind that action stays GitHub and GitLab.
  const hasConnectedProvider =
    githubStatus.data?.connected === true || gitlabStatus.data?.connected === true;
  const bitbucketReadiness = useBitbucketReadiness(scope);
  // Any connected reviewer platform changes what the empty list says: Bitbucket
  // runs automatic reviews without offering a manual one, so a scope connected
  // only to Bitbucket is still a configured scope and must not read as though
  // nothing were connected.
  const hasAnyConnectedProvider =
    hasConnectedProvider || bitbucketReadiness.data?.connected === true;
  const permission = useReviewerPermission(scope);
  // The Configure button opens the platform list, where each platform's connect
  // card is per-role: GitHub's needs an organization-manage role and GitLab's a
  // billing-level edit role, so a plain member would land on a screen whose
  // actions all refuse them. An unresolved permission keeps the button — the
  // provider procedures stay server-authorized.
  const canConnect = permission.status !== 'ready' || canConnectAnyProvider(permission);
  // A deep link arrives with no cached role or provider answer, and the empty
  // state must paint its final form once: a button that appears and then leaves
  // moves the centered stack by its own height. Keep the loading body until all
  // inputs settle, as the manual-review screen does for the same reason.
  // A query with no data and no error has not answered yet: it is paused
  // (offline, unknown connectivity) or still fetching, so the empty state must
  // not paint a state it may replace. The classifiers treat that case as
  // loading; a failed read is settled, because the role and connection answers
  // are then both final for this visit.
  const providerUnresolved = (status: { data?: unknown; isError?: boolean }) =>
    status.data === undefined && status.isError !== true;
  const emptyStateSettled =
    permission.status !== 'loading' &&
    !providerUnresolved(githubStatus) &&
    !providerUnresolved(gitlabStatus) &&
    // The Bitbucket readiness query is disabled for a personal scope, so its
    // empty cache there is a final answer, not a pending one.
    (isPersonal(scope) || !providerUnresolved(bitbucketReadiness));
  // A read failed only when it failed before it answered. `isError` also turns
  // true when a background refetch fails over the top of cached data, and that
  // cached answer still says what the connection is.
  const providerReadFailed = (status: { data?: unknown; isError?: boolean }) =>
    status.isError === true && status.data === undefined;

  const pages = data?.pages;
  const firstPage = pages?.[0];
  const reviews = useMemo(
    () => dedupeById(pages?.flatMap(page => (page.success ? page.reviews : [])) ?? []),
    [pages]
  );

  // A thrown NOT_FOUND/FORBIDDEN/UNAUTHORIZED can't be fixed by retrying — mirror
  // the review-detail screen and show a permanent state with no retry. Any other
  // thrown error (or the resolved success:false shape below) stays transient,
  // and a request that ran out its deadline keeps its own slow-response state.
  const errorCode = isError ? readTrpcErrorField(error, 'code') : undefined;
  const isPermanentError =
    errorCode === 'NOT_FOUND' || errorCode === 'FORBIDDEN' || errorCode === 'UNAUTHORIZED';
  const errorVariant = trpcErrorVariant(error);

  // A paused first read (`fetchStatus: 'paused'`, the online manager holding
  // queries while the device is offline) settles into none of the branches
  // below: `isLoading` is false, `isError` is false, `data` is undefined, so
  // the screen would paint an empty FlashList forever. The shared classifier
  // names a confirmed pause as the offline state with Retry and keeps a pause
  // while connectivity is unsettled inside loading.
  const readState = useQueryBodyState({
    data: data ?? null,
    isError,
    isFetching,
    fetchStatus,
    refetch: () => {
      void refetch();
    },
  });
  const failure = queryBodyFailure(readState, isFetching);
  // Cached pages with a refresh that is paused or failed keep their rows and
  // gain a stale notice: rows must not pose as current without a way out. The
  // notice is not gated on `!isFetching`, so it stays mounted while its own
  // Retry runs and `isRetrying` reports that read. A failed next page also
  // raises `isError` while its loaded pages stay, but that failure keeps the
  // footer's own error + Retry for the page, so it does not raise the notice on
  // top of it.
  const listFailed = isError && !isFetchNextPageError;
  const stale = data != null && (listFailed || fetchStatus === 'paused');
  const stalePaused = !listFailed && fetchStatus === 'paused';
  const staleNotice = stale ? (
    <QueryError
      variant={stalePaused ? 'offline' : trpcErrorVariant(error)}
      placement="top"
      inset="gutter"
      title={stalePaused ? t('queryError.offlineTitle') : t('common.somethingWentWrong')}
      onRetry={stalePaused || isRetryableTrpcError(error) ? () => void refetch() : undefined}
      isRetrying={isFetching}
    />
  ) : null;

  let body: ReactNode = null;
  // The rows are full-bleed with the gutter inside, so the placeholder repeats
  // that frame: no scroll body gutter, one skeleton per row at the row's own
  // three-line height, and the hairline between them that the loaded list draws.
  const reviewsLoadingBody = (
    <Animated.View
      exiting={FadeOut.duration(150)}
      style={listContentContainerStyle}
      className="flex-1"
    >
      <RowSkeleton lines={3} />
      <RowSkeleton lines={3} />
      <RowSkeleton lines={3} last />
    </Animated.View>
  );
  if (!isLoading && firstPage?.success && reviews.length === 0) {
    const offersAction = hasConnectedProvider || canConnect;
    // The role notice must be true: it appears only when no reviewer platform is
    // connected at all. A scope connected to Bitbucket keeps the neutral
    // explanation, because an owner would find it already set up. A provider
    // read that failed before it answered is unknown, not proof of no
    // connection, so it keeps the neutral explanation too — while a read that
    // failed with a cached answer still lets that answer decide the notice.
    const showsRoleNotice =
      !hasAnyConnectedProvider &&
      !canConnect &&
      !providerReadFailed(githubStatus) &&
      !providerReadFailed(gitlabStatus) &&
      !providerReadFailed(bitbucketReadiness);
    const emptyState = (
      <EmptyState
        icon={GitPullRequest}
        title={t('codeReviewer.reviewList.noReviews')}
        description={
          showsRoleNotice
            ? t('codeReviewer.reviewList.connectOwnerOnly')
            : t('codeReviewer.reviewList.noReviewsDescription')
        }
        action={
          offersAction ? (
            <StateAction
              label={
                hasConnectedProvider
                  ? t('codeReviewer.reviewList.startManualReview')
                  : t('codeReviewer.reviewList.configureProvider')
              }
              icon={hasConnectedProvider ? ArrowRight : Settings}
              onPress={() => {
                pushOnce(
                  (hasConnectedProvider
                    ? `/(app)/code-reviewer/${scope}/manual-review`
                    : `/(app)/code-reviewer/${scope}`) as Href
                );
              }}
            />
          ) : undefined
        }
      />
    );
    // A cached empty list whose refresh is paused or failed keeps its empty
    // state and gains the same notice rows get: "no rows" must not read as
    // current when the read that would fill it cannot run.
    if (!emptyStateSettled) {
      body = reviewsLoadingBody;
    } else if (staleNotice === null) {
      body = emptyState;
    } else {
      body = (
        <View className="flex-1">
          {staleNotice}
          {emptyState}
        </View>
      );
    }
  } else if (!isLoading && ((isError && !data) || (firstPage && !firstPage.success))) {
    body = (
      <QueryError
        variant={!data ? errorVariant : 'server'}
        title={!data && isPermanentError ? undefined : t('codeReviewer.reviewList.couldNotLoad')}
        onRetry={!data && isPermanentError ? undefined : () => void refetch()}
        isRetrying={isFetching}
      />
    );
  } else if (failure) {
    // A paused or failed first read: the classifier's offline or server state
    // with Retry, instead of an empty FlashList or a skeleton that never
    // settles. A cached page shape (`success: false`) keeps its own branch
    // above; the classifier folds it into `error` only when nothing is cached.
    body = (
      <QueryError
        variant={failure.variant}
        title={
          failure.variant === 'offline'
            ? t('queryError.offlineTitle')
            : t('codeReviewer.reviewList.couldNotLoad')
        }
        onRetry={() => void refetch()}
        isRetrying={failure.isRetrying}
      />
    );
  } else if (isLoading || readState.body.status === 'loading') {
    // React Query's `isLoading` is false for a paused first read while the
    // connectivity probe is unsettled and for a reverted idle read, so the
    // classifier's own loading state keeps the skeleton on those too.
    body = reviewsLoadingBody;
  } else {
    body = (
      <FlashList
        style={listStyle}
        data={reviews}
        keyExtractor={review => review.id}
        renderItem={({ item: review, index }) => (
          <ReviewRow
            review={review}
            last={index === reviews.length - 1}
            now={now}
            onOpen={item => {
              pushOnce(`/(app)/code-reviewer/${scope}/reviews/${item.id}` as Href);
            }}
          />
        )}
        contentContainerStyle={listContentContainerStyle}
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
        ListHeaderComponent={staleNotice}
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
      <ReviewerHeader
        title={scopeTitle}
        // One line on both scopes: the personal and the organization list are
        // the same header over the same list, so they keep one height, or the
        // organization one paints its eyebrow lower and leaves a wider gap above
        // the first review. One line is all the header needs to keep the body
        // still when the name arrives with the membership read: a longer name
        // tail-truncates inside the same line instead of wrapping to a second.
        titleNumberOfLines={1}
        // The scope now titles the screen, so the eyebrow keeps the screen's own
        // name where the header's category label goes — the org name is user
        // prose and must not be uppercased or tail-truncated into it.
        eyebrow={t('codeReviewer.reviewList.title')}
      />
      {body}
    </View>
  );
}
