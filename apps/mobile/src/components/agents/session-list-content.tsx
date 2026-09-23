/* eslint-disable max-lines -- Session-list content and its error/empty surfaces are kept together. */
import { FlashList, type FlashListRef, type ListRenderItemInfo } from '@shopify/flash-list';
import { useFocusEffect, useScrollToTop } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { RefreshControl } from '@/components/ui/refresh-control';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RowsRefreshControl } from '@/components/agents/rows-refresh-control';
import { BodyEmpty } from '@/components/agents/session-list-body-empty';
import { selectSessionListBodyModel } from '@/components/agents/session-list-body-model';
import { selectSessionListContentSurface } from '@/components/agents/session-list-content-surface';
import { type SessionSection } from '@/components/agents/session-list-helpers';
import { SessionListRefreshStatus } from '@/components/agents/session-list-refresh-status';
import {
  flattenSessionSections,
  type SessionListRow,
  skeletonSessionRows,
} from '@/components/agents/session-list-rows';
import { shouldResetScrollOnCommittedQuery } from '@/components/agents/session-list-scroll-reset';
import { SessionListSectionHeader } from '@/components/agents/session-list-section-header';
import { StoredSessionRow } from '@/components/agents/session-row';
import { usePullRefresh } from '@/components/agents/use-pull-refresh';
import { QueryError } from '@/components/query-error';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { moveA11yFocus } from '@/lib/a11y/announce';
import { SESSION_LIST_SORT } from '@/lib/agent-session-sort';
import { useSessionMutations } from '@/lib/hooks/use-session-mutations';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getRevisionSnapshot } from '@/lib/session-attention';
import { useEffectiveTabBarHeight } from '@/lib/tab-bar-clearance';

export const FAB_SIZE = 56;
export const FAB_MARGIN = 16;

type AgentSessionListContentProps = {
  /** Post-deletion focus anchor: the screen's always-mounted search input. */
  searchInputRef: Parameters<typeof moveA11yFocus>[0];
  sections: SessionSection[];
  activeSessionIds: ReadonlySet<string>;
  hasAnySessions: boolean;
  isLoading: boolean;
  /** Body-driving error flag — a search failure (when searching) OR a
   * stored/history failure. */
  isError: boolean;
  /**
   * True when the stored query delivered rows since this screen mounted. A
   * failed stored load with only rows cached from an earlier mount shows the
   * retryable full-screen error; rows delivered this mount keep rendering.
   */
  hasFreshHistory: boolean;
  isFetchingNextPage: boolean;
  refetch: () => Promise<void>;
  onRetry: () => void;
  onEndReached: () => void;
  onSessionPress: (sessionId: string, organizationId?: string | null, title?: string) => void;
  /**
   * Count of refreshes the screen settled outside the pull lifecycle (focus
   * return, app foreground). When it advances, a standing pull failure is
   * stale — the list was just refreshed — so the gesture failure line retires
   * while the query error state keeps owning persistent failures.
   */
  nonPullRefreshes: number;
  hasActiveQuery: boolean;
  isSearching: boolean;
  /** Committed (debounced) search query — scroll-to-top fires when this value changes. */
  searchQuery: string;
  onClearQuery: () => void;
  /** Optional no-op accepted for the history screen's call-site compatibility. */
  onCreateSession?: () => void;
};

export function AgentSessionListContent({
  searchInputRef,
  sections,
  activeSessionIds,
  hasAnySessions,
  isLoading,
  isError,
  hasFreshHistory,
  isFetchingNextPage,
  refetch,
  onRetry,
  onEndReached,
  onSessionPress,
  nonPullRefreshes,
  hasActiveQuery,
  isSearching,
  searchQuery,
  onClearQuery,
}: Readonly<AgentSessionListContentProps>) {
  const listRef = useRef<FlashListRef<SessionListRow>>(null);
  useScrollToTop(listRef);

  // Scroll to top on committed-query change only. Skip the initial mount
  // (offset is already 0). Must not fire on focus refetch, attention
  // revision, sort remount, pagination, pull-to-refresh, or section-data
  // identity changes with an unchanged query.
  const prevSearchQueryRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSearchQueryRef.current;
    prevSearchQueryRef.current = searchQuery;
    if (!shouldResetScrollOnCommittedQuery(prev, searchQuery)) {
      return;
    }
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [searchQuery]);

  const colors = useThemeColors();
  const { t } = useTranslation();
  const { left, right } = useSafeAreaInsets();
  // The tabs layout's width-aware label decision rides along, so the list
  // clearance tracks the bar height the layout actually renders.
  const tabBarHeight = useEffectiveTabBarHeight();
  const { deleteSession, renameSession } = useSessionMutations();
  // The stored refetch resolves void: a pull failure surfaces through the
  // query error state (showInlineError below), so a settlement is always
  // "accepted" here. Only the feedback budget can fail a history pull.
  const pull = usePullRefresh(async () => {
    await refetch();
    return true;
  });
  const { markSettled } = pull;
  const pullBusy = pull.refreshing || pull.busy;
  const handleRefresh = () => {
    pull.startPull();
  };
  const handlePullRetry = () => {
    pull.startRetry();
  };
  // The screen refreshes outside the pull lifecycle (focus return, app
  // foreground). When one settles, a standing pull failure is stale — the
  // list was just refreshed — so retire the gesture failure line. The
  // query-driven error (showInlineError below) still owns persistent
  // failures and auto-clears on recovery, as it did before the pull state.
  useEffect(() => {
    markSettled();
  }, [nonPullRefreshes, markSettled]);

  // The tab bar is an absolutely-positioned overlay, so scrollable content
  // must clear it or the last rows are stuck underneath it. The history list
  // owns no FAB, so a bottom-only TabBar clearance is the only inset the
  // content container needs.
  const tabBarOnlyClearanceStyle = useMemo(() => ({ paddingBottom: tabBarHeight }), [tabBarHeight]);

  // The landscape side insets keep row text clear of the sensor housing
  // (portrait insets are 0, keeping the geometry unchanged). They live on a
  // wrapper around the list rather than on `contentContainerStyle`.
  const landscapeSideInsetStyle = useMemo(
    () => ({ paddingLeft: left, paddingRight: right }),
    [left, right]
  );

  // Pure body decision — see `session-list-body-model.ts`.
  const bodyModel = selectSessionListBodyModel({
    hasHistoryContent: sections.length > 0,
    hasActiveQuery,
    isSearching,
    isError,
  });

  const surface = selectSessionListContentSurface({
    isLoading,
    isError,
    hasAnySessions,
    hasHistoryContent: sections.length > 0,
    hasActiveQuery,
    hasFreshHistory,
  });

  const clearQueryAction = useMemo(
    () => (
      <Button variant="outline" onPress={onClearQuery}>
        <Text>{isSearching ? t('common.clearSearch') : t('common.clearFilters')}</Text>
      </Button>
    ),
    [isSearching, onClearQuery, t]
  );

  // The tabs navigator uses `freezeOnBlur`, so while the session detail screen
  // is pushed the Agents list is frozen. On return, each row re-reads the ack
  // store via its own `useSyncExternalStore` subscription
  // (`useSessionAttentionRevision`). Snapshot the attention revision only when
  // the tab (re)gains focus via `useFocusEffect` (fires after unfreeze) and
  // pass it as `extraData` so visible cells re-render without remounting the
  // list — preserving scroll.
  const [attentionFocusRevision, setAttentionFocusRevision] = useState(getRevisionSnapshot);
  useFocusEffect(
    useCallback(() => {
      setAttentionFocusRevision(getRevisionSnapshot());
    }, [])
  );

  // Screen-reader status for the in-flight pull on the non-list surfaces:
  // those already carry their own Retry (QueryError / BodyEmpty), so the pull
  // only announces Updating here (same contract as the live Agents tab). The
  // rows surface renders the visible reserved status line instead.
  const updatingStatus = pullBusy ? (
    <AccessibleStatus
      message={t('agents.sessionList.updating')}
      tone="status"
      className="absolute size-px overflow-hidden"
    />
  ) : null;
  // The rows list starts at the FlashList's top edge, where Android's floating
  // indicator would rest on the first row's text (device defect uxs1):
  // `RowsRefreshControl` carries the platform rule that keeps it off the rows.
  const refreshControl = <RefreshControl refreshing={pull.refreshing} onRefresh={handleRefresh} />;
  const rowsControl = <RowsRefreshControl refreshing={pull.refreshing} onRefresh={handleRefresh} />;

  // Flatten the date sections into a single row array for the recycling list.
  // While the first page loads with nothing to show, reserved skeleton rows
  // render in the data itself — not `ListEmptyComponent`: FlashList
  // mis-lays-out the empty → populated transition (one stray row over a blank
  // gap until a later commit), while a populated →
  // populated swap reuses the reserved space in place. The `sections.length`
  // guard keeps the old `ListEmptyComponent` semantics: rows already on
  // screen (e.g. stale search results while a new query is pending) are never
  // overwritten by skeletons. Memoized so pagination, refresh, and focus
  // re-renders keep the same array identity while `sections` is unchanged.
  const showLoadingSkeletons =
    surface.kind === 'session-list' && surface.listEmpty === 'loading-skeletons';
  const rows = useMemo(
    () =>
      showLoadingSkeletons && sections.length === 0
        ? skeletonSessionRows()
        : flattenSessionSections(sections),
    [showLoadingSkeletons, sections]
  );

  // Pagination is user-driven. A programmatic page-one reset (the foreground,
  // focus and pull reconciles) empties the retained pages, so the list shrinks
  // under the viewport once the new page one lands, and FlashList reports that
  // shrink as an end-reach. Honoring it re-fetched one page per retained page
  // around a foreground transition instead of the single page the reconcile
  // re-issued (device defect e2). A shrink therefore parks pagination until the
  // next user drag; a query change that resets the list parks it too, and the
  // drag the user makes to browse resumes it.
  const paginationParkedRef = useRef(false);
  const previousRowCountRef = useRef(rows.length);
  useEffect(() => {
    if (rows.length < previousRowCountRef.current) {
      paginationParkedRef.current = true;
    }
    previousRowCountRef.current = rows.length;
  }, [rows.length]);
  const handleEndReached = useCallback(() => {
    if (paginationParkedRef.current) {
      return;
    }
    onEndReached();
  }, [onEndReached]);
  const handleScrollBeginDrag = useCallback(() => {
    paginationParkedRef.current = false;
  }, []);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<SessionListRow>) => {
      if (item.kind === 'skeleton') {
        // Reserved cold-open slot. The pitch must equal the stored session-row
        // pitch (SessionRow: py-[13px] + eyebrow/title ≈ 61dp) so the rows
        // swap into the reserved space without a surrounding jump:
        // 12dp wrapper padding + 49dp block = 61dp.
        return (
          <View className="py-1.5">
            <Skeleton className="mx-[22px] h-[49px] rounded-none" />
          </View>
        );
      }
      if (item.kind === 'section-header') {
        return <SessionListSectionHeader title={item.title} count={item.count} />;
      }
      return (
        <StoredSessionRow
          session={item.session}
          sortBy={SESSION_LIST_SORT}
          live={activeSessionIds.has(item.session.session_id)}
          metaWhileLive
          onPress={() => {
            onSessionPress(
              item.session.session_id,
              item.session.organization_id,
              item.session.title ?? undefined
            );
          }}
          onDelete={() => {
            // The hook's success toast announces the deletion; onDeleted only
            // restores focus, and moveA11yFocus no-ops once the header is
            // unmounted (last session deleted).
            deleteSession(item.session.session_id, () => {
              moveA11yFocus(searchInputRef);
            });
          }}
          onRename={newTitle => {
            renameSession(item.session.session_id, newTitle);
          }}
        />
      );
    },
    [activeSessionIds, onSessionPress, deleteSession, renameSession, searchInputRef]
  );

  const keyExtractor = useCallback((row: SessionListRow) => row.key, []);

  const getItemType = useCallback((row: SessionListRow) => row.kind, []);

  // Full-screen error only when there is nothing this screen loaded to fall
  // back on — a background refetch/search failure with rows already delivered
  // to this mount (keepPreviousData) must never blank out what's already
  // rendered. Rows cached by an earlier mount do not count as a fallback: a
  // fresh open whose own load failed shows the retryable error instead of
  // presenting them as loaded (see `selectSessionListContentSurface`).
  // Gated on !isLoading so a cold-open load never flashes this surface.
  if (surface.kind === 'full-screen-error') {
    return (
      <Animated.View entering={FadeIn.duration(200)} className="flex-1">
        {updatingStatus}
        <QueryError
          message={t('common.couldNotLoadSessions')}
          onRetry={onRetry}
          refreshControl={refreshControl}
        />
      </Animated.View>
    );
  }

  // No stored rows and no active query: render the history-empty body ("No
  // past sessions" with no create CTA) full-screen, skipping the list.
  // Gated on !isLoading (via surface) so a cold open with an empty cache does
  // not flash this while queries run.
  if (surface.kind === 'history-empty') {
    return (
      <Animated.View entering={FadeIn.duration(200)} className="flex-1">
        {updatingStatus}
        <BodyEmpty
          kind="no-past-sessions"
          isSearching={isSearching}
          clearQueryAction={clearQueryAction}
          onRetry={onRetry}
          refreshControl={refreshControl}
        />
      </Animated.View>
    );
  }

  // Single FlashList render site. The loading phase renders reserved skeleton
  // rows in the data itself (see `rows` above); the non-loading empty bodies
  // early-return above, so the list never needs a `ListEmptyComponent` — the
  // FlashList empty → populated transition is what mis-lays-out the swap.
  if (surface.listEmpty === 'body-empty' && bodyModel.kind !== 'render-list') {
    return (
      <Animated.View entering={FadeIn.duration(200)} className="flex-1">
        {updatingStatus}
        <BodyEmpty
          kind={bodyModel.kind}
          isSearching={isSearching}
          secondaryAction={
            bodyModel.kind === 'query-error-empty' ? bodyModel.secondaryAction : undefined
          }
          clearQueryAction={clearQueryAction}
          onRetry={onRetry}
          refreshControl={refreshControl}
        />
      </Animated.View>
    );
  }

  // No entering fade on the list surface: the loading skeletons are the
  // reserved space and must paint at full opacity from the first frame — a
  // 200ms fade reads as a blank list area on a fast cold open (the skeleton
  // phase would live entirely inside the fade). The skeleton → rows swap is
  // a same-pitch data update inside the mounted list.
  //
  // `gap-2` is the clearance between the status band and the rows — the same
  // gap the live surface leaves below its band (`mx-4 gap-2` in
  // `AgentSessionsSection`). Without it the list's top edge sits flush on the
  // band, and a row resting across that edge is cut mid-text directly under
  // "Couldn't refresh", so the two read as colliding (device defect p5). The
  // gap lives on the container rather than as the band's padding on purpose:
  // the clearance must not depend on whether the status line renders, or the
  // failure line would push the rows down by the gap as it appears.
  return (
    <Animated.View className="flex-1 gap-2">
      {/* The band's height is allocated whenever the rows show, so the
          in-flight spinner and the failure line replace empty space instead of
          pushing the rows down (device defect uxs1). */}
      <View className="mx-[22px] min-h-5">
        <SessionListRefreshStatus
          busy={pullBusy}
          failed={pull.failed || bodyModel.showInlineError}
          onRetry={handlePullRetry}
        />
      </View>
      <View className="flex-1" style={landscapeSideInsetStyle}>
        <FlashList<SessionListRow>
          ref={listRef}
          data={rows}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          getItemType={getItemType}
          extraData={attentionFocusRevision}
          ListFooterComponent={
            isFetchingNextPage ? (
              <View className="py-4">
                <ActivityIndicator color={colors.mutedForeground} />
              </View>
            ) : null
          }
          contentContainerStyle={tabBarOnlyClearanceStyle}
          keyboardDismissMode="on-drag"
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.5}
          onScrollBeginDrag={handleScrollBeginDrag}
          refreshControl={rowsControl}
          maintainVisibleContentPosition={{ autoscrollToTopThreshold: 10 }}
        />
      </View>
    </Animated.View>
  );
}
