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
import { ShieldCheck, SlidersHorizontal, X } from '@/components/ui/icons';
import { useCallback, useMemo, useState } from 'react';
import { View, type ViewStyle } from 'react-native';
import { RefreshControl } from '@/components/ui/refresh-control';
import { RefreshProgress } from '@/components/ui/refresh-progress';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { EmptyState, StateAction } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { AnalysisCapacityNotice } from '@/components/security-agent/analysis-capacity-notice';
import { FindingRow } from '@/components/security-agent/finding-row';
import {
  FindingListSkeletonRows,
  FindingRowSkeleton,
} from '@/components/security-agent/finding-row-skeleton';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { IconButton } from '@/components/ui/icon-button';
import {
  useSecurityAgentConfig,
  useSecurityAgentRepositories,
  useSecurityAnalysisCapacity,
} from '@/lib/hooks/use-security-agent';
import { useSecurityFindings } from '@/lib/hooks/use-security-findings';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { classifyListBody } from '@/lib/query/list-body-state';
import {
  classifyReadFailureKind,
  readFailureKindIsRetryable,
  readFailureKindVariant,
} from '@/lib/query/read-failure-variant';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { isSecurityFindingAnalyzable, type SecurityFinding } from '@/lib/security-agent';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useSideInsetMarginStyle } from '@/lib/screen-insets';

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
    // The footer placeholder stands in for the page's last row, so it draws no
    // hairline under itself.
    return <FindingRowSkeleton last />;
  }
  if (error) {
    return (
      <QueryError
        placement="top"
        inset="gutter"
        message={t('securityAgent.findingList.couldNotLoadMore')}
        onRetry={onRetry}
      />
    );
  }
  return null;
}

// FlashList takes `contentContainerStyle` (no className), so the body keeps
// only the top pad: the 14pt page gutter lives on the rows, their hairlines and
// the header/footer bands, never on the scroller.
const listStyle = { flex: 1 } satisfies ViewStyle;
const listContentContainerStyle = {
  flexGrow: 1,
  paddingTop: 12,
} satisfies ViewStyle;

export function FindingListScreen({ scope, routeParams }: Readonly<FindingListScreenProps>) {
  const router = useRouter();
  const pushOnce = useSinglePushRoute();
  const colors = useThemeColors();
  const paddingBottom = useTabBarBottomPadding();
  const sideInsetMarginStyle = useSideInsetMarginStyle();
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
  // Only a delivered page may claim there are no open findings: a read that is
  // paused, never started, or whose pages were cleared has not answered. An
  // unsettled connectivity keeps the skeleton instead of naming the connection.
  const connectivity = useCommittedConnectivityStatus();
  const connectivityKnown = connectivity !== 'unknown';
  const body = classifyListBody({
    rowCount: items.length,
    hasDeliveredData: (findings.data?.pages.length ?? 0) > 0,
    hasInlineError: findings.isFetchNextPageError,
    isError: findings.isError,
    isFetching: findings.isFetching,
    fetchStatus: findings.fetchStatus,
    connectivityKnown,
  });
  // This screen reads through two calls (the repositories list and the rows),
  // and either one failing leaves the reader with nothing to act on. One kind
  // over BOTH failures names the surface once: the old shape drew a card per
  // read, so a permission refusal showed two "Something went wrong" cards with
  // a Retry that could only be refused again.
  const failureErrors = [findings.error, repositories.error].filter(
    (error): error is Error => error != null
  );
  const failureKind = classifyReadFailureKind({
    errors: failureErrors,
    isPaused: findings.fetchStatus === 'paused' && connectivityKnown,
    connectivity,
  });
  const failureRetryable = readFailureKindIsRetryable(failureKind);
  const failureVariant = readFailureKindVariant(failureKind);
  // Which read left the screen with nothing: the rows own the body, the
  // repositories only decorate the list. A repositories failure with rows or a
  // settled empty list is a notice above them; either failure with nothing
  // delivered owns the surface.
  const findingsFailed = body.status === 'error';
  const failureOwnsBody = findingsFailed;
  const failureVisible = findingsFailed || repositories.isError;
  // A retryable failure keeps the screen's own sentence, naming the read that
  // failed. The other three take their copy from the variant alone, which names
  // the refusal, the missing item, or the connection instead of blaming the
  // server for all of them.
  const failureMessage = failureRetryable
    ? t(
        findingsFailed
          ? 'securityAgent.findingList.couldNotLoad'
          : 'common.couldNotLoadRepositories'
      )
    : undefined;
  // Hoisted so the list keeps one renderer identity across unrelated screen
  // renders (refresh, filter sheet). FlashList's memoized ViewHolder compares
  // `renderItem` and `extraData` by identity before re-rendering a row.
  const renderItem = useCallback(
    ({ item, index }: { item: SecurityFinding; index: number }) => (
      <FindingRow
        finding={item}
        scope={scope}
        slaEnabled={slaEnabled}
        capacityState={capacity.state}
        last={index === items.length - 1}
      />
    ),
    [scope, slaEnabled, capacity.state, items.length]
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

      {/* ONE error surface for the screen. Both reads feed the same kind, so a
          permission refusal never describes itself as a server fault and a
          terminal failure offers no Retry. A failure with rows to show is a
          notice above them; a failure with nothing to show owns the body. */}
      {failureVisible && (
        <QueryError
          variant={failureVariant}
          placement={failureOwnsBody ? 'center' : 'top'}
          inset={failureOwnsBody ? undefined : 'gutter'}
          message={failureMessage}
          onRetry={
            failureRetryable
              ? () => {
                  void findings.refetch();
                  if (repositories.isError) {
                    void repositories.refetch();
                  }
                }
              : undefined
          }
          isRetrying={findings.isFetching || repositories.isFetching}
          refreshControl={failureOwnsBody ? refreshControl : undefined}
        />
      )}

      {body.status === 'loading' && (
        <View style={[listStyle, sideInsetMarginStyle]}>
          <View style={listContentContainerStyle}>
            {/* The loaded list's `ListHeaderComponent` band, so the first row
                lands where the first placeholder row stood. */}
            <View className="h-3" />
            <FindingListSkeletonRows />
          </View>
        </View>
      )}

      {body.status === 'empty' && (
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
              <StateAction
                label={t('common.clearFilters')}
                icon={X}
                onPress={() => {
                  router.setParams(toSecurityFindingParams(DEFAULT_SECURITY_FINDING_FILTERS));
                }}
              />
            ) : undefined
          }
        />
      )}

      {body.status === 'rows' && (
        <FlashList<SecurityFinding>
          style={[listStyle, sideInsetMarginStyle]}
          data={items}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          getItemType={() => 'finding'}
          extraData={rowExtraData}
          contentContainerStyle={listContentContainerStyle}
          ListHeaderComponent={
            // The header band carries the page gutter itself: the rows own
            // theirs, so the scroller must not inset them twice.
            <View className="px-4 pb-3">
              <RefreshProgress refreshControl={refreshControl} />
              {hasAnalyzableRow ? (
                <AnalysisCapacityNotice
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
            <>
              <FindingsListFooter
                loading={findings.isFetchingNextPage}
                error={findings.isFetchNextPageError}
                onRetry={() => void findings.fetchNextPage()}
              />
              <View style={{ height: paddingBottom }} pointerEvents="none" />
            </>
          }
        />
      )}
    </View>
  );
}
