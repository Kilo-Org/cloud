import {
  DEFAULT_SECURITY_FINDING_FILTERS,
  hasActiveSecurityFindingFilters,
  isPersonalSecurityScope,
  parseSecurityFindingFilters,
  type SecurityFindingRouteParams,
  toSecurityFindingParams,
  toSecurityFindingQuery,
} from '@kilocode/app-shared/security-agent';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { ShieldCheck, SlidersHorizontal } from '@/components/ui/icons';
import { useCallback, useMemo, useState } from 'react';
import { View, type ViewStyle } from 'react-native';
import { RefreshControl } from '@/components/ui/refresh-control';
import { RefreshProgress } from '@/components/ui/refresh-progress';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { AnalysisCapacityNotice } from '@/components/security-agent/analysis-capacity-notice';
import { FindingRow } from '@/components/security-agent/finding-row';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import {
  useSecurityAgentConfig,
  useSecurityAgentRepositories,
  useSecurityAnalysisCapacity,
} from '@/lib/hooks/use-security-agent';
import { useSecurityFindings } from '@/lib/hooks/use-security-findings';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { isSecurityFindingAnalyzable, type SecurityFinding } from '@/lib/security-agent';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

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
      <QueryError
        placement="top"
        message={t('securityAgent.findingList.couldNotLoadMore')}
        onRetry={onRetry}
      />
    );
  }
  return null;
}

// FlashList takes `contentContainerStyle` (no className), so the FlatList's
// `grow gap-3 px-6 pt-4` content classes map to their pixel values. FlashList v2
// positions every cell absolutely and has no `gap` handling (2.3.2 ships zero
// `gap` references), so the 12px inter-row gap rides on the measured item
// separator instead of `contentContainerStyle.gap`. The old container `gap` also
// sat between the header and the first row and between the last row and the
// footer; FlashList's separator only spans items, so those two boundaries carry
// the same 12px as a pad on the header (`pb-3`) and on the footer (`pt-3`).
const listStyle = { flex: 1 } satisfies ViewStyle;
const listContentContainerStyle = {
  flexGrow: 1,
  paddingHorizontal: 24,
  paddingTop: 16,
} satisfies ViewStyle;

const FindingRowSeparator = () => <View className="h-3" />;

export function FindingListScreen({ scope, routeParams }: Readonly<FindingListScreenProps>) {
  const router = useRouter();
  const pushOnce = useSinglePushRoute();
  const colors = useThemeColors();
  const paddingBottom = useTabBarBottomPadding();
  const { t } = useTranslation();
  // Filters live in this route's params: the sheet is pushed with them and
  // writes them back on apply, so the URL, the visible list and the sheet's
  // draft can never disagree.
  const filters = useMemo(() => parseSecurityFindingFilters(routeParams), [routeParams]);
  const [refreshing, setRefreshing] = useState(false);

  const config = useSecurityAgentConfig(scope);
  const repositories = useSecurityAgentRepositories(scope);
  const query = useMemo(() => toSecurityFindingQuery(filters), [filters]);
  const findings = useSecurityFindings(scope, query);
  const capacity = useSecurityAnalysisCapacity(scope);
  // An org scope stores its findings under the `organizations.securityAgent`
  // tRPC prefix, so the personal prefix alone matches nothing and the screen
  // never refreshes on focus.
  useRouteForegroundRefresh(
    isPersonalSecurityScope(scope) ? [[['securityAgent']]] : [[['organizations', 'securityAgent']]]
  );

  const slaEnabled = config.data?.slaEnabled ?? true;
  const filtersActive = hasActiveSecurityFindingFilters(filters);
  // Memoized so a pull-to-refresh (`refreshing`) or a filter change does not
  // hand the list a new `data` identity while `pages` is unchanged.
  const items = useMemo(
    () => findings.data?.pages.flatMap(page => page.findings) ?? [],
    [findings.data?.pages]
  );
  // The capacity notice explains a blocked action, so it only appears when a
  // rendered row actually offers one — never over a list of already-analyzed
  // findings.
  const hasAnalyzableRow = useMemo(
    () => items.some(item => isSecurityFindingAnalyzable(item)),
    [items]
  );
  const hasListContent = items.length > 0 || findings.isFetchNextPageError;
  // Hoisted so the list keeps one renderer identity across unrelated screen
  // renders (refresh, filter sheet). FlashList's memoized ViewHolder compares
  // `renderItem` and `extraData` by identity before re-rendering a row.
  const renderItem = useCallback(
    ({ item }: { item: SecurityFinding }) => (
      <FindingRow
        finding={item}
        scope={scope}
        slaEnabled={slaEnabled}
        capacityState={capacity.state}
      />
    ),
    [scope, slaEnabled, capacity.state]
  );
  const rowExtraData = useMemo(
    () => ({ scope, slaEnabled, capacityState: capacity.state }),
    [scope, slaEnabled, capacity.state]
  );
  const handleRefresh = () => {
    void (async () => {
      setRefreshing(true);
      try {
        // Refresh only — never triggers a new sync. The list shows the
        // repository fetch failure inline, so every list refresh retries it,
        // and the capacity counters are on screen, so a pull refreshes them
        // too instead of leaving the notice and the actions on an older read.
        const [findingsResult] = await Promise.all([
          findings.refetch(),
          repositories.refetch(),
          capacity.refetch(),
        ]);
        if (findingsResult.isError) {
          toast.error(t('common.couldNotRefresh'));
        }
      } finally {
        setRefreshing(false);
      }
    })();
  };
  const refreshControl = <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        className="px-6"
        title={t('common.findings')}
        // One 48dp icon target from IconButton; declaring its width keeps the
        // one-line title's readable minimum when the row is narrow.
        headerRightWidth={48}
        headerRight={
          <IconButton
            onPress={() => {
              pushOnce({
                pathname: '/(app)/security-agent/[scope]/filter',
                params: { scope, ...toSecurityFindingParams(filters) },
              });
            }}
            accessibilityLabel={t('securityAgent.filter.title')}
          >
            <SlidersHorizontal
              size={20}
              color={filtersActive ? colors.foreground : colors.mutedForeground}
            />
          </IconButton>
        }
      />

      {repositories.isError ? (
        <QueryError
          placement="top"
          message={t('common.couldNotLoadRepositories')}
          onRetry={() => void repositories.refetch()}
          isRetrying={repositories.isFetching}
        />
      ) : null}

      {findings.isLoading && (
        <View className="flex-1 gap-3 px-6 pt-4">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </View>
      )}

      {!findings.isLoading && findings.isError && !hasListContent && (
        <QueryError
          message={t('securityAgent.findingList.couldNotLoad')}
          onRetry={() => void findings.refetch()}
          refreshControl={refreshControl}
        />
      )}

      {!findings.isLoading && !findings.isError && !hasListContent && (
        <EmptyState
          icon={ShieldCheck}
          refreshControl={refreshControl}
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
                className={STATE_ACTION_CLASS}
                variant="outline"
                onPress={() => {
                  router.setParams(toSecurityFindingParams(DEFAULT_SECURITY_FINDING_FILTERS));
                }}
              >
                <Text>{t('common.clearFilters')}</Text>
              </Button>
            ) : undefined
          }
        />
      )}

      {!findings.isLoading && hasListContent && (
        <FlashList<SecurityFinding>
          style={listStyle}
          data={items}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          getItemType={() => 'finding'}
          ItemSeparatorComponent={FindingRowSeparator}
          extraData={rowExtraData}
          contentContainerStyle={listContentContainerStyle}
          ListHeaderComponent={
            // The former container gap also separated the header from the first
            // row, which the item separator does not cover.
            <View className="pb-3">
              <RefreshProgress refreshControl={refreshControl} />
              {hasAnalyzableRow ? (
                <AnalysisCapacityNotice
                  className="pt-2"
                  state={capacity.state}
                  onRetry={() => void capacity.refetch()}
                />
              ) : null}
            </View>
          }
          refreshControl={refreshControl}
          onEndReached={() => {
            if (findings.hasNextPage && !findings.isFetchingNextPage) {
              void findings.fetchNextPage();
            }
          }}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            // The former container gap also separated the last row from the
            // footer (skeleton / error / bottom spacer).
            <View className="pt-3">
              <FindingsListFooter
                loading={findings.isFetchingNextPage}
                error={findings.isFetchNextPageError}
                onRetry={() => void findings.fetchNextPage()}
              />
              <View style={{ height: paddingBottom }} pointerEvents="none" />
            </View>
          }
        />
      )}
    </View>
  );
}
