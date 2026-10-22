import { FlashList } from '@shopify/flash-list';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Switch, View, type ViewStyle } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';

import { CenteredState } from '@/components/centered-state';
import { ReviewMemoryProposalSheet } from '@/components/code-reviewer/review-memory-proposal-sheet';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Brain } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useReviewerPermission, useSetReviewMemoryEnabled } from '@/lib/hooks/use-code-reviewer';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { reviewMemoryOwnerInput } from '@/lib/hooks/use-review-memory';
import {
  ACTIVE_PROPOSAL_STATUSES,
  proposalStatusLabel,
  type ReviewMemoryProposal,
} from '@/lib/review-memory-proposals';
import { useTRPC } from '@/lib/trpc';

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

  const summaryQuery = useQuery(trpc.reviewMemory.getDashboardSummary.queryOptions(ownerInput));
  const setEnabled = useSetReviewMemoryEnabled(scope);
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
      <View className="items-center gap-2 px-6 py-4">
        <Text variant="muted" className="text-center text-xs">
          {t('common.couldnTLoadMore')}
        </Text>
        <Button
          size="sm"
          variant="outline"
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
        className="gap-3 px-6 pt-4"
      >
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-20 w-full rounded-lg" />
      </View>
    );
  } else if (summaryError) {
    body = (
      <QueryError
        variant="server"
        title={t('codeReviewer.reviewMemory.couldNotLoad')}
        onRetry={() => void summaryQuery.refetch()}
        isRetrying={summaryQuery.isFetching}
      />
    );
  } else if (disabled) {
    body = (
      <CenteredState>
        <View className="items-center gap-3 px-6">
          <Text className="text-center text-sm font-medium">
            {t('codeReviewer.reviewMemory.off')}
          </Text>
          <Text variant="muted" className="text-center text-xs">
            {t('codeReviewer.reviewMemory.offDescription')}
          </Text>
          {readOnly ? (
            <Text variant="muted" className="text-center text-xs">
              {t('codeReviewer.reviewMemory.readOnlyDescription')}
            </Text>
          ) : (
            <Button
              onPress={() => {
                setEnabled.mutate(true);
              }}
              loading={setEnabled.isPending}
              accessibilityLabel={t('codeReviewer.reviewMemory.enable')}
            >
              <Text>{t('codeReviewer.reviewMemory.enable')}</Text>
            </Button>
          )}
        </View>
      </CenteredState>
    );
  } else if (firstPageError) {
    body = (
      <QueryError
        variant="server"
        title={t('codeReviewer.reviewMemory.couldNotLoadProposals')}
        onRetry={() => void proposalsQuery.refetch()}
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
        renderItem={({ item }) => (
          <Pressable
            className="min-h-11 border-b-[0.5px] border-hair-soft px-6 py-3 active:opacity-70"
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
            <Text className="text-sm font-medium" numberOfLines={1}>
              {item.title}
            </Text>
            <Text variant="muted" className="mt-0.5 text-xs">
              {item.repo_full_name}
            </Text>
            <Text variant="muted" className="mt-1 text-xs">
              {proposalStatusLabel(item.status, t)}
            </Text>
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
      <ScreenHeader
        title={t('codeReviewer.reviewMemory.title')}
        eyebrow={t('common.codeReviewer')}
      />
      {enabled ? (
        <View className="px-6 pt-4">
          <View className="rounded-lg bg-secondary p-4">
            <View className="flex-row items-center justify-between gap-3">
              {/* One named control with a 44pt target: the label is what a tap
                  names, so it moves the value, and the native Switch stays out
                  of the accessibility tree the way PreferenceRow does it. */}
              <Pressable
                className="min-h-11 min-w-0 flex-1 justify-center active:opacity-70"
                disabled={!canToggle}
                onPress={() => {
                  setEnabled.mutate(!enabled);
                }}
                accessibilityRole="switch"
                accessibilityLabel={t('codeReviewer.reviewMemory.title')}
                accessibilityHint={
                  readOnly ? t('codeReviewer.reviewMemory.readOnlyDescription') : undefined
                }
                accessibilityState={{
                  disabled: !canToggle,
                  busy: setEnabled.isPending,
                  checked: enabled,
                }}
              >
                <Text
                  accessible={false}
                  importantForAccessibility="no"
                  className="text-sm font-medium"
                >
                  {t('codeReviewer.reviewMemory.on')}
                </Text>
              </Pressable>
              <Switch
                value={enabled}
                disabled={!canToggle}
                accessible={false}
                importantForAccessibility="no"
                accessibilityElementsHidden
                onValueChange={value => {
                  setEnabled.mutate(value);
                }}
              />
            </View>
            {readOnly ? (
              <Text variant="muted" className="mt-2 text-xs">
                {t('codeReviewer.reviewMemory.readOnlyDescription')}
              </Text>
            ) : null}
          </View>
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
