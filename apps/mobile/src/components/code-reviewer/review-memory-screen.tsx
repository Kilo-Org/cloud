import { FlashList } from '@shopify/flash-list';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Brain } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { PERSONAL_SCOPE } from '@/lib/code-reviewer-config';
import { useReviewerPermission, useSetReviewMemoryEnabled } from '@/lib/hooks/use-code-reviewer';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useTRPC } from '@/lib/trpc';

const PAGE_SIZE = 20;

// Review memory only exists for GitHub, so the owner input pins the platform
// and only varies the scope segment (personal vs. an organization id).
function reviewMemoryOwnerInput(scope: string) {
  return scope === PERSONAL_SCOPE
    ? ({ platform: 'github' } as const)
    : ({ organizationId: scope, platform: 'github' } as const);
}

export function ReviewMemoryScreen({ scope }: Readonly<{ scope: string }>) {
  const trpc = useTRPC();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const ownerInput = reviewMemoryOwnerInput(scope);
  const permission = useReviewerPermission(scope);

  const summaryQuery = useQuery(trpc.reviewMemory.getDashboardSummary.queryOptions(ownerInput));
  const enabled = summaryQuery.data?.enabled === true;

  const proposalsQuery = useInfiniteQuery(
    trpc.reviewMemory.listProposalsPage.infiniteQueryOptions(
      { ...ownerInput, limit: PAGE_SIZE },
      {
        enabled,
        getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
      }
    )
  );

  const setEnabled = useSetReviewMemoryEnabled(scope);

  const proposals = useMemo(
    () => (proposalsQuery.data?.pages ?? []).flatMap(page => page.proposals),
    [proposalsQuery.data?.pages]
  );

  const readOnly = permission.status === 'ready' && !permission.canEdit;
  const hasLoadedPages = (proposalsQuery.data?.pages.length ?? 0) > 0;
  const firstPageError = proposalsQuery.isError && !hasLoadedPages;
  const laterPageError = proposalsQuery.isError && hasLoadedPages;

  const summaryLoading = summaryQuery.isPending;
  const summaryError = summaryQuery.isError && !summaryQuery.data;
  const disabled = summaryQuery.data != null && !summaryQuery.data.enabled;
  const proposalsLoading = enabled && proposalsQuery.isPending;
  const empty = enabled && !proposalsLoading && !firstPageError && proposals.length === 0;
  const happy = enabled && !proposalsLoading && !firstPageError && proposals.length > 0;

  let footer = null;
  if (laterPageError) {
    footer = (
      <View className="items-center gap-2 px-6 py-4">
        <Text variant="muted" className="text-center text-xs">
          {t('codeReviewer.reviewMemory.couldNotLoadMore')}
        </Text>
        <Button
          size="sm"
          variant="outline"
          onPress={() => void proposalsQuery.fetchNextPage()}
          accessibilityLabel={t('codeReviewer.reviewMemory.retryLoadingMore')}
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

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('codeReviewer.reviewMemory.title')}
        eyebrow={t('codeReviewer.title')}
      />
      <FlashList
        data={happy ? proposals : []}
        keyExtractor={proposal => proposal.id}
        renderItem={({ item }) => (
          <View className="border-b-[0.5px] border-hair-soft px-6 py-3">
            <Text className="text-sm font-medium" numberOfLines={1}>
              {item.title}
            </Text>
            <Text variant="muted" className="mt-0.5 text-xs">
              {item.repo_full_name}
            </Text>
          </View>
        )}
        ListEmptyComponent={
          <View className="px-6 pt-4">
            {summaryLoading && (
              <View accessibilityLabel={t('codeReviewer.reviewMemory.loading')} className="gap-3">
                <Skeleton className="h-20 w-full rounded-lg" />
                <Skeleton className="h-20 w-full rounded-lg" />
                <Skeleton className="h-20 w-full rounded-lg" />
              </View>
            )}

            {summaryError && (
              <QueryError
                variant="server"
                title={t('codeReviewer.reviewMemory.couldNotLoad')}
                placement="top"
                onRetry={() => void summaryQuery.refetch()}
                isRetrying={summaryQuery.isFetching}
              />
            )}

            {disabled && (
              <View className="items-center gap-3 pt-16">
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
            )}

            {proposalsLoading && (
              <View
                accessibilityLabel={t('codeReviewer.reviewMemory.loadingProposals')}
                className="gap-3"
              >
                <Skeleton className="h-20 w-full rounded-lg" />
                <Skeleton className="h-20 w-full rounded-lg" />
                <Skeleton className="h-20 w-full rounded-lg" />
              </View>
            )}

            {firstPageError && (
              <QueryError
                variant="server"
                title={t('codeReviewer.reviewMemory.couldNotLoadProposals')}
                placement="top"
                onRetry={() => void proposalsQuery.refetch()}
                isRetrying={proposalsQuery.isFetching}
              />
            )}

            {empty && (
              <EmptyState
                icon={Brain}
                placement="top"
                title={t('codeReviewer.reviewMemory.noProposals')}
                description={t('codeReviewer.reviewMemory.noProposalsDescription')}
              />
            )}
          </View>
        }
        ListFooterComponent={footer}
        onEndReached={() => {
          if (proposalsQuery.hasNextPage && !proposalsQuery.isFetchingNextPage) {
            void proposalsQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.5}
      />
    </View>
  );
}
