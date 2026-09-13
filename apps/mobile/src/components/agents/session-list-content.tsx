/* eslint-disable max-lines -- Session-list content and its error/empty surfaces are kept together. */
import { FlashList, type FlashListRef, type ListRenderItemInfo } from '@shopify/flash-list';
import { useFocusEffect, useScrollToTop } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, useWindowDimensions, View } from 'react-native';
import { RefreshControl } from '@/components/ui/refresh-control';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BodyEmpty } from '@/components/agents/session-list-body-empty';
import { selectSessionListBodyModel } from '@/components/agents/session-list-body-model';
import { selectSessionListContentSurface } from '@/components/agents/session-list-content-surface';
import { type SessionSection } from '@/components/agents/session-list-helpers';
import { SessionListRefreshStatus } from '@/components/agents/session-list-refresh-status';
import {
  flattenSessionSections,
  type SessionListRow,
  skeletonSessionRows,
  stickySessionHeaderIndices,
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
import { getEffectiveTabBarHeight } from '@/lib/tab-bar-layout';

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
  const { bottom, left, right } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
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
  const tabBarOnlyClearanceStyle = useMemo(
    () => ({
      paddingBottom: getEffectiveTabBarHeight({
        bottomInset: bottom,
        platform: Platform.OS,
        fontScale,
      }),
    }),
    [bottom, fontScale]
  );

  // The landscape side insets keep row text clear of the sensor housing
  // (portrait insets are 0, keeping the geometry unchanged). They live on a
  // wrapper around the list, NOT on `contentContainerStyle`: FlashList renders
  // pinned sticky headers in an absolutely positioned overlay (`left:0;
  // right:0`), so content-container padding insets the in-flow rows but not
  // the pinned copy, and the header would jump horizontally by the side inset
  // the moment it pins. The wrapper insets both from the same origin.
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

  // The data index FlashList currently pins. FlashList renders that header row
  // twice — in flow and in its absolutely positioned sticky overlay — and both
  // copies are announced by a screen reader. `renderItem` below hides the
  // in-flow copy while this index is pinned, so each pinned date is announced
  // once. Updated only when the pinned header changes (section boundaries).
  //
  // `pinnedHeaderIndex` is a `renderItem` dependency, so a pin move produces a
  // new `renderItem` identity. FlashList 2.x re-renders a mounted cell when
  // `renderItem` changes even without `extraData`: its `ViewHolder` memo
  // compares `renderItem` (dist/recyclerview/ViewHolder.js) and recomputes the
  // rendered children from it, so the newly pinned in-flow header picks up
  // `hiddenFromA11y`. `extraData` is therefore not needed here.
  const [pinnedHeaderIndex, setPinnedHeaderIndex] = useState(-1);

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
  const refreshControl = <RefreshControl refreshing={pull.refreshing} onRefresh={handleRefresh} />;

  // Flatten the date sections into a single row array for the recycling list.
  // While the first page loads with nothing to show, reserved skeleton rows
  // render in the data itself — not `ListEmptyComponent`: FlashList
  // mis-lays-out the empty → populated transition (sticky header plus one
  // stray row over a blank gap until a later commit), while a populated →
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
  // `SectionList` pinned iOS date-section headers by default; FlashList needs
  // those row indices named explicitly to keep them pinned. Derived from the
  // same `rows` array so header order stays identical.
  const stickyHeaderIndices = useMemo(() => stickySessionHeaderIndices(rows), [rows]);

  const renderItem = useCallback(
    ({ item, index, target }: ListRenderItemInfo<SessionListRow>) => {
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
        // Hide the in-flow header from the accessibility tree while FlashList
        // pins that same row: the sticky overlay spells it once already.
        const pinnedInFlow = target !== 'StickyHeader' && index === pinnedHeaderIndex;
        return (
          <SessionListSectionHeader
            title={item.title}
            count={item.count}
            hiddenFromA11y={pinnedInFlow}
          />
        );
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
    [
      activeSessionIds,
      onSessionPress,
      deleteSession,
      renameSession,
      searchInputRef,
      pinnedHeaderIndex,
    ]
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
  return (
    <Animated.View className="flex-1">
      <SessionListRefreshStatus
        busy={pullBusy}
        failed={pull.failed || bodyModel.showInlineError}
        onRetry={handlePullRetry}
        className="mx-[22px]"
      />
      <View className="flex-1" style={landscapeSideInsetStyle}>
        <FlashList<SessionListRow>
          ref={listRef}
          data={rows}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          getItemType={getItemType}
          stickyHeaderIndices={stickyHeaderIndices}
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
          onEndReached={onEndReached}
          onEndReachedThreshold={0.5}
          refreshControl={refreshControl}
          maintainVisibleContentPosition={{ autoscrollToTopThreshold: 10 }}
          onChangeStickyIndex={setPinnedHeaderIndex}
        />
      </View>
    </Animated.View>
  );
}
