import { FlashList } from '@shopify/flash-list';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View, type ViewStyle } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';

import { ReviewMemoryAnalyzeSection } from '@/components/code-reviewer/review-memory-analyze-section';
import { ReviewMemoryProposalSheet } from '@/components/code-reviewer/review-memory-proposal-sheet';
import { ReviewMemoryToggleCard } from '@/components/code-reviewer/review-memory-toggle-card';
import { EmptyState, StateAction } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ReviewerHeader } from '@/components/code-reviewer/reviewer-header';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Brain, Sparkles } from '@/components/ui/icons';
import { RowChevron } from '@/components/ui/row-chevron';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { useReviewerPermission, useSetReviewMemoryEnabled } from '@/lib/hooks/use-code-reviewer';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  reviewMemoryOwnerInput,
  useTriggerReviewMemoryAnalysis,
} from '@/lib/hooks/use-review-memory';
import {
  ACTIVE_PROPOSAL_STATUSES,
  proposalStatusLabel,
  type ReviewMemoryProposal,
} from '@/lib/review-memory-proposals';
import { useTRPC } from '@/lib/trpc';
import { isRetryableTrpcError, trpcErrorVariant } from '@/lib/trpc-error';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 20;

const listStyle = { flex: 1 } satisfies ViewStyle;

export function ReviewMemoryScreen({ scope }: Readonly<{ scope: string }>) {
  const trpc = useTRPC();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const paddingBottom = useTabBarBottomPadding();
  const ownerInput = reviewMemoryOwnerInput(scope);
  const permission = useReviewerPermission(scope);
  const [selectedProposal, setSelectedProposal] = useState<ReviewMemoryProposal | null>(null);

  // The proposal sheet is a native sheet in its own window, so it is not
  // dismissed by navigation the way a route is: a deep link, a push or any
  // programmatic push that leaves this screen would otherwise keep the form
  // presented over the destination, and closing it would reveal that screen
  // instead of this list. Leaving the screen is what ends the form.
  useFocusEffect(
    useCallback(
      () => () => {
        setSelectedProposal(null);
      },
      []
    )
  );

  const summaryQuery = useQuery(trpc.reviewMemory.getDashboardSummary.queryOptions(ownerInput));
  const setEnabled = useSetReviewMemoryEnabled(scope);
  const triggerAnalysis = useTriggerReviewMemoryAnalysis(scope);
  const enabled = summaryQuery.data?.enabled === true;

  const proposalsQuery = useInfiniteQuery(
    trpc.reviewMemory.listProposalsPage.infiniteQueryOptions(
      { ...ownerInput, limit: PAGE_SIZE, statuses: ACTIVE_PROPOSAL_STATUSES },
      {
        enabled,
        getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
      }
    )
  );

  const proposals = useMemo(
    () => (proposalsQuery.data?.pages ?? []).flatMap(page => page.proposals),
    [proposalsQuery.data?.pages]
  );

  const readOnly = permission.status === 'ready' && !permission.canEdit;
  const canToggle = !readOnly && !setEnabled.isPending;
  const hasLoadedPages = (proposalsQuery.data?.pages.length ?? 0) > 0;
  const firstPageError = proposalsQuery.isError && !hasLoadedPages;
  const laterPageError = proposalsQuery.isError && hasLoadedPages;

  const summaryLoading = summaryQuery.isPending;
  const summaryError = summaryQuery.isError && !summaryQuery.data;
  const disabled = summaryQuery.data?.enabled === false;
  const proposalsLoading = enabled && proposalsQuery.isPending;
  const empty = enabled && !proposalsLoading && !firstPageError && proposals.length === 0;
  const happy = enabled && !proposalsLoading && !firstPageError && proposals.length > 0;

  let footer = null;
  if (laterPageError) {
    footer = (
      <View className="items-center gap-2 px-4 py-4">
        <Text variant="muted" className="text-center text-xs">
          {t('common.couldnTLoadMore')}
        </Text>
        <Button
          size="sm"
          variant="outline"
          className={STATE_ACTION_CLASS}
          onPress={() => void proposalsQuery.fetchNextPage()}
          accessibilityLabel={t('common.retryLoadingMore')}
        >
          <Text>{t('common.retry')}</Text>
        </Button>
      </View>
    );
  } else if (proposalsQuery.isFetchingNextPage) {
    footer = (
      <View className="items-center py-4">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  }

  let body: ReactNode = null;
  if (summaryLoading || proposalsLoading) {
    body = (
      <View
        accessibilityLabel={t(
          summaryLoading
            ? 'codeReviewer.reviewMemory.loading'
            : 'codeReviewer.reviewMemory.loadingProposals'
        )}
        className="flex-1"
      >
        {/* The proposals list is the body's own content: flat full-bleed rows,
            so the placeholder holds that shape (the row frame draws the page
            gutter) instead of a card the loaded state never paints. */}
        <RowSkeleton subtitle />
        <RowSkeleton subtitle />
        <RowSkeleton subtitle />
      </View>
    );
  } else if (summaryError) {
    body = (
      <QueryError
        variant={trpcErrorVariant(summaryQuery.error)}
        title={t('codeReviewer.reviewMemory.couldNotLoad')}
        onRetry={
          isRetryableTrpcError(summaryQuery.error) ? () => void summaryQuery.refetch() : undefined
        }
        isRetrying={summaryQuery.isFetching}
      />
    );
  } else if (disabled) {
    body = (
      <EmptyState
        icon={Brain}
        title={t('codeReviewer.reviewMemory.off')}
        description={t('codeReviewer.reviewMemory.offDescription')}
        action={
          readOnly ? (
            // This reader has no press to make, so the sentence that names who
            // does takes the action's slot.
            <Text variant="muted" className="text-center">
              {t('codeReviewer.reviewMemory.readOnlyDescription')}
            </Text>
          ) : (
            <StateAction
              label={t('codeReviewer.reviewMemory.enable')}
              icon={Sparkles}
              loading={setEnabled.isPending}
              onPress={() => {
                setEnabled.mutate(true);
              }}
            />
          )
        }
      />
    );
  } else if (firstPageError) {
    body = (
      <QueryError
        variant={trpcErrorVariant(proposalsQuery.error)}
        title={t('codeReviewer.reviewMemory.couldNotLoadProposals')}
        onRetry={
          isRetryableTrpcError(proposalsQuery.error)
            ? () => void proposalsQuery.refetch()
            : undefined
        }
        isRetrying={proposalsQuery.isFetching}
      />
    );
  } else if (empty) {
    body = (
      <>
        <EmptyState
          icon={Brain}
          title={t('codeReviewer.reviewMemory.noProposals')}
          description={t('codeReviewer.reviewMemory.noProposalsDescription')}
        />
        {footer}
      </>
    );
  } else if (happy) {
    body = (
      <FlashList
        data={proposals}
        style={listStyle}
        keyExtractor={proposal => proposal.id}
        renderItem={({ item, index }) => (
          <Pressable
            className={cn(
              'flex-row items-center gap-3 px-4 py-3 active:opacity-70',
              index < proposals.length - 1 && 'border-b-[0.5px] border-hair-soft'
            )}
            accessibilityRole="button"
            accessibilityLabel={[
              item.title,
              item.repo_full_name,
              proposalStatusLabel(item.status, t),
            ].join('\n')}
            onPress={() => {
              setSelectedProposal(item);
            }}
          >
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-medium" numberOfLines={1}>
                {item.title}
              </Text>
              <Text variant="muted" className="mt-0.5 text-xs">
                {item.repo_full_name}
              </Text>
              <Text variant="muted" className="mt-1 text-xs">
                {proposalStatusLabel(item.status, t)}
              </Text>
            </View>
            <RowChevron />
          </Pressable>
        )}
        ListFooterComponent={
          <>
            {footer}
            <View style={{ height: paddingBottom }} pointerEvents="none" />
          </>
        }
        onEndReached={() => {
          if (proposalsQuery.hasNextPage && !proposalsQuery.isFetchingNextPage) {
            void proposalsQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.5}
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ReviewerHeader
        title={t('codeReviewer.reviewMemory.title')}
        eyebrow={t('common.codeReviewer')}
      />
      {enabled ? (
        <View className={SCREEN_BODY_CLASS}>
          <ReviewMemoryToggleCard
            enabled={enabled}
            readOnly={readOnly}
            disabled={!canToggle}
            pending={setEnabled.isPending}
            onChange={value => {
              setEnabled.mutate(value);
            }}
          />
          <ReviewMemoryAnalyzeSection
            repositories={summaryQuery.data?.repositories ?? []}
            pending={triggerAnalysis.isPending}
            disabled={readOnly}
            onAnalyze={repoFullName => {
              triggerAnalysis.mutate(repoFullName);
            }}
          />
        </View>
      ) : null}
      {body}
      {selectedProposal ? (
        <ReviewMemoryProposalSheet
          key={`${scope}:${selectedProposal.id}`}
          scope={scope}
          proposal={
            proposals.find(proposal => proposal.id === selectedProposal.id) ?? selectedProposal
          }
          available={proposals.some(proposal => proposal.id === selectedProposal.id)}
          permission={permission}
          onClose={() => {
            setSelectedProposal(null);
          }}
        />
      ) : null}
    </View>
  );
}
