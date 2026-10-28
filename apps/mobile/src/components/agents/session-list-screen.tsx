/* eslint-disable max-lines -- The live list keeps its query, pull-refresh, keyboard container, and FAB orchestration together on one screen. */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { AppState, Keyboard, Pressable, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useLiveFontScale } from '@/lib/font-scale/system-font-scale-context';
import { RefreshControl } from '@/components/ui/refresh-control';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Bot, History } from '@/components/ui/icons';

import { StateSurfaceInsets } from '@/components/centered-state-surface';
import { EmptyState } from '@/components/empty-state';
import { LiveSessionFeedback } from '@/components/home/agent-sessions-section';
import { liveSessionContent, useLiveSessionContext } from '@/components/home/live-session-state';
import { LiveSessionListEmptyState } from '@/components/agents/live-session-list-empty-state';
import { SessionFilterModal } from '@/components/agents/platform-filter-modal';
import { RowsRefreshControl } from '@/components/agents/rows-refresh-control';
import { SessionListHeader } from '@/components/agents/session-list-header';
import { SessionListSearchHeader } from '@/components/agents/session-list-search-header';
import { SessionListSkeletonRows } from '@/components/agents/session-list-skeleton-rows';
import { useLiveSessionQuery } from '@/components/agents/use-live-session-query';
import { usePullRefresh } from '@/components/agents/use-pull-refresh';
import { SessionListFab } from '@/components/agents/session-list-fab';
import { RemoteSessionRow } from '@/components/agents/remote-session-row';
import { FAB_MARGIN, FAB_SIZE } from '@/components/agents/session-list-content';
import {
  useAgentsBottomBands,
  useSessionListInsets,
} from '@/components/agents/session-list-chrome';
import { useAgentSessionNavigator } from '@/components/agents/use-agent-session-navigator';
import { useAgentsListChrome } from '@/components/agents/use-agents-list-chrome';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { IconButton } from '@/components/ui/icon-button';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { STATE_ACTION_CLASS, textActionTargetClass } from '@/lib/a11y/tap-target';
import { getRevisionSnapshot } from '@/lib/session-attention';
import { useEffectiveTabBarHeight } from '@/lib/tab-bar-clearance';
import { type ActiveSession, useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';
import { cn } from '@/lib/utils';

import { type Href, useFocusEffect, useNavigation, useRouter, useScrollToTop } from 'expo-router';

type AgentSessionListScreenProps = { tabHeader?: ReactNode };
export function AgentSessionListScreen({ tabHeader }: Readonly<AgentSessionListScreenProps> = {}) {
  const router = useRouter();
  const navigation = useNavigation();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { left, right } = useSafeAreaInsets();
  // The tabs layout's width-aware label decision rides along, so this screen's
  // clearance (list frame, FAB and state-surface insets) tracks the bar height.
  const tabBarHeight = useEffectiveTabBarHeight();
  // The empty state's own height grows with Dynamic Type, so the list chrome's
  // presentation decision needs the window's text scale (see
  // `useAgentsListChrome`).
  const fontScale = useLiveFontScale();

  const context = useLiveSessionContext();
  const { organizationId, isError: isContextError, refetch: refetchContext } = context;
  const sessions = useLiveAgentSessions({ organizationId, enabled: context.isReady });
  const { activeSessions, refetch } = sessions;
  const content = liveSessionContent(context, sessions);
  const hasLiveRows = content === 'rows';
  // A failed foreground refresh keeps the cached rows on screen. That failure
  // must speak through the reserved status line (one inline "Couldn't refresh"
  // with Retry) instead of the load-failure block, which would push the kept
  // rows down. Treat it exactly like a failed pull when rows are still shown.
  const retryableRowsFailure = hasLiveRows && sessions.terminalError?.kind === 'retryable';

  const query = useLiveSessionQuery(activeSessions);
  const { visibleSessions, isSearching } = query;
  // The no-match body is the state the tab bar's band was reopened for, and its
  // compact form fills that band down to the corner the FAB floats in. Since
  // reserving the FAB's band here is what parked the state's second line and
  // action behind the tab bar in a short landscape window (landscape spot
  // defect e8), a state that fills the band owns it and the FAB yields: it
  // must not sit over the description or the Clear action at a large text
  // scale. The list bodies keep it — they clear it with their own frame inset —
  // and so does the load-failure body, whose FAB is the only creation
  // affordance while the list is failing.
  const noMatchBody = hasLiveRows && visibleSessions.length === 0;
  const showFab = context.isReady && content !== 'empty' && !noMatchBody;
  const { surfaceBand, rowsFrameBand } = useAgentsBottomBands(tabBarHeight, showFab);
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const showSearch = searchOpen || query.searchQuery.length > 0;
  useEffect(() => {
    if (searchOpen) {
      query.searchInputRef.current?.focus();
    }
  }, [searchOpen, query.searchInputRef]);
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  // The wrapped live refetch resolves `false` when the refresh did not land an
  // accepted result; the context path reports through its own error state.
  const refetchRequest = useCallback(async () => {
    if (isContextError) {
      await refetchContext();
      return true;
    }
    return refetch();
  }, [isContextError, refetchContext, refetch]);
  // The pull owns only gesture feedback: past the budget the spinner stops and
  // the reserved status line carries "Couldn't refresh" + Retry, so a hung
  // fetch cannot pin the spinner with no next action.
  const pull = usePullRefresh(refetchRequest);
  const handleRefresh = pull.startPull;
  const { markSettled, startRetry } = pull;
  // The rows list starts at the list's top edge, where Android's floating
  // indicator would rest on the first row's text (device defect uxs1):
  // `RowsRefreshControl` carries the platform rule that keeps it off the rows.
  const refreshControl = <RefreshControl refreshing={pull.refreshing} onRefresh={handleRefresh} />;
  const rowsControl = <RowsRefreshControl refreshing={pull.refreshing} onRefresh={handleRefresh} />;

  // The reserved status line's Retry replaces the removed in-flow failure
  // block, so it inherits that block's idempotence: a second tap before the
  // first refetch settles must not start a second one.
  const retryLock = useRef(false);
  useEffect(() => {
    if (!pull.busy && !pull.refreshing) {
      retryLock.current = false;
    }
  }, [pull.busy, pull.refreshing]);
  const handleRefreshRetry = useCallback(() => {
    if (retryLock.current) {
      return;
    }
    retryLock.current = true;
    startRetry();
  }, [startRetry]);

  // Focus return and app-foreground refreshes run outside the pull lifecycle.
  // A failed pull leaves the reserved line on "Couldn't refresh" + Retry; when
  // one of these refreshes lands an accepted result the list is up to date, so
  // the stale failure line retires exactly as the query-driven error did.
  const runForegroundRefresh = useCallback(() => {
    void (async () => {
      const accepted = await refetchRef.current();
      if (accepted) {
        markSettled();
      }
    })();
  }, [markSettled]);
  useFocusEffect(
    useCallback(() => {
      runForegroundRefresh();
    }, [runForegroundRefresh])
  );

  const listRef = useRef<FlashListRef<ActiveSession>>(null);
  useScrollToTop(listRef);

  // The tabs navigator uses `freezeOnBlur`, so while the session detail screen
  // is pushed the live Agents list is frozen. On return, each row re-reads the
  // ack store via its own `useSyncExternalStore` subscription
  // (`useSessionAttentionRevision`). Snapshot the attention revision when the
  // tab (re)gains focus via `useFocusEffect` (fires after unfreeze) and pass
  // it as `extraData` so visible cells re-render without remounting the list —
  // preserving scroll.
  const [attentionFocusRevision, setAttentionFocusRevision] = useState(getRevisionSnapshot);
  useFocusEffect(
    useCallback(() => {
      setAttentionFocusRevision(getRevisionSnapshot());
    }, [])
  );

  // Refresh the focused list through the live-sync owner.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active' && navigation.isFocused()) {
        runForegroundRefresh();
      }
    });
    return () => {
      subscription.remove();
    };
  }, [navigation, runForegroundRefresh]);

  const navigateToSession = useAgentSessionNavigator();

  const historyLabel = t('agents.sessionList.pastSessions');
  const viewHistoryLabel = t('agents.sessionList.viewHistory');
  const historyControl = (label: string) => (
    <Pressable
      onPress={() => {
        router.push('/(app)/(tabs)/(2_agents)/history' as Href);
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID="agents-view-history-empty"
      className={cn(textActionTargetClass(), 'min-w-0 shrink justify-center active:opacity-70')}
    >
      <Text className="text-sm text-primary" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
  const viewHistoryAction = historyControl(viewHistoryLabel);
  const historyAction = (
    <IconButton
      accessibilityLabel={historyLabel}
      testID="agents-view-history"
      onPress={() => {
        router.push('/(app)/(tabs)/(2_agents)/history' as Href);
      }}
    >
      <History size={20} color={colors.mutedForeground} />
    </IconButton>
  );

  // One handler shared by every row: with the row memoised, a poll that writes
  // an unchanged payload leaves each row's props referentially stable and
  // skips its render entirely. The row's relative timestamp does not come
  // through these props: the row samples the shared clock itself, so it ages
  // without a new payload.
  const handleRowPress = useCallback(
    (session: ActiveSession) => {
      navigateToSession(session.id, organizationId);
    },
    [navigateToSession, organizationId]
  );

  const renderItem = useCallback(
    ({ item }: { item: ActiveSession }) => (
      <RemoteSessionRow session={item} onPress={handleRowPress} />
    ),
    [handleRowPress]
  );

  // The FAB style, the side padding, the body measurement, and the centered
  // states' reserve and presentation come from the list-chrome owner (see
  // `useAgentsListChrome`). The rows list's bottom split stays here: the FAB
  // clearance rides on the list's content, so the frame keeps only the tab bar
  // (see `listInsets` below).
  const {
    onBodyLayout,
    fabStyle,
    sidePadding,
    centeredBottomInset,
    compactEmptyState,
    compactLiveEmptyState,
  } = useAgentsListChrome({ showFab, tabBarHeight, fontScale, left, right });

  // The tab bar and the FAB are absolutely-positioned overlays, so scrollable
  // content must clear them. The tab bar keeps its viewport inset as the list
  // frame's `marginBottom` — the same viewport inset `TabScreenScrollView` uses
  // — so the list's own background runs clean to the tab bar edge with no bare
  // band between the last row and the bar. The FAB's clearance rides on the
  // list's content as `paddingBottom` instead: the button floats over the list,
  // and the end padding still carries the last row clear of it. Frame margin
  // plus content padding together match the screen's `StateSurfaceInsets`. The
  // landscape side insets keep row text clear of the sensor housing; portrait
  // insets are 0, keeping the geometry unchanged.
  const listInsets = useMemo(() => {
    const fabPad = showFab ? FAB_SIZE + FAB_MARGIN : 0;
    return {
      frame: { marginBottom: tabBarHeight },
      content: { paddingTop: 0, paddingBottom: fabPad, paddingLeft: left, paddingRight: right },
    };
  }, [showFab, tabBarHeight, left, right]);

  // The rows list's total band, mirroring `useAgentsBottomBands`'s `listBand`
  // (the hook keeps that value private): while the FAB is admitted its overlay
  // band joins the surface band, otherwise the surface band stands alone. The
  // keyboard container's padding is exactly what `rowsFrameBand` falls short of
  // the total, so `rowsFrameBand < rowsListBand` holds exactly while the IME is
  // up.
  const rowsListBand = Math.max(surfaceBand, showFab ? tabBarHeight + FAB_SIZE + FAB_MARGIN : 0);
  const keyboardUp = rowsFrameBand < rowsListBand;

  // The rows list's frame and content insets. While the keyboard is down the
  // screen's own split owns them: the frame ends at the tab bar (no bare band)
  // and the FAB clearance rides on the content, so the button floats over the
  // list and the last row still scrolls clear of it (see `listInsets` above).
  // While the keyboard is up the container already pads the IME's occlusion, so
  // the frame carries only the remainder of the rows band (`rowsFrameBand`) and
  // the viewport ends at the band's edge instead of a whole IME height above it
  // (review finding, session-list-screen.tsx:418). The landscape side insets
  // keep row text clear of the sensor housing.
  const keyboardRowsInsets = useSessionListInsets({ bottomBand: rowsFrameBand, left, right });
  const rowsInsets = keyboardUp ? keyboardRowsInsets : listInsets;

  let body: ReactNode = null;
  if (!query.hasLoaded || content === 'pending') {
    body = <SessionListSkeletonRows insets={{ left, right }} />;
  } else if (hasLiveRows && visibleSessions.length === 0) {
    // The reserved band is mounted here too (the sessions exist behind the
    // filter), so the native control gets the same treatment as the rows
    // list: on Android the band carries the in-flight spinner and the
    // platform disc is parked off the body, so no second spinner is drawn
    // over it (device defect uxs1). That body is centered, so it draws the
    // pull's own progress while reduced motion is on, and the band then
    // yields its spinner to it (`progressInBody` on the reserved line).
    // The centered body clears the fixed tab bar through the surface
    // reservation this screen already sets: `CenteredState`'s pending-layout
    // fallback pads by `surface.bottomReservation` (the tab bar plus the FAB
    // band) and its measured layout clamps by the same inset. Adding that band
    // as a frame clearance here too reserved it twice and pushed the centered
    // copy roughly half the band above the centre of the area above the bar.
    body = (
      <EmptyState
        icon={Bot}
        title={t('agents.sessionList.noMatches')}
        compact={compactEmptyState}
        refreshControl={rowsControl}
        description={
          isSearching
            ? t('agents.sessionList.tryDifferentSearch')
            : t('agents.sessionList.tryAdjustFilters')
        }
        action={
          <Button
            variant="outline"
            size={compactEmptyState ? 'sm' : 'default'}
            onPress={isSearching ? query.handleClearSearch : query.handleClearFilters}
            className={STATE_ACTION_CLASS}
          >
            <Text>{isSearching ? t('common.clearSearch') : t('common.clearFilters')}</Text>
          </Button>
        }
      />
    );
  } else if (content === 'empty') {
    body = (
      <LiveSessionListEmptyState
        organizationId={organizationId}
        refreshControl={refreshControl}
        compact={compactLiveEmptyState}
        historyAction={viewHistoryAction}
      />
    );
  } else if (hasLiveRows) {
    // The tab-bar inset rides on the list frame, so the viewport ends at the tab
    // bar; the FAB clearance rides on the content's `paddingBottom`, so the
    // button floats over the list and the last row still scrolls clear of it.
    body = (
      // FlashList v2 recycles rows and keeps scroll position; the rows are
      // homogeneous, so one item type is enough. `style` stays the frame object
      // (FlashList's own root already carries `flex: 1`), where a `className`
      // would be ignored.
      <FlashList
        ref={listRef}
        data={visibleSessions}
        renderItem={renderItem}
        keyExtractor={item => item.id}
        extraData={attentionFocusRevision}
        getItemType={() => 'session'}
        style={rowsInsets.frame}
        contentContainerStyle={rowsInsets.content}
        refreshControl={rowsControl}
        maintainVisibleContentPosition={{ autoscrollToTopThreshold: 10 }}
      />
    );
  }

  // The feedback band and the body share one keyboard container so every
  // centered state (no-match, live-empty, skeletons, load failure) re-measures
  // against the viewport the keyboard leaves, not the full window. The header
  // and search field stay outside it and never move.
  const region = (
    <>
      <View
        className={query.hasLoaded && content === 'error' ? 'flex-1' : 'min-h-5'}
        style={query.hasLoaded && content === 'error' ? undefined : sidePadding}
      >
        <LiveSessionFeedback
          context={context}
          sessions={sessions}
          failureLabel={t('agents.sessionList.couldNotLoadActive')}
          compact
          centered={query.hasLoaded && content === 'error'}
          refresh={{
            busy: pull.refreshing || pull.busy,
            failed: pull.failed || retryableRowsFailure,
            onRetry: handleRefreshRetry,
            // The pull's progress belongs to the centered no-match body (the
            // same state that mounts it), so the band does not draw a second
            // spinner while that body shows one.
            progressInBody: hasLiveRows && visibleSessions.length === 0 && pull.refreshing,
          }}
          refreshControl={refreshControl}
        />
      </View>
      {/* The body's wrapper measures the height the list can use; the error
          state renders no body (its centered surface owns the space), so the
          wrapper is skipped there to keep that layout unchanged. */}
      {body ? (
        <View className="flex-1" onLayout={onBodyLayout}>
          {body}
        </View>
      ) : null}
    </>
  );

  return (
    <StateSurfaceInsets bottomInset={centeredBottomInset}>
      <View className="flex-1 bg-background">
        <SessionListHeader
          title={t('common.agents')}
          tabHeader={tabHeader}
          headerAction={historyAction}
          searchOpen={showSearch}
          onOpenSearch={() => {
            if (showSearch) {
              query.searchInputRef.current?.focus();
            } else {
              setSearchOpen(true);
            }
          }}
          canFilter={query.canFilter}
          activeFilterCount={query.activeFilterCount}
          onOpenFilters={() => {
            Keyboard.dismiss();
            setShowFilterModal(true);
          }}
          search={
            <SessionListSearchHeader
              inputRef={query.searchInputRef}
              hasText={query.searchQuery.length > 0}
              showSearchBusy={false}
              onChangeText={query.handleSearchChange}
              defaultValue={query.searchQuery}
              compact
              onClearSearch={query.handleClearSearch}
            />
          }
        />
        {/* Android runs edge-to-edge and never resizes the window for the IME,
            so the keyboard is cleared natively: `KeyboardProvider` measures the
            IME and this view lifts by the overlap it reports. */}
        <KeyboardAvoidingView className="flex-1" behavior="padding">
          {region}
        </KeyboardAvoidingView>
        {/* Empty content owns its creation action; the no-match body owns the band. */}
        {showFab && <SessionListFab organizationId={organizationId} style={fabStyle} />}
        <SessionFilterModal
          visible={showFilterModal}
          selectedPlatforms={query.platformFilter}
          selectedProjects={query.projectFilter}
          projectOptions={query.options.projectOptions}
          platformOptions={query.options.platformOptions}
          onClose={() => {
            setShowFilterModal(false);
          }}
          onApply={query.handleApplyFilters}
        />
      </View>
    </StateSurfaceInsets>
  );
}
