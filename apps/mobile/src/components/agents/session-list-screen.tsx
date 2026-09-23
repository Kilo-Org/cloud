/* eslint-disable max-lines -- The live list keeps its query, pull-refresh, keyboard container, and FAB orchestration together on one screen. */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import {
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  useWindowDimensions,
  View,
} from 'react-native';
import { RefreshControl } from '@/components/ui/refresh-control';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Bot, Plus } from '@/components/ui/icons';

import { StateSurfaceInsets } from '@/components/centered-state-surface';
import { EmptyState } from '@/components/empty-state';
import { LiveSessionFeedback } from '@/components/home/agent-sessions-section';
import { liveSessionContent, useLiveSessionContext } from '@/components/home/live-session-state';
import { LiveSessionListEmptyState } from '@/components/agents/live-session-list-empty-state';
import { SessionFilterModal } from '@/components/agents/platform-filter-modal';
import { RowsRefreshControl } from '@/components/agents/rows-refresh-control';
import { SessionFilterButton } from '@/components/agents/session-filter-button';
import { SessionListSearchHeader } from '@/components/agents/session-list-search-header';
import { getSessionKeyboardContainerKind } from '@/components/agents/session-keyboard-container-state';
import { useLiveSessionQuery } from '@/components/agents/use-live-session-query';
import { usePullRefresh } from '@/components/agents/use-pull-refresh';
import { getNewAgentSessionPath } from '@/components/agents/session-list-routes';
import { RemoteSessionRow } from '@/components/agents/remote-session-row';
import { FAB_MARGIN, FAB_SIZE } from '@/components/agents/session-list-content';
import {
  useAgentsBottomBands,
  useSessionListInsets,
} from '@/components/agents/session-list-chrome';
import { useAgentSessionNavigator } from '@/components/agents/use-agent-session-navigator';
import { useAgentsListChrome } from '@/components/agents/use-agents-list-chrome';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { ScreenHeader } from '@/components/screen-header';
import { AppAwareKeyboardPaddingView } from '@/components/kilo-chat/app-aware-keyboard-padding';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getRevisionSnapshot } from '@/lib/session-attention';
import { useEffectiveTabBarHeight } from '@/lib/tab-bar-clearance';
import { type ActiveSession, useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';

import { type Href, useFocusEffect, useNavigation, useRouter, useScrollToTop } from 'expo-router';

const SKELETON_ROW_COUNT = 8;

/** The See-all label's uppercase micro type, kept out of the JSX so the long
 * class list does not force the `Text` open tag to wrap. */
const SEE_ALL_TEXT_CLASS =
  'shrink text-center font-mono-medium text-[11px] uppercase tracking-[1.5px] text-primary';

export function AgentSessionListScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { left, right } = useSafeAreaInsets();
  // The tabs layout's width-aware label decision rides along, so this screen's
  // clearance (list frame, FAB and state-surface insets) tracks the bar height.
  const tabBarHeight = useEffectiveTabBarHeight();
  // The empty state's own height grows with Dynamic Type, so the list chrome's
  // presentation decision needs the window's text scale (see
  // `useAgentsListChrome`).
  const { fontScale } = useWindowDimensions();
  // Android runs edge-to-edge and never resizes the window for the IME, so the
  // native KeyboardAvoidingView is inert there; the app-aware container follows
  // the keyboard events instead (the repo's one platform fork for this).
  const keyboardContainerKind = getSessionKeyboardContainerKind(Platform.OS);

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
  // The screen's bottom bands. Both are keyboard-aware: while the keyboard is up
  // the IME's occlusion replaces the tab-bar band, because the bar hides with
  // the keyboard (`tabBarHideOnKeyboard`). Android's edge-to-edge window does
  // not resize for the IME, so without that reserve the centered empty states
  // draw their copy and Clear search action behind the keyboard (explorer
  // finding, agents-list / agents-search-empty) and the last rows of a search
  // park behind it (review finding, session-list-chrome.ts). The rows list's
  // total band is floored at the FAB's own overlay band inside the hook, because
  // the button keeps its screen-bottom-anchored position while the keyboard is
  // up (device defect uxs1); the frame carries only the part the keyboard
  // container leaves (`rowsFrameBand`). The chrome hook below supplies the
  // keyboard-down geometry — the FAB-aware centered reserve and the
  // short-window frame clamp — so this hook's `surfaceBand` is the IME half of
  // the centered band while the keyboard is up and the keyboard-down rule is not
  // re-resolved here (review findings, session-list-chrome.ts:48 and
  // session-list-screen.tsx:418). This is the screen's only keyboard
  // subscription beside the container below: calling the occlusion hook here as
  // well subscribed to the same events a second time (review finding,
  // session-list-screen.tsx:101).
  const { surfaceBand, rowsFrameBand } = useAgentsBottomBands(tabBarHeight, showFab);
  const [showFilterModal, setShowFilterModal] = useState(false);

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

  const seeAllLabel = t('home.seeAll');
  // The list controls share the title's row through the header's `inlineActions`
  // slot, trailing the eyebrow + title heading. The heading keeps
  // `min-w-0 flex-1`, so the 30px title keeps its tail ellipsis while the
  // controls keep their full width — sharing that row through the old
  // `headerRight` half-row cap squeezed both columns on a narrow viewport until
  // the title broke mid-word and this label stacked onto two lines (device
  // capture at 480x1040: "Age / nts" beside "SEE / ALL"). The reserved row
  // height keeps the header from moving when the filter button appears with the
  // loaded sessions, and the box can shrink so an extreme accessibility scale
  // ellipsizes the label instead of wrapping it to a second line.
  const headerActions = (
    <View className="min-h-11 min-w-0 shrink flex-row items-center justify-end gap-4">
      <Pressable
        onPress={() => {
          router.push('/(app)/(tabs)/(2_agents)/history' as Href);
        }}
        // left slop capped against the gap, right slop reaches 44pt wide
        hitSlop={{ top: 12, bottom: 12, left: 8, right: 16 }}
        accessibilityRole="button"
        accessibilityLabel={seeAllLabel}
        testID="agents-view-history"
        className="min-w-0 shrink justify-center active:opacity-70"
      >
        <Text numberOfLines={1} className={SEE_ALL_TEXT_CLASS}>
          {seeAllLabel}
        </Text>
      </Pressable>
      {query.canFilter ? (
        <SessionFilterButton
          activeCount={query.activeFilterCount}
          onPress={() => {
            setShowFilterModal(true);
          }}
          testID="agents-open-filters"
        />
      ) : null}
    </View>
  );

  const renderItem = useCallback(
    ({ item }: { item: ActiveSession }) => (
      <RemoteSessionRow
        session={item}
        onPress={() => {
          navigateToSession(item.id, organizationId);
        }}
      />
    ),
    [navigateToSession, organizationId]
  );

  // The FAB style, the side padding, the body measurement, and the centered
  // states' reserve and presentation come from the list-chrome owner (see
  // `useAgentsListChrome`). The rows list's bottom split stays here: the FAB
  // clearance rides on the list's content, so the frame keeps only the tab bar
  // (see `listInsets` below).
  const { onBodyLayout, fabStyle, sidePadding, centeredBottomInset, compactEmptyState } =
    useAgentsListChrome({ showFab, tabBarHeight, fontScale, left, right });

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

  // The centered states' reserve: the FAB-aware band the chrome hook resolves
  // while the keyboard is down (a centered state's full-width action must not
  // reach under the corner overlay, device defect e3) and the IME's occlusion
  // while it is up, so the two never stack (explorer finding,
  // agents-search-empty).
  const centeredBand = keyboardUp ? surfaceBand : centeredBottomInset;

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
    body = (
      <View className="pt-[18px]">
        {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
          <View key={i} className="py-1.5" style={sidePadding}>
            <Skeleton className="h-[76px] rounded-none" />
          </View>
        ))}
      </View>
    );
  } else if (hasLiveRows && visibleSessions.length === 0) {
    // The reserved band is mounted here too (the sessions exist behind the
    // filter), so the native control gets the same treatment as the rows
    // list: on Android the band carries the in-flight spinner and the
    // platform disc is parked off the body, so no second spinner is drawn
    // over it (device defect uxs1). That body is centered, so it draws the
    // pull's own progress while reduced motion is on, and the band then
    // yields its spinner to it (`progressInBody` on the reserved line).
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
        compact={compactEmptyState}
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
        className={query.hasLoaded && content === 'error' ? 'flex-1' : undefined}
        style={query.hasLoaded && content === 'error' ? undefined : sidePadding}
      >
        <LiveSessionFeedback
          context={context}
          sessions={sessions}
          failureLabel={t('agents.sessionList.couldNotLoadActive')}
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
    // The band the centered states are laid out in: the chrome hook's FAB-aware
    // reserve while the keyboard is down — the FAB's band joins the tab bar's so
    // a centered state's full-width action (the load failure's Retry, the
    // boundary's back-to-profile) cannot reach under the corner overlay (device
    // defect e3) — and the IME's occlusion while it is up, because the raised
    // keyboard hides the tab bar and its band must not stack on the IME's. See
    // `centeredBand` above.
    <StateSurfaceInsets bottomInset={centeredBand}>
      <View className="flex-1 bg-background">
        <ScreenHeader
          title={t('common.agents')}
          eyebrow={
            // The count is an assertion about the current snapshot, so it is
            // withheld whenever that snapshot cannot be confirmed: while the
            // list is unresolved (loading or membership unknown) and while the
            // live query is in an error state, exactly as the tab badge is.
            // The cached rows themselves stay on screen, so a failed refresh
            // never blanks the list it kept.
            !sessions.isLoading && !sessions.isError && (hasLiveRows || content === 'empty')
              ? t('agents.liveCount', { count: activeSessions.length })
              : undefined
          }
          reserveEyebrow
          size="large"
          showBackButton={false}
          className="px-[22px] pb-1"
          inlineActions={headerActions}
        />
        {hasLiveRows || isSearching ? (
          <SessionListSearchHeader
            inputRef={query.searchInputRef}
            hasText={query.searchQuery.length > 0}
            showSearchBusy={false}
            onChangeText={query.handleSearchChange}
            onClearSearch={query.handleClearSearch}
          />
        ) : null}
        {keyboardContainerKind === 'app-aware-padding' ? (
          <AppAwareKeyboardPaddingView className="flex-1">{region}</AppAwareKeyboardPaddingView>
        ) : (
          <KeyboardAvoidingView className="flex-1" behavior="padding">
            {region}
          </KeyboardAvoidingView>
        )}
        {/* Empty content owns its creation action; the no-match body owns the band. */}
        {showFab && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.newSession')}
            testID="agents-new-session-fab"
            onPress={() => {
              router.push(getNewAgentSessionPath(organizationId) as Href);
            }}
            className="absolute items-center justify-center rounded-full bg-primary shadow-lg shadow-[#00000040] active:opacity-80"
            style={fabStyle}
          >
            <Plus size={24} color={colors.primaryForeground} />
          </Pressable>
        )}
        {showFilterModal && (
          <SessionFilterModal
            selectedPlatforms={query.platformFilter}
            selectedProjects={query.projectFilter}
            projectOptions={query.options.projectOptions}
            platformOptions={query.options.platformOptions}
            onClose={() => {
              setShowFilterModal(false);
            }}
            onApply={query.handleApplyFilters}
          />
        )}
      </View>
    </StateSurfaceInsets>
  );
}
