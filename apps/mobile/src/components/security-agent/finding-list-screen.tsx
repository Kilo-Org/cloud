import {
  DEFAULT_SECURITY_FINDING_FILTERS,
  getSecurityRepositoriesInScope,
  hasActiveSecurityFindingFilters,
  parseSecurityFindingFilters,
  type SecurityFindingRouteParams,
  toSecurityFindingQuery,
} from '@kilocode/app-shared/security-agent';
import { useRouter } from 'expo-router';
import { ShieldCheck, SlidersHorizontal } from '@/components/ui/icons';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { FindingRow } from '@/components/security-agent/finding-row';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  useSecurityAgentConfig,
  useSecurityAgentRepositories,
  useSecurityAnalysisCapacity,
} from '@/lib/hooks/use-security-agent';
import { useSecurityFindings } from '@/lib/hooks/use-security-findings';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { getSecurityAgentPath } from '@/lib/security-agent';
import { setSecurityFindingFilterBridge } from '@/lib/security-finding-filter-bridge';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type FindingListScreenProps = {
  scope: string;
  routeParams: SecurityFindingRouteParams;
};

function FindingsListFooter({
  loading,
  error,
  onRetry,
}: Readonly<{ loading: boolean; error: boolean; onRetry: () => void }>) {
  const { t } = useTranslation();
  if (loading) {
    return <Skeleton className="h-24 w-full rounded-lg" />;
  }
  if (error) {
    return (
      <QueryError message={t('securityAgent.findingList.couldNotLoadMore')} onRetry={onRetry} />
    );
  }
  return null;
}

export function FindingListScreen({ scope, routeParams }: Readonly<FindingListScreenProps>) {
  const router = useRouter();
  const colors = useThemeColors();
  const paddingBottom = useTabBarBottomPadding();
  const { t } = useTranslation();
  const [filters, setFilters] = useState(() => parseSecurityFindingFilters(routeParams));
  const [refreshing, setRefreshing] = useState(false);

  const config = useSecurityAgentConfig(scope);
  const repositories = useSecurityAgentRepositories(scope);
  const query = useMemo(() => toSecurityFindingQuery(filters), [filters]);
  const findings = useSecurityFindings(scope, query);
  const capacity = useSecurityAnalysisCapacity(scope);
  useRouteForegroundRefresh([[['securityAgent']]]);

  const slaEnabled = config.data?.slaEnabled ?? true;
  const hasAnalysisCapacity =
    capacity.runningCount !== undefined &&
    capacity.concurrencyLimit !== undefined &&
    capacity.runningCount < capacity.concurrencyLimit;
  const filtersActive = hasActiveSecurityFindingFilters(filters);
  const items = findings.data?.pages.flatMap(page => page.findings) ?? [];
  const scopedRepositories = getSecurityRepositoriesInScope(repositories.data ?? [], config.data);
  // Repos aren't known yet (still loading or the fetch failed) — the filter
  // stays disabled instead of silently offering a shrunken repository list.
  const filterUnavailable = repositories.isLoading || repositories.isError;

  const handleRefresh = () => {
    void (async () => {
      setRefreshing(true);
      try {
        // Refresh only — never triggers a new sync.
        const result = await findings.refetch();
        if (result.isError) {
          toast.error(t('common.couldNotRefresh'));
        }
      } finally {
        setRefreshing(false);
      }
    })();
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('securityAgent.findingList.title')}
        headerRight={
          <Pressable
            onPress={() => {
              if (filterUnavailable) {
                return;
              }
              setSecurityFindingFilterBridge({
                filters,
                repositories: scopedRepositories,
                onApply: setFilters,
              });
              router.push(getSecurityAgentPath(scope, 'filter'));
            }}
            disabled={filterUnavailable}
            accessibilityRole="button"
            accessibilityLabel={t('securityAgent.filter.title')}
            accessibilityState={{ disabled: filterUnavailable }}
            className={cn(
              'size-11 items-center justify-center active:opacity-70',
              filterUnavailable && 'opacity-50'
            )}
          >
            <SlidersHorizontal
              size={20}
              color={filtersActive ? colors.foreground : colors.mutedForeground}
            />
          </Pressable>
        }
      />

      {findings.isLoading && (
        <View className="flex-1 gap-3 px-6 pt-4">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </View>
      )}

      {!findings.isLoading && findings.isError && !findings.data && (
        <View className="flex-1 items-center justify-center">
          <QueryError
            message={t('securityAgent.findingList.couldNotLoad')}
            onRetry={() => void findings.refetch()}
          />
        </View>
      )}

      {!findings.isLoading && (!findings.isError || findings.data) && (
        <FlatList
          data={items}
          keyExtractor={item => item.id}
          renderItem={({ item }) => (
            <FindingRow
              finding={item}
              scope={scope}
              slaEnabled={slaEnabled}
              hasAnalysisCapacity={hasAnalysisCapacity}
            />
          )}
          contentContainerClassName="grow gap-3 px-6 pt-4"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
          onEndReached={() => {
            if (findings.hasNextPage && !findings.isFetchingNextPage) {
              void findings.fetchNextPage();
            }
          }}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            <>
              <FindingsListFooter
                loading={findings.isFetchingNextPage}
                error={findings.isFetchNextPageError}
                onRetry={() => void findings.fetchNextPage()}
              />
              <View style={{ height: paddingBottom }} pointerEvents="none" />
            </>
          }
          ListEmptyComponent={
            <EmptyState
              icon={ShieldCheck}
              title={
                filtersActive
                  ? t('securityAgent.findingList.noMatchesTitle')
                  : t('securityAgent.findingList.emptyTitle')
              }
              description={
                filtersActive
                  ? t('securityAgent.findingList.noMatchesDescription')
                  : t('securityAgent.findingList.emptyDescription')
              }
              action={
                filtersActive ? (
                  <Button
                    variant="outline"
                    onPress={() => {
                      setFilters(DEFAULT_SECURITY_FINDING_FILTERS);
                    }}
                  >
                    <Text>{t('securityAgent.findingList.clearFilters')}</Text>
                  </Button>
                ) : undefined
              }
            />
          }
        />
      )}
    </View>
  );
}
