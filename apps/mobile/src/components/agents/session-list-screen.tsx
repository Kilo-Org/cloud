/* eslint-disable max-lines -- The live list keeps its query, pull-refresh, keyboard container, and FAB orchestration together on one screen. */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  FlatList,
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
import { useAgentSessionNavigator } from '@/components/agents/use-agent-session-navigator';
import { Button } from '@/components/ui/button';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { ScreenHeader } from '@/components/screen-header';
import { AppAwareKeyboardPaddingView } from '@/components/kilo-chat/app-aware-keyboard-padding';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getRevisionSnapshot } from '@/lib/session-attention';
import { getEffectiveTabBarHeight } from '@/lib/tab-bar-layout';
import { type ActiveSession, useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';

import { type Href, useFocusEffect, useNavigation, useRouter, useScrollToTop } from 'expo-router';

const SKELETON_ROW_COUNT = 8;

export function AgentSessionListScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { bottom, left, right } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();

  const tabBarHeight = useMemo(
    () => getEffectiveTabBarHeight({ bottomInset: bottom, platform: Platform.OS, fontScale }),
    [bottom, fontScale]
  );
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

  const listRef = useRef<FlatList<ActiveSession>>(null);
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
  // The list controls take the header's `context` slot, one line below the
  // title, so the 30px title owns the whole title row (Quick Chat puts its
  // account control in the same slot). Sharing that row through `headerRight`,
  // the slot's half-row cap squeezed both columns on a narrow viewport until
  // the title broke mid-word and this label stacked onto two lines (device
  // capture at 480x1040: "Age / nts" beside "SEE / ALL"). On its own row the
  // control keeps the header's full width at every display size, and the
  // reserved row height keeps the header from moving when the filter button
  // appears with the loaded sessions.
  // The controls row is a section header, not a bare action: its label owns the
  // row start and grows, so the controls keep the row end — the same shape the
  // Home live-sessions header uses. A row holding only the trailing 'See all'
  // read as a section header whose label was missing (e2, agents).
  const headerActions = (
    <View className="min-h-11 min-w-0 flex-row items-center justify-end gap-4">
      <Eyebrow className="min-w-0 grow">{t('home.agentSessions')}</Eyebrow>
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
        <Eyebrow className="shrink text-center text-[11px] text-primary">{seeAllLabel}</Eyebrow>
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

  // The tab bar and the FAB are absolutely-positioned overlays, so scrollable
  // content must clear them. The inset rides on the list's frame as a
  // `marginBottom` (the viewport ends above the band) — the same viewport inset
  // `TabScreenScrollView` uses — never on the list's content and never as
  // `style` padding: a content inset only cleared the end of the list, so every
  // row the user scrolled into the button's band had its right-aligned
  // timestamp and chevron covered, and a scroll view's padding is not part of
  // its scrollable content on iOS, so padding on the frame clipped the last
  // rows under the bar with no way to scroll them clear. The vertical value
  // matches the screen's `StateSurfaceInsets`. The landscape side insets keep
  // row text clear of the sensor housing; portrait insets are 0, keeping the
  // geometry unchanged.
  const listInsets = useMemo(
    () => ({
      frame: { marginBottom: showFab ? tabBarHeight + FAB_SIZE + FAB_MARGIN : tabBarHeight },
      content: { paddingTop: 0, paddingBottom: 0, paddingLeft: left, paddingRight: right },
    }),
    [showFab, tabBarHeight, left, right]
  );

  // The fixed 20pt margin gains the landscape right inset so the FAB clears the
  // sensor area; portrait insets are 0, keeping the geometry unchanged.
  const fabStyle = useMemo(
    () => ({
      bottom: tabBarHeight + FAB_MARGIN,
      right: 20 + right,
      width: FAB_SIZE,
      height: FAB_SIZE,
    }),
    [tabBarHeight, right]
  );

  // The fixed 22px margins on the skeleton rows and the status wrapper gain
  // the landscape side insets so they clear the sensor housing too; portrait
  // insets are 0, keeping the geometry unchanged.
  const sidePadding = useMemo(
    () => ({ paddingLeft: 22 + left, paddingRight: 22 + right }),
    [left, right]
  );

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
        refreshControl={rowsControl}
        description={
          isSearching
            ? t('agents.sessionList.tryDifferentSearch')
            : t('agents.sessionList.tryAdjustFilters')
        }
        action={
          <Button
            variant="outline"
            onPress={isSearching ? query.handleClearSearch : query.handleClearFilters}
          >
            <Text>{isSearching ? t('common.clearSearch') : t('common.clearFilters')}</Text>
          </Button>
        }
      />
    );
  } else if (content === 'empty') {
    body = (
      <LiveSessionListEmptyState organizationId={organizationId} refreshControl={refreshControl} />
    );
  } else if (hasLiveRows) {
    // The FAB-band inset shrinks the list's frame (`marginBottom`), so the
    // viewport ends above the button's band and no row can scroll into it on
    // either platform.
    body = (
      <FlatList
        ref={listRef}
        data={visibleSessions}
        renderItem={renderItem}
        keyExtractor={item => item.id}
        extraData={attentionFocusRevision}
        style={listInsets.frame}
        contentContainerStyle={listInsets.content}
        refreshControl={rowsControl}
        maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 10 }}
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
      {body}
    </>
  );

  return (
    // The band the no-match body is laid out in ends at the tab bar. The FAB is
    // a corner control with its own frame inset on the rows list, and reserving
    // its band here as well shrank the band to the FAB's top: in a short
    // landscape window that is below the empty state's height, so the state fell
    // to the scroll anchor and its second line and action were parked behind the
    // tab bar (landscape spot defect e8). The no-match body therefore keeps the
    // whole band and the FAB yields to it (`showFab`).
    <StateSurfaceInsets bottomInset={tabBarHeight}>
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
          context={headerActions}
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
