/* eslint-disable max-lines -- DOM-free live-list matrix and focus/navigation regressions share one mounted fixture. */
import { createElement, Fragment, type ReactElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import type * as MotionContextModule from '@/lib/a11y/motion-context';
import type * as PlatformFilterModule from './platform-filter-modal';
import { AgentSessionListScreen } from './session-list-screen';
import { RowsRefreshControl } from './rows-refresh-control';
import { FAB_MARGIN, FAB_SIZE } from './session-list-content';
import { StateSurfaceInsets } from '@/components/centered-state-surface';
import { EmptyState } from '@/components/empty-state';
import { LiveSessionListEmptyState } from './live-session-list-empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { PULL_FEEDBACK_MIN_BEAT_MS } from './use-pull-refresh';
import { getEmptyStateFullHeight } from '@/lib/agents-bottom-chrome';
import { type ActiveSession, type useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';
import { type BannerState } from '@/lib/offline-banner-state';

type Org = { organizationId: string; organizationName: string };
const state = vi.hoisted(() => ({
  focused: true,
  fontScale: 1,
  // Mutable so a case can put the tree on Android: the platform decides
  // whether the floating pull-to-refresh indicator is safe (device defect
  // uxs1) or the reserved band carries the in-flight state instead.
  platform: { OS: 'ios' as string },
  // Mutable so a case can turn reduced motion on: the platform control is then
  // inert and a centered body draws the pull's static progress itself.
  reducedMotion: false,
  topInset: 0,
  leftInset: 0,
  rightInset: 0,
  tabBarHeight: 60,
  focusCallbacks: new Set<() => void>(),
  listeners: new Set<(state: string) => void>(),
  // Keyboard listeners, keyed by the event the platform reports (the screen's
  // empty state reserves the IME's height, so a case must be able to raise it).
  keyboard: new Map<string, Set<(event: { endCoordinates: { height: number } }) => void>>(),
  auth: { token: 'account' as string | undefined, isLoading: false, isSigningOut: false },
  organization: { organizationId: null as string | null, isLoaded: true },
  boundary: { orgs: [] as Org[] | undefined, isResolving: false, isError: false },
  live: {
    activeSessions: [] as ActiveSession[],
    isLoading: false,
    isError: false,
    hasAcceptedSuccess: true,
    isFetching: false,
    isPaused: false,
    terminalError: null as ReturnType<typeof useLiveAgentSessions>['terminalError'],
  },
  internet: 'online' as BannerState,
  connection: { isConnected: true, reconnectExhausted: false },
  refetch: vi.fn<() => Promise<boolean>>(),
  boundaryRefetch: vi.fn(),
  socketRetry: vi.fn(),
  invalidate: vi.fn(),
  announcements: [] as string[],
  destination: '',
  sessionId: '',
  liveQuery: vi.fn<(options: Parameters<typeof useLiveAgentSessions>[0]) => void>(),
}));
const readFilterRecord = vi.hoisted(() => vi.fn<(storageKey: string) => Promise<string | null>>());
vi.mock('expo-secure-store', () => ({
  getItemAsync: readFilterRecord,
}));
vi.mock('@/lib/auth/account-metadata-write', () => ({
  setAccountMetadata: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('sonner-native', () => ({
  toast: { error: vi.fn() },
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/ui/activity-indicator', () => ({
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
vi.mock('@/components/centered-state-surface', () => ({
  StateSurfaceInsets: ({ children }: { children: ReactNode }): ReactNode => children,
}));
// The live list renders through FlashList v2. This stub renders every row
// through the real `renderItem` and forwards the list props the suite reads
// (`data`, `refreshControl`, `extraData`, the insets), standing in for the
// native list without a DOM.
vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: {
    data: ActiveSession[];
    renderItem: (entry: { item: ActiveSession }) => ReactNode;
    keyExtractor: (item: ActiveSession) => string;
  }) =>
    createElement(
      'FlashList',
      props,
      props.data.map(item =>
        createElement(Fragment, { key: props.keyExtractor(item) }, props.renderItem({ item }))
      )
    ),
}));
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: state.platform,
  Modal: 'Modal',
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  useWindowDimensions: () => ({ fontScale: state.fontScale, height: 844 }),
  AppState: {
    addEventListener: (_event: string, listener: (next: string) => void) => {
      state.listeners.add(listener);
      return {
        remove: () => {
          state.listeners.delete(listener);
        },
      };
    },
  },
  Keyboard: {
    addListener: (
      event: string,
      listener: (event: { endCoordinates: { height: number } }) => void
    ) => {
      const listeners = state.keyboard.get(event) ?? new Set();
      listeners.add(listener);
      state.keyboard.set(event, listeners);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    },
  },
  FlatList: (props: {
    data: ActiveSession[];
    renderItem: (entry: { item: ActiveSession }) => ReactNode;
    keyExtractor: (item: ActiveSession) => string;
  }) =>
    createElement(
      'FlatList',
      props,
      props.data.map(item =>
        createElement(Fragment, { key: props.keyExtractor(item) }, props.renderItem({ item }))
      )
    ),
}));
vi.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'AnimatedView' },
  LinearTransition: 'LinearTransition',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({
    top: state.topInset,
    bottom: 0,
    left: state.leftInset,
    right: state.rightInset,
  }),
}));
vi.mock('expo-router', () => ({
  useNavigation: () => ({ isFocused: () => state.focused }),
  useFocusEffect: (effect: () => void) => {
    state.focusCallbacks.add(effect);
  },
  useRouter: () => ({
    canGoBack: () => false,
    push: (path: string) => {
      state.destination = path;
    },
    replace: (path: string) => {
      state.destination = path;
    },
  }),
  useScrollToTop: () => undefined,
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: state.invalidate }),
  useQuery: () => ({
    data: state.boundary.orgs,
    isError: state.boundary.isError,
    isFetching: state.boundary.isResolving,
    isPending: !state.boundary.isError && state.boundary.orgs === undefined,
    refetch: state.boundaryRefetch,
  }),
}));
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: vi.fn() }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({ organizations: { list: { queryOptions: () => ({}) } } }),
}));
vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'ChevronDown',
  Plus: 'Plus',
  Bot: 'Bot',
  AlertCircle: 'AlertCircle',
  Lock: 'Lock',
  SearchX: 'SearchX',
  ServerCrash: 'ServerCrash',
  WifiOff: 'WifiOff',
  Check: 'Check',
  X: 'X',
  SlidersHorizontal: 'SlidersHorizontal',
}));
vi.mock('@/components/agents/remote-session-row', () => ({ RemoteSessionRow: 'RemoteSessionRow' }));
vi.mock('@/components/agents/session-list-content', () => ({
  AgentSessionListContent: 'AgentSessionListContent',
  FAB_MARGIN: 16,
  FAB_SIZE: 48,
}));
vi.mock('@/components/agents/session-list-search-header', () => ({
  SessionListSearchHeader: 'SessionListSearchHeader',
}));
vi.mock('@/components/agents/platform-filter-modal', async importOriginal => ({
  ...(await importOriginal<typeof PlatformFilterModule>()),
  SessionFilterModal: 'SessionFilterModal',
}));
vi.mock('@/components/agents/active-now-section', () => ({ ActiveNowSection: 'ActiveNowSection' }));
vi.mock('@/components/agents/use-agent-session-navigator', () => ({
  useAgentSessionNavigator: () => (id: string) => {
    state.sessionId = id;
  },
}));
vi.mock('@/components/home/section-header', () => ({ SectionHeader: 'SectionHeader' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', async () => {
  const { createContext } = await import('react');
  return { Text: 'Text', TextClassContext: createContext('') };
});
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => state.auth }));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({
    ...state.organization,
    error: null,
    retry: vi.fn(),
    setOrganizationId: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: () => ({
    ...state.boundary,
    org: state.boundary.orgs?.find(org => org.organizationId === state.organization.organizationId),
    refetch: state.boundaryRefetch,
  }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    primaryForeground: '#ffffff',
    foreground: '#000000',
    mutedForeground: '#777777',
  }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => state.internet,
}));
vi.mock('@/lib/hooks/use-user-web-connection-state', () => ({
  useUserWebConnectionHealth: () => state.connection,
}));
vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => ({ retryConnection: state.socketRetry }),
}));
vi.mock('@/lib/a11y/announce', () => ({
  announceForA11y: (message: string) => {
    state.announcements.push(message);
  },
}));
vi.mock('@/lib/a11y/motion-context', async importOriginal => ({
  ...(await importOriginal<typeof MotionContextModule>()),
  useProvidedMotionPolicy: () => ({
    reducedMotion: state.reducedMotion,
    scrollAnimated: !state.reducedMotion,
  }),
}));
vi.mock('@/lib/tab-bar-layout', () => ({ getEffectiveTabBarHeight: () => state.tabBarHeight }));
vi.mock('@/lib/hooks/use-agent-sessions', () => ({
  useLiveAgentSessions: (options: Parameters<typeof useLiveAgentSessions>[0]) => {
    state.liveQuery(options);
    return { ...state.live, refetch: state.refetch };
  },
  useAgentSessions: () => {
    throw new Error('Live list must not mount stored history');
  },
}));
const row: ActiveSession = {
  id: 'live-1',
  status: 'running',
  title: 'Live task',
  connectionId: 'connection-1',
};
const failure = { kind: 'retryable', error: new Error('temporary') } as const;
let mountedRenderer: TestRenderer.ReactTestRenderer | undefined = undefined;
function root() {
  if (!mountedRenderer) {
    throw new Error('Missing live list');
  }
  return mountedRenderer.root;
}
function nodes(type: string) {
  return root().findAll(node => typeof node.type === 'string' && node.type === type);
}
function header() {
  return root().findByType(ScreenHeader);
}
function listSkeletons() {
  return nodes('Skeleton').filter(
    node => typeof node.props.className === 'string' && node.props.className.includes('h-[76px]')
  );
}
function requireNode(type: string) {
  const result = nodes(type)[0];
  if (!result) {
    throw new Error(`Missing node: ${type}`);
  }
  return result;
}
function text() {
  return nodes('Text')
    .map(node => node.children.filter(child => typeof child === 'string').join(''))
    .join('\n');
}
function action(label: string) {
  const button = nodes('Pressable').find(node => node.props.accessibilityLabel === label);
  if (!button) {
    throw new Error(`Missing action: ${label}`);
  }
  return button;
}
function press(label: string) {
  (action(label).props.onPress as () => void)();
}
/** Fire the body wrapper's layout with the height the list can use. */
function layoutBody(height: number) {
  const wrapper = nodes('View').find(node => typeof node.props.onLayout === 'function');
  if (!wrapper) {
    throw new Error('Missing body wrapper');
  }
  const onLayout = wrapper.props.onLayout as (event: {
    nativeEvent: { layout: { height: number } };
  }) => void;
  onLayout({ nativeEvent: { layout: { height } } });
}
function descendantsOf(instance: TestRenderer.ReactTestInstance, type: string) {
  return instance.findAll(node => typeof node.type === 'string' && node.type === type);
}
function fab() {
  return nodes('Pressable').find(node => node.props.testID === 'agents-new-session-fab');
}
type HeaderElement = {
  type: string;
  props: {
    onPress: () => void;
    testID: string;
    accessibilityRole: string;
    activeCount?: number;
    children: { type: string };
  };
};
function headerActions() {
  const inlineActions = header().props.inlineActions as {
    props: { children: (HeaderElement | null)[] };
  };
  return inlineActions.props.children.filter((child): child is HeaderElement => child !== null);
}
function headerAction(testID = 'agents-view-history') {
  const button = headerActions().find(child => child.props.testID === testID);
  const isMounted = nodes('Pressable').some(node => node.props.testID === testID);
  if (!button || !isMounted) {
    throw new Error(`Missing header action: ${testID}`);
  }
  return button;
}
function filterButtonProps() {
  const button = nodes('Pressable').find(node => node.props.testID === 'agents-open-filters');
  if (!button) {
    throw new Error('Missing filter button');
  }
  return button.props as { accessibilityLabel?: string; accessibilityValue?: unknown };
}
function applyFilters(projectFilter: string[], platformFilter: string[]) {
  act(() => {
    headerAction('agents-open-filters').props.onPress();
  });
  const modal = requireNode('SessionFilterModal');
  act(() => {
    (modal.props.onApply as (filters: unknown) => void)({ projectFilter, platformFilter });
    (modal.props.onClose as () => void)();
  });
  expect(nodes('SessionFilterModal')).toHaveLength(0);
}
async function renderScreen() {
  await act(async () => {
    const tree = createElement(AgentSessionListScreen);
    if (mountedRenderer) {
      mountedRenderer.update(tree);
    } else {
      mountedRenderer = TestRenderer.create(tree);
    }
    await Promise.resolve();
  });
  if (!mountedRenderer) {
    throw new Error('Missing live list');
  }
  return mountedRenderer;
}
function foreground() {
  for (const listener of state.listeners) {
    listener('active');
  }
}
function keyboardListeners(event: string) {
  return state.keyboard.get(event) ?? new Set();
}
function showKeyboard(height: number) {
  for (const listener of keyboardListeners('keyboardDidShow')) {
    listener({ endCoordinates: { height } });
  }
}
function hideKeyboard() {
  for (const listener of keyboardListeners('keyboardDidHide')) {
    listener({ endCoordinates: { height: 0 } });
  }
}
function surfaceBottomInset() {
  return root().findByType(StateSurfaceInsets).props.bottomInset as number;
}
/**
 * The padding the keyboard container applies to the region. The container
 * (`AppAwareKeyboardPaddingView` on Android, `KeyboardAvoidingView` on iOS)
 * already clears the IME, so the rows frame adds only the part of the rows band
 * the container does not cover; a case that asserts the rows viewport reads both
 * halves of that composition rather than the frame alone.
 */
function keyboardContainerPadding() {
  let padding = 0;
  for (const node of nodes('View')) {
    const styles = node.props.style as unknown;
    if (Array.isArray(styles)) {
      for (const style of styles as ({ paddingBottom?: number } | undefined)[]) {
        padding = Math.max(padding, style?.paddingBottom ?? 0);
      }
    }
  }
  return padding;
}
/**
 * The band the composed app observes. The real `StateSurfaceInsets` resolves
 * `Math.max(parentReservation, bottomInset)` (`centered-state-surface.tsx:238`)
 * and the enclosing tabs layout reserves the bar's own height while the list is
 * shown (`(tabs)/_layout.tsx:130`), so a band below that floor is not an outcome
 * the screen can produce on its own.
 */
function composedSurfaceBottomInset() {
  return Math.max(state.tabBarHeight, surfaceBottomInset());
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.focused = true;
  state.fontScale = 1;
  state.platform.OS = 'ios';
  state.reducedMotion = false;
  state.topInset = 0;
  state.leftInset = 0;
  state.rightInset = 0;
  state.tabBarHeight = 60;
  state.focusCallbacks.clear();
  state.keyboard.clear();
  state.destination = '';
  state.sessionId = '';
  state.announcements = [];
  Object.assign(state.auth, { token: 'account', isLoading: false, isSigningOut: false });
  Object.assign(state.organization, { organizationId: null, isLoaded: true });
  Object.assign(state.boundary, { orgs: [], isResolving: false, isError: false });
  Object.assign(state.live, {
    activeSessions: [],
    isLoading: false,
    isError: false,
    hasAcceptedSuccess: true,
    isFetching: false,
    isPaused: false,
    terminalError: null,
  });
  Object.assign(state.connection, { isConnected: true, reconnectExhausted: false });
  state.internet = 'online';
  state.refetch.mockReset().mockResolvedValue(true);
  state.boundaryRefetch.mockReset();
  state.socketRetry.mockReset();
  state.invalidate.mockReset();
  state.liveQuery.mockReset();
  readFilterRecord.mockReset().mockResolvedValue(null);
});
afterEach(async () => {
  act(() => mountedRenderer?.unmount());
  mountedRenderer = undefined;
  state.listeners.clear();
  state.keyboard.clear();
  await i18n.changeLanguage('en');
});

describe('AgentSessionListScreen live presentation', () => {
  it.each<{
    name: string;
    patch: Partial<typeof state.live>;
    skeleton?: boolean;
    empty?: boolean;
    rows?: boolean;
    error?: boolean;
    updating?: boolean;
  }>([
    {
      name: 'pending',
      patch: { hasAcceptedSuccess: false, isLoading: true, isFetching: true },
      skeleton: true,
    },
    { name: 'paused', patch: { hasAcceptedSuccess: false, isPaused: true }, skeleton: true },
    { name: 'socket-only empty', patch: { hasAcceptedSuccess: false }, skeleton: true },
    { name: 'canceled without provenance', patch: { hasAcceptedSuccess: false }, skeleton: true },
    { name: 'accepted empty', patch: {}, empty: true },
    {
      name: 'initial failure',
      patch: { hasAcceptedSuccess: false, terminalError: failure, isError: true },
      error: true,
    },
    {
      name: 'retained cache after a socket write',
      patch: { activeSessions: [row], terminalError: failure },
      rows: true,
      error: true,
    },
    {
      name: 'updating',
      patch: { activeSessions: [row], isFetching: true },
      rows: true,
      updating: true,
    },
    {
      name: 'updating after a terminal failure',
      patch: { activeSessions: [row], terminalError: failure, isFetching: true },
      rows: true,
      error: true,
      updating: true,
    },
    {
      name: 'paused cache',
      patch: { activeSessions: [row], isPaused: true, isFetching: true },
      rows: true,
    },
  ])('keeps creation, history, and truthful content during $name', async test => {
    Object.assign(state.live, test.patch);
    await renderScreen();
    expect(listSkeletons()).toHaveLength(test.skeleton ? 8 : 0);
    if (test.skeleton) {
      expect(listSkeletons()[0]?.props.className).toContain('h-[76px]');
    }
    expect(text().includes('Nothing running right now')).toBe(Boolean(test.empty));
    // With cached rows on screen, a retryable failure is a refresh failure and
    // speaks through the reserved status line, not the load-failure block.
    expect(text().includes('Could not load active sessions')).toBe(
      Boolean(test.error) && !test.rows
    );
    expect(text().includes("Couldn't refresh")).toBe(Boolean(test.error) && Boolean(test.rows));
    expect(text().includes('Updating')).toBe(Boolean(test.updating));
    expect(text().includes('Loading…')).toBe(Boolean(test.skeleton));
    expect(nodes('FlashList')).toHaveLength(test.rows ? 1 : 0);
    expect(nodes('ScrollView')).toHaveLength(0);
    expect(nodes('CenteredState')).toHaveLength(test.empty || (test.error && !test.rows) ? 1 : 0);
    // The tab bar is the hard surface reserve; while the FAB shows its band
    // (the mocked 48dp button + its 16dp margin) joins it, because a centered
    // state's full-width action (the load failure's Retry, the boundary's
    // back-to-profile) must not reach into the corner overlay (see
    // `useAgentsListChrome`). The tabs layout reserves the bar alone (its 16dp
    // content gap is content-only), so the raised reserve is the bar plus the
    // FAB band. The no-match body owns the whole band and hides the FAB instead
    // (`showFab`), so its reserve is the bar alone.
    const surface = root().findByType(StateSurfaceInsets);
    const expectedInset = test.empty ? state.tabBarHeight : state.tabBarHeight + 64;
    expect(surface.props.bottomInset).toBe(expectedInset);
    expect(state.liveQuery).toHaveBeenLastCalledWith({ organizationId: null, enabled: true });
    expect(headerAction().props.testID).toBe('agents-view-history');
    expect(headerAction().props.accessibilityRole).toBe('button');
    headerAction().props.onPress();
    expect(state.destination).toBe('/(app)/(tabs)/(2_agents)/history');
    if (test.empty) {
      expect(nodes('Pressable').some(node => node.props.testID === 'agents-new-session-fab')).toBe(
        false
      );
    }
    press('New session');
    expect(state.destination).toBe('/(app)/agent-chat/new');
  });

  it('uses shared scrolling and refresh while preserving the large-text creation action', async () => {
    state.topInset = 44;
    await renderScreen();
    const viewport = requireNode('CenteredState');
    const emptyState = root().findByType(EmptyState);

    expect(header().parent?.children[0]).toBe(header());
    expect(header().props.className).toContain('px-[22px]');
    // The list controls share the title's row through `inlineActions`; the
    // heading keeps `flex-1 min-w-0`, so the title keeps its tail ellipsis and
    // nothing stacks the controls onto a second row.
    expect(header().props.headerRight).toBeUndefined();
    expect(header().props.context).toBeUndefined();
    expect(header().props.inlineActions).toBeDefined();
    expect(emptyState.props.placement).toBeUndefined();
    expect(nodes('ScrollView')).toHaveLength(0);
    expect(root().findByType(StateSurfaceInsets).props.bottomInset).toBe(60);
    const refreshControl = viewport.props.refreshControl as { props: { onRefresh: () => void } };
    await act(async () => {
      refreshControl.props.onRefresh();
      await Promise.resolve();
    });
    expect(state.refetch).toHaveBeenCalledTimes(1);

    state.fontScale = 2;
    state.tabBarHeight = 84;
    await renderScreen();
    expect(root().findByType(StateSurfaceInsets).props.bottomInset).toBe(84);
    const createAction = action('New session');
    const label = createAction.findByType(Text);
    expect(createAction.props.className).toContain('max-w-full');
    expect(createAction.props.className).toContain('min-h-[44px]');
    expect(label.props.className).toBe('shrink text-center');
    expect(label.props.numberOfLines).toBeUndefined();
    expect(label.props.allowFontScaling).not.toBe(false);
    expect(label.props.adjustsFontSizeToFit).not.toBe(true);
  });

  it('renders the empty-state New session action as the tab’s primary affordance', async () => {
    await renderScreen();
    const createAction = action('New session');
    // One primary action per surface: the Agents empty state's only action is
    // the same new-session flow Home surfaces as a filled brand-yellow button,
    // so it must carry the primary variant rather than a low-emphasis outline.
    expect(createAction.props.className).toContain('bg-primary');
    expect(createAction.props.className).not.toContain('bg-card');
    const icon = createAction.findByType('Plus');
    expect(icon.props.color).toBe('#ffffff');
  });

  it('keeps cold-loading feedback stable until an accepted result', async () => {
    state.live.hasAcceptedSuccess = false;
    state.live.isLoading = true;
    state.live.isFetching = true;
    await renderScreen();
    const loading = nodes('Text').find(node => node.children.includes('Loading…'));
    const skeletons = nodes('Skeleton');
    expect(loading).toBeDefined();
    expect(skeletons).toHaveLength(8);
    expect(text()).not.toContain('Updating');
    expect(text()).not.toContain('Nothing running right now');
    expect(state.announcements).toEqual(['Loading…']);

    await renderScreen();
    state.live.isLoading = false;
    state.live.isFetching = false;
    await renderScreen();
    expect(nodes('Text').find(node => node.children.includes('Loading…'))).toBe(loading);
    for (const [index, skeleton] of skeletons.entries()) {
      expect(nodes('Skeleton')[index]).toBe(skeleton);
    }
    expect(state.announcements).toEqual(['Loading…']);
    expect(text()).not.toContain('Nothing running right now');

    state.live.hasAcceptedSuccess = true;
    await renderScreen();
    expect(text()).not.toContain('Loading…');
    expect(nodes('Skeleton')).toHaveLength(0);
    expect(text()).toContain('Nothing running right now');
    expect(state.announcements).toEqual(['Loading…']);
  });

  it('keeps list identity, row identity, navigation, run state, and scroll policy through reconnect and refresh failure', async () => {
    state.live.activeSessions = [row];
    await renderScreen();
    const list = nodes('FlashList')[0];
    const originalRow = nodes('RemoteSessionRow')[0];
    if (!originalRow) {
      throw new Error('Missing live row');
    }
    state.live.isFetching = true;
    state.connection.isConnected = false;
    await renderScreen();
    expect(text()).toContain('Reconnecting…');
    expect(text()).toContain('Updating');
    state.live.isFetching = false;
    state.live.terminalError = failure;
    state.internet = 'offline';
    await renderScreen();
    expect(nodes('FlashList')[0]).toBe(list);
    expect(nodes('RemoteSessionRow')[0]).toBe(originalRow);
    expect(nodes('FlashList')[0]?.props.maintainVisibleContentPosition).toEqual({
      autoscrollToTopThreshold: 10,
    });
    expect(nodes('RemoteSessionRow')[0]?.props.session).toMatchObject({ status: 'running' });
    expect(text()).toContain('No internet connection');
    expect(text()).not.toContain('Reconnecting…');
    (originalRow.props.onPress as () => void)();
    expect(state.sessionId).toBe('live-1');
  });

  it.each([
    ['offline', 'No internet connection'],
    ['unknown', 'Connecting…'],
    ['connecting', 'Connecting…'],
    ['exhausted', 'Connection lost'],
  ] as const)(
    'keeps %s connection facts beside empty and error content',
    async (mode, expected) => {
      state.connection.isConnected = false;
      state.connection.reconnectExhausted = mode === 'exhausted';
      state.internet = mode === 'offline' || mode === 'unknown' ? mode : 'online';
      await renderScreen();
      expect(text()).toContain(expected);
      expect(text()).toContain('Nothing running right now');
      state.live.terminalError = failure;
      await renderScreen();
      if (mode === 'exhausted') {
        // The whole-surface load-failure block draws its own Retry for the
        // outage that also exhausted the connection, so the connection row
        // yields instead of stacking a second "Connection lost / Retry" above
        // it (device defect uxs1). One retry, one recovery.
        expect(text()).not.toContain('Connection lost');
        expect(action('Retry')).toBeDefined();
        expect(
          nodes('Pressable').some(node => node.props.accessibilityLabel === 'Retry connection')
        ).toBe(false);
      } else {
        expect(text()).toContain(expected);
      }
      expect(text()).toContain('Could not load active sessions');
      expect(text()).not.toContain('Nothing running right now');
      expect(text()).not.toContain('Internet connection restored');
      if (mode === 'offline') {
        expect(text()).not.toContain('Connecting…');
      }
      if (mode === 'exhausted') {
        expect(text()).not.toContain('Connecting…');
        expect(text()).not.toContain('Reconnecting…');
      }
    }
  );

  it.each([false, true])(
    'keeps a failed query Retry recoverable with cached rows=%s',
    async cached => {
      state.live.activeSessions = cached ? [row] : [];
      state.live.terminalError = failure;
      state.connection.isConnected = false;
      state.connection.reconnectExhausted = true;
      const pending = Promise.withResolvers<boolean>();
      state.refetch.mockReturnValue(pending.promise);
      await renderScreen();
      if (cached) {
        // With cached rows the reserved status line owns the retry: no
        // disabled button, and the second tap must not start a second fetch.
        expect(text()).toContain("Couldn't refresh");
        act(() => {
          press('Retry');
          press('Retry');
        });
        expect(state.refetch).toHaveBeenCalledTimes(1);
        expect(state.announcements).toContain('Updating');
      } else {
        act(() => {
          press('Retry');
          press('Retry');
        });
        expect(action('Retry').props.disabled).toBe(true);
        expect(action('Retry').props.accessibilityState).toMatchObject({
          busy: true,
          disabled: true,
        });
        expect(state.refetch).toHaveBeenCalledTimes(1);
      }
      if (cached) {
        expect(action('Retry connection').props.disabled).toBe(false);
      } else {
        // Without cached rows the whole-surface load-failure block owns
        // recovery, so the connection row yields rather than stacking a second
        // Retry above the card (device defect uxs1). It returns once the load
        // lands again (asserted at the end of this case).
        expect(
          nodes('Pressable').some(node => node.props.accessibilityLabel === 'Retry connection')
        ).toBe(false);
      }
      const queryRetry = cached ? undefined : action('Retry');
      const socketRetry = cached ? action('Retry connection') : undefined;
      expect(
        nodes('View').filter(
          view =>
            view.props.accessible === true &&
            view.findAll(node => node === queryRetry || node === socketRetry).length > 0
        )
      ).toHaveLength(0);
      await act(async () => {
        pending.resolve(false);
        await pending.promise;
      });
      if (cached) {
        // A rejected pull holds the in-flight feedback through the anti-flicker
        // beat before the failure line takes over.
        await act(async () => {
          await new Promise(resolve => {
            setTimeout(resolve, PULL_FEEDBACK_MIN_BEAT_MS + 100);
          });
        });
      } else {
        expect(action('Retry').props.disabled).toBe(false);
      }
      expect(text()).toContain(cached ? "Couldn't refresh" : 'Could not load active sessions');
      state.refetch.mockImplementation(async () => {
        await Promise.resolve();
        state.live.terminalError = null;
        return true;
      });
      await act(async () => {
        press('Retry');
        await Promise.resolve();
      });
      await renderScreen();
      expect(text()).not.toContain('Could not load active sessions');
      expect(text()).not.toContain("Couldn't refresh");
      expect(nodes('FlashList')).toHaveLength(cached ? 1 : 0);
      state.socketRetry.mockImplementation(() => {
        state.connection.reconnectExhausted = false;
      });
      act(() => {
        press('Retry connection');
      });
      await renderScreen();
      expect(text()).toContain('Connecting…');
      expect(text()).not.toContain('Connection lost');
      expect(state.refetch).toHaveBeenCalledTimes(2);
    }
  );

  it('preserves error recovery when switching between centered feedback and socket rows', async () => {
    state.live.hasAcceptedSuccess = false;
    state.live.terminalError = failure;
    await renderScreen();
    const loadFailure = 'Could not load active sessions';
    const refreshFailure = "Couldn't refresh";
    expect(text()).toContain(loadFailure);
    expect(nodes('CenteredState')).toHaveLength(1);

    async function updateSocketRows(activeSessions: ActiveSession[]) {
      state.live.activeSessions = activeSessions;
      await renderScreen();
      expect(nodes('RemoteSessionRow')).toHaveLength(activeSessions.length);
      expect(nodes('CenteredState')).toHaveLength(activeSessions.length === 0 ? 1 : 0);
      const message = activeSessions.length === 0 ? loadFailure : refreshFailure;
      expect(text()).toContain(message);
      expect(state.announcements).toContain(message);
      await act(async () => {
        press('Retry');
        await Promise.resolve();
      });
    }
    await updateSocketRows([row]);
    await updateSocketRows([]);
    expect(state.refetch).toHaveBeenCalledTimes(2);
  });

  it('does not invent internet or retry activity for an unknown paused connection', async () => {
    state.internet = 'unknown';
    state.connection.isConnected = false;
    state.live.isPaused = true;
    state.live.hasAcceptedSuccess = false;
    await renderScreen();
    expect(listSkeletons()).toHaveLength(8);
    expect(text()).not.toContain('Nothing running right now');
    expect(text()).not.toContain('Connecting…');
    expect(text()).not.toContain('Reconnecting…');
    expect(text()).not.toContain('No internet connection');
    expect(text()).not.toContain('Updating');
  });

  it('retains one error announcement after a failed pull and waits for coordinated completion', async () => {
    state.live.activeSessions = [row];
    const pending = Promise.withResolvers<boolean>();
    state.refetch.mockReturnValue(pending.promise);
    await renderScreen();
    const refresh = () =>
      nodes('FlashList')[0]?.props.refreshControl as {
        props: { refreshing: boolean; onRefresh: () => void };
      };
    act(() => {
      refresh().props.onRefresh();
    });
    expect(refresh().props.refreshing).toBe(true);
    state.live.terminalError = failure;
    await act(async () => {
      pending.resolve(false);
      await pending.promise;
    });
    // The rejected pull holds the in-flight feedback through the beat before
    // the failure line takes over (device defect e1-updating).
    await act(async () => {
      await new Promise(resolve => {
        setTimeout(resolve, PULL_FEEDBACK_MIN_BEAT_MS + 100);
      });
    });
    expect(refresh().props.refreshing).toBe(false);
    // The pull-failed state speaks through the reserved status line: the
    // scenario copy with its Retry action, announced exactly once.
    expect(text()).toContain("Couldn't refresh");
    expect(state.announcements.filter(message => message === "Couldn't refresh")).toHaveLength(1);
  }, 15_000);

  it('retires the pull-failure line when a later foreground refresh lands an accepted result', async () => {
    state.live.activeSessions = [row];
    const rejected = Promise.withResolvers<boolean>();
    state.refetch.mockReturnValueOnce(rejected.promise);
    await renderScreen();
    const refresh = () =>
      nodes('FlashList')[0]?.props.refreshControl as {
        props: { refreshing: boolean; onRefresh: () => void };
      };
    act(() => {
      refresh().props.onRefresh();
    });
    await act(async () => {
      rejected.resolve(false);
      await rejected.promise;
    });
    await act(async () => {
      await new Promise(resolve => {
        setTimeout(resolve, PULL_FEEDBACK_MIN_BEAT_MS + 100);
      });
    });
    expect(text()).toContain("Couldn't refresh");

    // A refresh outside the pull lifecycle (app foreground) lands an accepted
    // result afterwards: the list is up to date, so the stale failure line
    // must retire instead of claiming "Couldn't refresh" indefinitely.
    await act(async () => {
      foreground();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(text()).not.toContain("Couldn't refresh");
    expect(refresh().props.refreshing).toBe(false);
    expect(state.refetch).toHaveBeenCalledTimes(2);
  }, 15_000);

  it('announces only the in-flight Updating on a successful pull with cached rows', async () => {
    state.live.activeSessions = [row];
    await renderScreen();
    const refresh = nodes('FlashList')[0]?.props.refreshControl as {
      props: { onRefresh: () => void };
    };
    await act(async () => {
      refresh.props.onRefresh();
      await Promise.resolve();
    });
    expect(state.refetch).toHaveBeenCalledTimes(1);
    expect(state.announcements).toEqual(['Updating']);
  });

  it('carries the in-flight pull in the reserved band on Android instead of the floating indicator', async () => {
    state.live.activeSessions = [row];
    const pending = Promise.withResolvers<boolean>();
    state.refetch.mockReturnValue(pending.promise);
    // Android's SwipeRefreshLayout rests its indicator over the list's first
    // row and hides that row's text (device defect uxs1), so the rows list
    // mounts `RowsRefreshControl`, which parks that disc below the fold (see
    // its test); the reserved band above the rows shows the wait with the
    // spinner that cannot cover a row.
    state.platform.OS = 'android';
    await renderScreen();
    const refresh = () =>
      nodes('FlashList')[0]?.props.refreshControl as ReactElement<{
        refreshing: boolean;
        onRefresh: () => void;
      }>;
    act(() => {
      refresh().props.onRefresh();
    });
    expect(refresh().type).toBe(RowsRefreshControl);
    expect(refresh().props.refreshing).toBe(true);
    const updating = nodes('Text').find(node => node.children.includes('Updating'));
    expect(updating).toBeDefined();
    expect(updating?.props.className).not.toContain('absolute');
    expect(nodes('ActivityIndicator')).toHaveLength(1);
    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
    expect(nodes('ActivityIndicator')).toHaveLength(0);
  });

  it.each([
    { platform: 'android' as const, parked: true },
    { platform: 'ios' as const, parked: false },
  ])(
    'carries the no-match body pull in one indicator on $platform',
    async ({ platform: os, parked }) => {
      state.live.activeSessions = [row];
      const pending = Promise.withResolvers<boolean>();
      state.refetch.mockReturnValue(pending.promise);
      state.platform.OS = os;
      await renderScreen();
      const searchHeader = requireNode('SessionListSearchHeader');
      act(() => {
        (searchHeader.props.onChangeText as (text: string) => void)('nothing matches this');
      });
      expect(nodes('CenteredState')).toHaveLength(1);
      const refresh = () =>
        nodes('CenteredState')[0]?.props.refreshControl as ReactElement<{
          refreshing: boolean;
          onRefresh: () => void;
        }>;
      act(() => {
        refresh().props.onRefresh();
      });
      // The no-match body mounts the rows control, and the reserved band is
      // present here too (the sessions still exist behind the filter). Where
      // the band carries the in-flight spinner (Android), the disc is parked
      // off the rows there as on the rows list, or one pull draws two spinners
      // (device defect uxs1).
      expect(refresh().type).toBe(RowsRefreshControl);
      expect(nodes('ActivityIndicator')).toHaveLength(parked ? 1 : 0);
      await act(async () => {
        pending.resolve(true);
        await pending.promise;
      });
      expect(nodes('ActivityIndicator')).toHaveLength(0);
      expect(refresh().props.refreshing).toBe(false);
    }
  );

  it('yields the no-match band spinner to the body’s reduced-motion progress on Android', async () => {
    state.live.activeSessions = [row];
    const pending = Promise.withResolvers<boolean>();
    state.refetch.mockReturnValue(pending.promise);
    state.platform.OS = 'android';
    state.reducedMotion = true;
    await renderScreen();
    const searchHeader = requireNode('SessionListSearchHeader');
    act(() => {
      (searchHeader.props.onChangeText as (text: string) => void)('nothing matches this');
    });
    const refresh = () =>
      nodes('CenteredState')[0]?.props.refreshControl as ReactElement<{
        refreshing: boolean;
        onRefresh: () => void;
      }>;
    act(() => {
      refresh().props.onRefresh();
    });
    // Reduced motion makes the platform control inert, so the no-match body's
    // static progress is the pull's indicator: the reserved band keeps the
    // "Updating" copy without drawing a second spinner (device defect uxs1).
    const updating = nodes('Text').find(node => node.children.includes('Updating'));
    expect(updating).toBeDefined();
    expect(updating?.props.className).not.toContain('absolute');
    expect(nodes('ActivityIndicator')).toHaveLength(0);
    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
    expect(nodes('ActivityIndicator')).toHaveLength(0);
    expect(refresh().props.refreshing).toBe(false);
  });

  it('passes a numeric attention revision as extraData to the live FlashList', async () => {
    state.live.activeSessions = [row];
    await renderScreen();
    expect(typeof nodes('FlashList')[0]?.props.extraData).toBe('number');
  });

  it('offsets the FAB by the landscape right inset and keeps its vertical position', async () => {
    state.live.activeSessions = [row];
    await renderScreen();
    expect(fab()?.props.style).toEqual({
      bottom: state.tabBarHeight + 16,
      right: 20,
      width: 48,
      height: 48,
    });

    // Rotation must not move or resize the FAB vertically; only the side offset
    // grows by the right inset.
    state.rightInset = 59;
    await renderScreen();
    expect(fab()?.props.style).toEqual({
      bottom: state.tabBarHeight + 16,
      right: 79,
      width: 48,
      height: 48,
    });
  });

  it('pads the live list content by the landscape side insets', async () => {
    state.live.activeSessions = [row];
    await renderScreen();
    const contentContainerStyle = () =>
      nodes('FlashList')[0]?.props.contentContainerStyle as Record<string, number>;
    expect(contentContainerStyle()).toEqual({
      paddingTop: 0,
      paddingBottom: 64,
      paddingLeft: 0,
      paddingRight: 0,
    });

    // Rotation pads only the sides; the vertical geometry is unchanged.
    state.leftInset = 47;
    state.rightInset = 59;
    await renderScreen();
    expect(contentContainerStyle()).toEqual({
      paddingTop: 0,
      paddingBottom: 64,
      paddingLeft: 47,
      paddingRight: 59,
    });
  });

  it('keeps the list frame at the tab bar and clears the FAB in the content', async () => {
    state.live.activeSessions = [row];
    await renderScreen();
    // The frame keeps only the tab-bar inset, so the list background runs clean
    // to the tab bar edge with no bare band. The FAB clearance is content
    // padding instead: the button floats over the list and the last row still
    // scrolls clear of it.
    const listStyle = () => nodes('FlashList')[0]?.props.style as Record<string, number>;
    const contentStyle = () =>
      nodes('FlashList')[0]?.props.contentContainerStyle as Record<string, number>;
    expect(listStyle()).toEqual({ marginBottom: state.tabBarHeight });
    expect(contentStyle().paddingBottom).toBe(64);
  });

  it('keeps the frame at the tab bar and the FAB clearance in the content in a short window', async () => {
    state.live.activeSessions = [row];
    await renderScreen();
    const listStyle = () => nodes('FlashList')[0]?.props.style as Record<string, number>;
    const contentContainerStyle = () =>
      nodes('FlashList')[0]?.props.contentContainerStyle as Record<string, number>;

    // The frame never yields the tab bar and the FAB band never rides on it, so
    // the split is the same after the body measures in a short landscape window
    // as in a tall one: the viewport ends at the tab bar (no bare band) and the
    // FAB clearance stays on the content, where the last row can still scroll
    // clear of the button. This replaces origin/main's frame-clamp assertion,
    // whose yield-the-band frame is exactly the band papercut 3 removes.
    act(() => {
      layoutBody(180);
    });
    expect(listStyle()).toEqual({ marginBottom: state.tabBarHeight });
    expect(contentContainerStyle().paddingBottom).toBe(64);

    act(() => {
      layoutBody(900);
    });
    expect(listStyle()).toEqual({ marginBottom: state.tabBarHeight });
    expect(contentContainerStyle().paddingBottom).toBe(64);
  });

  it('renders no history list, animated wrappers, or active-now section and keeps one history label without a plus icon', async () => {
    state.live.activeSessions = [row];
    await renderScreen();
    for (const type of [
      'SessionFilterModal',
      'ActiveNowSection',
      'AgentSessionListContent',
      'AnimatedView',
    ]) {
      expect(nodes(type)).toHaveLength(0);
    }
    expect(headerAction().type).toBe('Pressable');
    expect(headerAction().props.children.type).toBe('Text');
  });
});

describe('AgentSessionListScreen header and admission', () => {
  it.each([
    { fontScale: 1, filterable: false },
    { fontScale: 1, filterable: true },
    { fontScale: 2, filterable: false },
    { fontScale: 2, filterable: true },
  ])('bounds Hungarian history text at scale $fontScale with filters=$filterable', async test => {
    await i18n.changeLanguage('hu');
    state.fontScale = test.fontScale;
    const organizationName = 'An organization with a long name that must remain truncated';
    state.organization.organizationId = 'org-1';
    state.boundary.orgs = [{ organizationId: 'org-1', organizationName }];
    state.live.activeSessions = [
      { ...row, gitUrl: test.filterable ? 'https://github.com/kilo/cloud.git' : undefined },
    ];
    await renderScreen();
    const history = action('Összes megtekintése');
    const label = history.findByType(Text);
    const actionsRow = history.parent;
    const actionsWrapper = actionsRow?.parent;
    const title = header().findByProps({ accessibilityRole: 'header' });
    // The controls share the title's row (the header's `inlineActions` slot) as
    // a sibling of the heading, so the heading keeps `min-w-0 flex-1` and its
    // tail ellipsis while this label keeps the room it needs. Through the old
    // `headerRight` half-row cap the two columns squeezed each other on a
    // 480x1040 capture until "Agents" broke mid-word ("Age / nts") and this
    // label stacked ("SEE / ALL").
    expect(header().props.headerRight).toBeUndefined();
    expect(header().props.context).toBeUndefined();
    expect(actionsWrapper?.parent).toBe(title.parent?.parent?.parent);
    expect(actionsWrapper?.props.className).toContain('min-w-0');
    expect(actionsWrapper?.props.className).toContain('shrink');
    expect(actionsWrapper?.props.className).not.toContain('max-w-[50%]');
    expect(title.parent?.props.className).toContain('min-w-0 flex-1');
    expect(actionsWrapper?.parent?.props.className).toContain('flex-row');
    expect(actionsRow?.props.className).toContain('justify-end');
    expect(actionsRow?.props.className).toContain('min-h-11');
    expect(actionsRow?.props.className).toContain('min-w-0');
    expect(actionsRow?.props.className).toContain('shrink');
    expect(actionsRow?.props.className).not.toContain('max-w-[50%]');
    expect(history.props.className).toContain('min-w-0');
    expect(history.props.className).toContain('shrink');
    expect(actionsRow?.props.className).toContain('items-center');
    expect(label.props.className).toContain('text-center');
    expect(label.props.numberOfLines).toBe(1);
    expect(label.props.allowFontScaling).not.toBe(false);
    expect(label.props.adjustsFontSizeToFit).not.toBe(true);
    expect(header().props.reserveEyebrow).toBe(true);
    expect(header().props.eyebrow).toBe(i18n.t('agents.liveCount', { count: 1 }));
    expect(text()).not.toContain(organizationName);
    expect(
      nodes('Pressable').filter(node => node.props.accessibilityHint === 'Select account')
    ).toHaveLength(0);
    expect(state.liveQuery).toHaveBeenLastCalledWith({ organizationId: 'org-1', enabled: true });
    expect(
      nodes('Pressable').filter(node => node.props.testID === 'agents-open-filters')
    ).toHaveLength(test.filterable ? 1 : 0);
    press('Összes megtekintése');
    expect(state.destination).toBe('/(app)/(tabs)/(2_agents)/history');
  });

  it('withholds cached rows and the live count until membership resolves', async () => {
    state.organization.organizationId = 'org-1';
    state.boundary.orgs = [{ organizationId: 'org-1', organizationName: 'Engineering' }];
    state.boundary.isResolving = true;
    state.live.activeSessions = [row];
    await renderScreen();
    expect(state.liveQuery).toHaveBeenLastCalledWith({ organizationId: 'org-1', enabled: false });
    expect(nodes('FlashList')).toHaveLength(0);
    expect(header().props.eyebrow).toBeUndefined();
    state.boundary.isResolving = false;
    await renderScreen();
    expect(state.liveQuery).toHaveBeenLastCalledWith({ organizationId: 'org-1', enabled: true });
    expect(nodes('RemoteSessionRow')[0]?.props.session).toBe(row);
    expect(header().props.eyebrow).toBe('1 LIVE');
  });

  it('renders the list controls in the title row with no account control above search', async () => {
    state.live.activeSessions = [{ ...row, gitUrl: 'https://github.com/kilo/cloud.git' }];
    await renderScreen();
    // The controls share the title's row through `inlineActions`, trailing the
    // heading. Sharing that row through the old `headerRight` half-row cap
    // squeezed both columns on a narrow viewport until the title broke mid-word
    // and SEE ALL stacked (device capture at 480x1040).
    const actions = header().props.inlineActions as { props: { className: string } };
    expect(actions.props.className).toContain('justify-end');
    expect(actions.props.className).toContain('min-h-11');
    expect(actions.props.className).toContain('shrink');
    expect(header().props.headerRight).toBeUndefined();
    expect(header().props.context).toBeUndefined();
    expect(
      nodes('Pressable').filter(node => node.props.accessibilityHint === 'Select account')
    ).toHaveLength(0);
    expect(text()).not.toContain('Personal');
    expect(nodes('SessionListSearchHeader')).toHaveLength(1);
    const history = nodes('Pressable').find(node => node.props.testID === 'agents-view-history');
    const filters = nodes('Pressable').find(node => node.props.testID === 'agents-open-filters');
    const title = header().findByProps({ accessibilityRole: 'header' });
    const actionsRow = history?.parent;
    const actionsWrapper = actionsRow?.parent;
    // The controls row is a sibling of the heading in the row that holds the
    // title, so the heading keeps `min-w-0 flex-1` and the title is not squeezed.
    expect(actionsWrapper?.parent).toBe(title.parent?.parent?.parent);
    expect(actionsWrapper?.props.className).toContain('min-w-0');
    expect(actionsWrapper?.props.className).toContain('shrink');
    expect(actionsWrapper?.props.className).not.toContain('max-w-[50%]');
    expect(actionsRow?.props.className).toContain('items-center');
    expect(actionsRow?.props.className).toContain('min-h-11');
    expect(filters?.parent?.parent).toBe(actionsRow);
    const updating = nodes('Text').find(node => node.children.includes('Updating'));
    expect(updating).toBeUndefined();
    state.live.isFetching = true;
    await renderScreen();
    expect(
      nodes('Text').find(node => node.children.includes('Updating'))?.props.className
    ).toContain('absolute');
  });

  it('keeps the list unresolved until the organization restores', async () => {
    state.organization.isLoaded = false;
    state.boundary.orgs = [{ organizationId: 'org-1', organizationName: 'Agents organization' }];
    state.live.activeSessions = [row];
    await renderScreen();
    expect(state.liveQuery).toHaveBeenLastCalledWith({ organizationId: null, enabled: false });
    expect(listSkeletons()).toHaveLength(8);
    expect(nodes('FlashList')).toHaveLength(0);
    expect(header().props.eyebrow).toBeUndefined();
    expect(headerAction().props.accessibilityRole).toBe('button');
    state.organization.organizationId = 'org-1';
    state.organization.isLoaded = true;
    await renderScreen();
    expect(state.liveQuery).toHaveBeenLastCalledWith({ organizationId: 'org-1', enabled: true });
    expect(listSkeletons()).toHaveLength(0);
    expect(nodes('RemoteSessionRow')[0]?.props.session).toBe(row);
    expect(header().props.eyebrow).toBe('1 LIVE');
    expect(headerAction().props.accessibilityRole).toBe('button');
  });
});

describe('AgentSessionListScreen live counts', () => {
  it.each([
    { count: 0, label: '0 LIVE' },
    { count: 1, label: '1 LIVE' },
    { count: 3, label: '3 LIVE' },
    { count: 4, label: '4 LIVE' },
    { count: 12, label: '12 LIVE' },
  ])('shows $label above Agents for the full live list', async ({ count, label }) => {
    state.live.activeSessions = Array.from({ length: count }, (_, index) => ({
      ...row,
      id: `session-${index}`,
    }));
    await renderScreen();

    expect(header().props.eyebrow).toBe(label);
    expect(header().props.title).toBe('Agents');
  });

  it.each([
    { name: 'loading', isLoading: true, orgLoaded: true },
    { name: 'unknown organization', isLoading: false, orgLoaded: false },
  ])('hides a cached count during $name', async ({ isLoading, orgLoaded }) => {
    state.live.activeSessions = [row];
    state.live.isLoading = isLoading;
    state.organization.isLoaded = orgLoaded;
    await renderScreen();

    expect(header().props.eyebrow).toBeUndefined();
    expect(header().props.reserveEyebrow).toBe(true);
    const reserved = nodes('Text').find(node => node.props.variant === 'eyebrow');
    expect(reserved?.props.className).toContain('opacity-0');
    expect(reserved?.props.accessibilityElementsHidden).toBe(true);
    expect(nodes('FlashList')).toHaveLength(orgLoaded ? 1 : 0);
  });

  it('keeps the retained count and rows through a retryable refresh failure', async () => {
    state.live.activeSessions = [row];
    state.live.terminalError = failure;
    await renderScreen();

    // The last snapshot stays legible: the count is not blanked, and the
    // failure cannot grow an in-flow block that pushes the kept rows down.
    expect(header().props.eyebrow).toBe('1 LIVE');
    expect(nodes('FlashList')).toHaveLength(1);
    expect(nodes('RemoteSessionRow')).toHaveLength(1);
    expect(nodes('CenteredState')).toHaveLength(0);
    expect(text()).toContain("Couldn't refresh");
    expect(text()).not.toContain('Could not load active sessions');
    expect(nodes('View').filter(node => node.props.className === 'min-h-5')).toHaveLength(1);
  });
});

describe('AgentSessionListScreen live filtering', () => {
  it('shows the search header only once there are live rows', async () => {
    await renderScreen();
    expect(nodes('SessionListSearchHeader')).toHaveLength(0);

    state.live.activeSessions = [row];
    await renderScreen();
    expect(nodes('SessionListSearchHeader')).toHaveLength(1);
  });

  it('holds the skeletons until the persisted filter record resolves', async () => {
    readFilterRecord.mockReturnValue(new Promise<string | null>(() => undefined));
    state.live.activeSessions = [row];

    await renderScreen();

    expect(listSkeletons()).toHaveLength(8);
    expect(nodes('FlashList')).toHaveLength(0);
  });

  it('applies a persisted filter without first painting the unfiltered list', async () => {
    readFilterRecord.mockResolvedValue(
      JSON.stringify({ platformFilter: [], projectFilter: ['https://github.com/kilo/cloud.git'] })
    );
    state.live.activeSessions = [
      { ...row, id: 'a1', organizationId: null, gitUrl: 'https://github.com/kilo/cloud.git' },
      { ...row, id: 'a2', organizationId: null, gitUrl: 'https://github.com/kilo/other.git' },
    ];

    await renderScreen();

    const list = requireNode('FlashList');
    expect((list.props.data as ActiveSession[]).map(session => session.id)).toEqual(['a1']);
    expect(headerAction('agents-open-filters').props.activeCount).toBe(1);
  });

  it('clears only the search when the no-match CTA says Clear search', async () => {
    readFilterRecord.mockResolvedValue(
      JSON.stringify({ platformFilter: [], projectFilter: ['https://github.com/kilo/cloud.git'] })
    );
    state.live.activeSessions = [
      {
        ...row,
        id: 'a1',
        organizationId: null,
        title: 'Ship it',
        gitUrl: 'https://github.com/kilo/cloud.git',
      },
    ];
    const renderer = await renderScreen();

    const searchHeader = requireNode('SessionListSearchHeader');
    act(() => {
      (searchHeader.props.onChangeText as (text: string) => void)('nothing matches this');
    });

    const emptyState = renderer.root.findByType(EmptyState);
    expect(emptyState.props.description).toBe('Try a different search term.');
    expect(nodes('CenteredState')).toHaveLength(1);
    expect(nodes('FlashList')).toHaveLength(0);
    // The no-match body owns the band the tab bar leaves (the FAB's band is no
    // longer reserved in it, see `StateSurfaceInsets` above), so the creation
    // FAB yields instead of floating over the state's description and Clear
    // action.
    expect(fab()).toBeUndefined();
    expect(requireNode('SessionListSearchHeader')).toBe(searchHeader);
    act(() => {
      (emptyState.props.action as { props: { onPress: () => void } }).props.onPress();
    });

    expect(nodes('FlashList')).toHaveLength(1);
    expect(nodes('CenteredState')).toHaveLength(0);
    expect(fab()).toBeDefined();
    expect(requireNode('SessionListSearchHeader')).toBe(searchHeader);
    expect(headerAction('agents-open-filters').props.activeCount).toBe(1);
  });

  it('lifts the no-match body above the keyboard inside the platform container', async () => {
    state.live.activeSessions = [row];
    await renderScreen();
    const searchHeader = requireNode('SessionListSearchHeader');
    act(() => {
      (searchHeader.props.onChangeText as (text: string) => void)('nothing matches this');
    });

    // iOS: the native container owns the lift, so the centered no-match body is
    // inside it and re-measures against the viewport it shrinks.
    const container = requireNode('KeyboardAvoidingView');
    expect(container.props.behavior).toBe('padding');
    expect(descendantsOf(container, 'CenteredState')).toHaveLength(1);
    expect(nodes('KeyboardAvoidingView')).toHaveLength(1);

    // Android: edge-to-edge never resizes the window for the IME, so the
    // app-aware container follows the keyboard events and pads its frame; the
    // body re-centers inside the shrunken viewport.
    state.platform.OS = 'android';
    await renderScreen();
    act(() => {
      showKeyboard(320);
    });
    const padded = nodes('View').find(
      node =>
        Array.isArray(node.props.style) &&
        node.props.style.some(
          (part: { paddingBottom?: number } | undefined) => part?.paddingBottom === 320
        )
    );
    expect(padded).toBeDefined();
    if (!padded) {
      throw new Error('Missing app-aware padding container');
    }
    expect(descendantsOf(padded, 'CenteredState')).toHaveLength(1);
    expect(nodes('KeyboardAvoidingView')).toHaveLength(0);
  });

  it('reserves the keyboard height for the no-match body so its second line stays readable', async () => {
    // agents-list: the empty state's second line and its Clear search action
    // drew behind the raised IME, because Android's edge-to-edge window does
    // not resize for the keyboard.
    state.platform.OS = 'android';
    state.live.activeSessions = [{ ...row, id: 'a1', organizationId: null, title: 'Ship it' }];
    const renderer = await renderScreen();

    const searchHeader = requireNode('SessionListSearchHeader');
    act(() => {
      (searchHeader.props.onChangeText as (text: string) => void)('nothing matches this');
    });
    expect(renderer.root.findByType(EmptyState).props.description).toBe(
      'Try a different search term.'
    );
    // Keyboard down: the band ends at the tab bar. The FAB's band is not
    // reserved here — the no-match body owns the band and the FAB yields to it —
    // so the state does not pay for the button's clearance.
    expect(surfaceBottomInset()).toBe(state.tabBarHeight);

    act(() => {
      showKeyboard(320);
    });
    // The raised IME becomes the reserved band, so the centered copy and its
    // action stay above the keyboard. Android reports the IME above the
    // navigation bar and the harness's bottom inset is zero, so the reserve is
    // the reported height alone.
    expect(surfaceBottomInset()).toBe(320);

    act(() => {
      for (const listener of keyboardListeners('keyboardDidHide')) {
        listener({ endCoordinates: { height: 0 } });
      }
    });
    expect(surfaceBottomInset()).toBe(state.tabBarHeight);
  });

  it('replaces the tab-bar band with the IME band while the keyboard is up', async () => {
    // The raised keyboard hides the tab bar (`tabBarHideOnKeyboard`), so the
    // bar's own height is not on screen and reserving its band on top of the
    // IME's occlusion pushed the no-match copy's second line behind the
    // keyboard on a short landscape window (explorer finding,
    // agents-search-empty).
    state.platform.OS = 'android';
    state.live.activeSessions = [{ ...row, id: 'a1', organizationId: null, title: 'Ship it' }];
    await renderScreen();
    const searchHeader = requireNode('SessionListSearchHeader');
    act(() => {
      (searchHeader.props.onChangeText as (text: string) => void)('nothing matches this');
    });
    // Keyboard down: the no-match body owns the band and hides the FAB, so the
    // raise starts from the bar's own height.
    expect(surfaceBottomInset()).toBe(state.tabBarHeight);

    act(() => {
      showKeyboard(100);
    });
    // A band shorter than the tab-bar/FAB band still wins: the bar is not on
    // screen, so its height is not a band the body must clear. The composed tree
    // floors the reserve at the enclosing tabs layout's own reservation (the tab
    // bar's height), so 100 is the reachable band that distinguishes the replace
    // rule from the max rule (which would have kept the 124px FAB band).
    expect(composedSurfaceBottomInset()).toBe(100);
  });

  it('keeps the centered band above the FAB while the keyboard is down with the FAB admitted', async () => {
    // The chrome hook resolves the centered states' keyboard-down reserve as the
    // tab bar plus the FAB band, so a centered state's full-width action (the
    // load failure's Retry, the boundary's back-to-profile) cannot reach under
    // the corner overlay (device defect e3); the state compacts instead when
    // that band is too short for it (landscape spot defect e8). While the
    // keyboard is up the IME's occlusion replaces that band.
    state.platform.OS = 'android';
    state.live.activeSessions = [row];
    await renderScreen();
    const fabBand = state.tabBarHeight + FAB_SIZE + FAB_MARGIN;
    expect(fab()).toBeDefined();
    expect(surfaceBottomInset()).toBe(fabBand);
    // Keyboard down the rows frame ends at the tab bar and the FAB clearance
    // rides on the content instead (papercut 3), so no bare band sits above the
    // bar and the button floats over the list.
    expect(nodes('FlashList')[0]?.props.style).toEqual({ marginBottom: state.tabBarHeight });

    act(() => {
      showKeyboard(100);
    });
    // A raised IME shorter than the FAB band still replaces the tab-bar/FAB band
    // for the centered states.
    expect(surfaceBottomInset()).toBe(100);
  });

  it('insets the rows viewport by the IME band so a search never parks rows behind the keyboard', async () => {
    // Android's edge-to-edge window does not resize for the IME, so a
    // keyboard-blind frame left the last rows of a search behind the keyboard
    // with no way to scroll them clear (review finding,
    // session-list-chrome.ts).
    state.platform.OS = 'android';
    state.live.activeSessions = [row];
    await renderScreen();
    const listStyle = () => nodes('FlashList')[0]?.props.style as { marginBottom: number };
    // Keyboard down the container pads nothing and the frame ends at the tab
    // bar: the FAB clearance rides on the content, not the frame.
    expect(listStyle()).toEqual({ marginBottom: state.tabBarHeight });
    expect(keyboardContainerPadding()).toBe(0);

    act(() => {
      showKeyboard(320);
    });
    // The container already pads the IME's occlusion and the frame adds only the
    // part it does not cover, so the two together end the viewport at the IME's
    // top edge instead of a whole keyboard height above it. The IME is taller
    // than the FAB band, so the frame contributes nothing.
    expect(keyboardContainerPadding()).toBe(320);
    expect(listStyle()).toEqual({ marginBottom: 0 });
    expect(keyboardContainerPadding() + listStyle().marginBottom).toBe(320);

    act(() => {
      hideKeyboard();
    });
    expect(keyboardContainerPadding()).toBe(0);
    expect(listStyle()).toEqual({ marginBottom: state.tabBarHeight });
  });

  it('keeps the rows viewport clear of the FAB when a raised IME is shorter than the button', async () => {
    // The FAB keeps its screen-bottom-anchored position while the keyboard is up
    // (it is not part of the tab bar `tabBarHideOnKeyboard` hides), so a band
    // that followed the IME's occlusion alone parked the last rows' timestamps
    // behind the button on Android, where the IME's occlusion stops at the
    // navigation bar (device defect uxs1, e1-kbup.png).
    state.platform.OS = 'android';
    state.live.activeSessions = [row];
    await renderScreen();
    const listStyle = () => nodes('FlashList')[0]?.props.style as { marginBottom: number };
    const fabBand = state.tabBarHeight + FAB_SIZE + FAB_MARGIN;

    act(() => {
      showKeyboard(100);
    });
    // The centered states still take the shorter IME band, so their copy clears
    // the keyboard rather than a phantom tab-bar band.
    expect(surfaceBottomInset()).toBe(100);
    // The rows list cannot: the container covers the IME and the frame adds the
    // rest of the FAB band, so a shorter frame never parks rows under the button.
    expect(keyboardContainerPadding()).toBe(100);
    expect(listStyle()).toEqual({ marginBottom: fabBand - 100 });
    expect(keyboardContainerPadding() + listStyle().marginBottom).toBe(fabBand);

    act(() => {
      hideKeyboard();
    });
    expect(listStyle()).toEqual({ marginBottom: state.tabBarHeight });
  });

  it('subscribes to the keyboard once for the bands, not once per band consumer', async () => {
    // Review finding (session-list-screen.tsx:101): the screen called
    // `useKeyboardOcclusion` directly while `useAgentsBottomBands` already
    // subscribes to the same events, so every band consumer added a third
    // listener beside the app-aware container's own. Both bands — including the
    // rows frame band — now come out of that one hook call.
    state.platform.OS = 'android';
    state.live.activeSessions = [row];
    await renderScreen();

    // The band hook's own subscription plus the app-aware container's.
    expect(keyboardListeners('keyboardDidShow').size).toBe(2);
    expect(keyboardListeners('keyboardDidHide').size).toBe(2);
  });

  it('narrows the live list to the search text', async () => {
    state.live.activeSessions = [
      { ...row, id: 'a1', organizationId: null, title: 'Fix the login redirect' },
      { ...row, id: 'a2', organizationId: null, title: 'Bump deps' },
    ];
    await renderScreen();

    const searchHeader = requireNode('SessionListSearchHeader');
    act(() => {
      (searchHeader.props.onChangeText as (text: string) => void)('bump');
    });

    const list = requireNode('FlashList');
    expect((list.props.data as ActiveSession[]).map(session => session.id)).toEqual(['a2']);
    expect(header().props.eyebrow).toBe('2 LIVE');
  });

  it('keeps the header right to See-all alone while nothing is filterable', async () => {
    await renderScreen();

    expect(headerActions()).toHaveLength(1);
    expect(
      headerActions().find(button => button.props.testID === 'agents-open-filters')
    ).toBeUndefined();
  });

  it('offers the filter button once a live row carries a repository', async () => {
    state.live.activeSessions = [
      { ...row, id: 'a1', organizationId: null, gitUrl: 'https://github.com/kilo/cloud.git' },
    ];
    await renderScreen();

    expect(headerAction('agents-open-filters').props.activeCount).toBe(0);
  });

  it('updates filters through the modal without pills or changing the all-live count', async () => {
    const workflow = 'https://github.com/iscekic/kilo-workflow.git';
    const code = 'https://github.com/Kilo-Org/kilocode.git';
    state.live.activeSessions = [
      {
        ...row,
        id: 'workflow',
        organizationId: null,
        gitUrl: workflow,
        createdOnPlatform: 'cloud-agent-web',
      },
      {
        ...row,
        id: 'code-cloud',
        organizationId: null,
        gitUrl: code,
        createdOnPlatform: 'cloud-agent',
      },
      { ...row, id: 'code-cli', organizationId: null, gitUrl: code, createdOnPlatform: 'cli' },
      {
        ...row,
        id: 'other',
        organizationId: null,
        gitUrl: 'https://github.com/example/other.git',
        createdOnPlatform: 'cloud-agent',
      },
    ];
    const renderer = await renderScreen();
    const searchHeader = requireNode('SessionListSearchHeader');
    for (const step of [
      {
        projects: [workflow, code],
        platforms: ['cloud-agent'],
        count: 3,
        ids: ['workflow', 'code-cloud'],
      },
      {
        projects: [code],
        platforms: ['cloud-agent'],
        count: 2,
        ids: ['code-cloud'],
      },
      {
        projects: [code],
        platforms: [],
        count: 1,
        ids: ['code-cloud', 'code-cli'],
      },
      {
        projects: [],
        platforms: [],
        count: 0,
        ids: ['workflow', 'code-cloud', 'code-cli', 'other'],
      },
    ]) {
      applyFilters(step.projects, step.platforms);
      expect(headerAction('agents-open-filters').props.activeCount).toBe(step.count);
      expect(
        (requireNode('FlashList').props.data as ActiveSession[]).map(session => session.id)
      ).toEqual(step.ids);
      expect(header().props.eyebrow).toBe('4 LIVE');
      expect(nodes('ScrollView')).toHaveLength(0);
      expect(requireNode('SessionListSearchHeader')).toBe(searchHeader);
      expect(header().parent?.children[0]).toBe(header());
      const tree = renderer.toJSON() as TestRenderer.ReactTestRendererJSON;
      expect(
        // The keyboard container is the third child; the feedback band and the
        // body (the rows list inside its measuring wrapper) share it.
        tree.children.slice(0, 3).map(child => (typeof child === 'string' ? child : child.type))
      ).toEqual(['View', 'SessionListSearchHeader', 'KeyboardAvoidingView']);
      const rows = descendantsOf(requireNode('KeyboardAvoidingView'), 'FlashList');
      expect(rows).toHaveLength(1);
      // The body wrapper that measures the list's available height is the
      // `onLayout` view the rows list hangs from (see `useAgentsListChrome`).
      const wrapper = descendantsOf(requireNode('KeyboardAvoidingView'), 'View').find(
        node =>
          typeof node.props.onLayout === 'function' && descendantsOf(node, 'FlashList').length === 1
      );
      expect(wrapper).toBeDefined();
    }
  });

  it('keeps saved repository and platform selections after a successful list retry', async () => {
    const gitUrl = 'https://github.com/example/a-long-saved-repository-name.git';
    readFilterRecord.mockImplementation(async storageKey => {
      await Promise.resolve();
      return storageKey === 'live-session-filters'
        ? JSON.stringify({ projectFilter: [gitUrl], platformFilter: ['cloud-agent'] })
        : null;
    });
    state.live.hasAcceptedSuccess = false;
    state.live.isError = true;
    state.live.terminalError = failure;
    await renderScreen();
    expect(text()).toContain('Could not load active sessions');
    expect(headerAction('agents-open-filters').props.activeCount).toBe(2);
    state.refetch.mockImplementationOnce(async () => {
      await Promise.resolve();
      state.live.isError = false;
      state.live.terminalError = null;
      state.live.hasAcceptedSuccess = true;
      state.live.activeSessions = [
        {
          ...row,
          id: 'matching',
          organizationId: null,
          gitUrl,
          createdOnPlatform: 'cloud-agent-web',
        },
        { ...row, id: 'wrong-platform', organizationId: null, gitUrl, createdOnPlatform: 'cli' },
        {
          ...row,
          id: 'wrong-repository',
          organizationId: null,
          gitUrl: 'https://github.com/example/other.git',
          createdOnPlatform: 'cloud-agent',
        },
      ];
      return true;
    });
    await act(async () => {
      press('Retry');
      await Promise.resolve();
    });
    await renderScreen();
    expect(text()).not.toContain('Could not load active sessions');
    const rows = requireNode('FlashList').props.data as ActiveSession[];
    expect(rows.map(session => session.id)).toEqual(['matching']);
    expect(headerAction('agents-open-filters').props.activeCount).toBe(2);
    expect(nodes('ScrollView')).toHaveLength(0);
    act(() => {
      headerAction('agents-open-filters').props.onPress();
    });
    expect(requireNode('SessionFilterModal').props).toMatchObject({
      selectedProjects: [gitUrl],
      selectedPlatforms: ['cloud-agent'],
    });
  });

  it('filters the live list down to the applied repository', async () => {
    state.live.activeSessions = [
      { ...row, id: 'a1', organizationId: null, gitUrl: 'https://github.com/kilo/cloud.git' },
      { ...row, id: 'a2', organizationId: null, gitUrl: 'https://github.com/kilo/other.git' },
    ];
    await renderScreen();

    act(() => {
      headerAction('agents-open-filters').props.onPress();
    });

    const modal = requireNode('SessionFilterModal');
    expect(modal.props.projectOptions).toHaveLength(2);
    act(() => {
      (modal.props.onApply as (filters: unknown) => void)({
        platformFilter: [],
        projectFilter: ['https://github.com/kilo/cloud.git'],
        sortBy: 'updated_at',
      });
    });

    const list = requireNode('FlashList');
    expect((list.props.data as ActiveSession[]).map(session => session.id)).toEqual(['a1']);
  });

  it('shows a clearable no-match state when every live row is filtered out', async () => {
    state.live.activeSessions = [
      { ...row, id: 'a1', organizationId: null, gitUrl: 'https://github.com/kilo/cloud.git' },
    ];
    const renderer = await renderScreen();

    act(() => {
      headerAction('agents-open-filters').props.onPress();
    });
    const modal = requireNode('SessionFilterModal');
    act(() => {
      (modal.props.onApply as (filters: unknown) => void)({
        platformFilter: ['slack'],
        projectFilter: [],
        sortBy: 'updated_at',
      });
    });

    const emptyState = renderer.root.findByType(EmptyState);
    expect(emptyState.props.title).toBe('No sessions match');
    expect(headerAction('agents-open-filters').props.activeCount).toBe(1);
    // The accessibly-named count matches the visible badge while narrowed.
    expect(filterButtonProps().accessibilityLabel).toBe('Filter sessions, 1');
    expect(filterButtonProps().accessibilityValue).toBeUndefined();
    expect(nodes('ScrollView')).toHaveLength(0);
    expect(header().props.eyebrow).toBe('1 LIVE');

    const clearAction = emptyState.props.action as { props: { onPress: () => void } };
    act(() => {
      clearAction.props.onPress();
    });
    expect(nodes('FlashList')).toHaveLength(1);
    expect(headerAction('agents-open-filters').props.activeCount).toBe(0);
    // Clearing drops the count from the accessible name too: no stale "1"
    // survives in the native content description after the badge unmounts.
    expect(filterButtonProps().accessibilityLabel).toBe('Filter sessions');
    expect(nodes('ScrollView')).toHaveLength(0);
  });

  it('renders the no-match state compact while the clear region is short and full when it grows', async () => {
    state.live.activeSessions = [row];
    await renderScreen();
    const compact = () => root().findByType(EmptyState).props.compact as boolean;

    const searchHeader = requireNode('SessionListSearchHeader');
    act(() => {
      (searchHeader.props.onChangeText as (text: string) => void)('nothing matches this');
    });
    // The first, unmeasured frame keeps the full presentation.
    expect(compact()).toBe(false);

    // The 420dp-tall landscape capture: the body keeps ~180dp; the 81dp bar
    // leaves ~99dp, short of the full state. Compact drops the icon bubble and
    // tightens the gaps so the hint and the action stay above the bar.
    act(() => {
      layoutBody(180);
    });
    expect(compact()).toBe(true);
    // The no-match body owns the band the tab bar leaves, so the creation FAB
    // yields instead of floating over the state's description and Clear action.
    expect(nodes('Pressable').some(node => node.props.testID === 'agents-new-session-fab')).toBe(
      false
    );
    const surface = root().findByType(StateSurfaceInsets);
    expect(surface.props.bottomInset).toBe(state.tabBarHeight);
    // The tabs layout reserves the bar alone (its 16dp content gap is
    // content-only), so the state's clear region is the body minus the bar its
    // own full-width action must clear.

    // A body that exactly clears the bar holds the whole full state; one dp less
    // is compact.
    const fullStateBody = getEmptyStateFullHeight() + state.tabBarHeight;
    act(() => {
      layoutBody(fullStateBody - 1);
    });
    expect(compact()).toBe(true);

    act(() => {
      layoutBody(fullStateBody);
    });
    expect(compact()).toBe(false);

    act(() => {
      layoutBody(900);
    });
    expect(compact()).toBe(false);
  });

  it('compacts the no-match state for a body that only holds it at the base font scale', async () => {
    state.live.activeSessions = [row];
    await renderScreen();
    const compact = () => root().findByType(EmptyState).props.compact as boolean;
    const searchHeader = requireNode('SessionListSearchHeader');
    act(() => {
      (searchHeader.props.onChangeText as (text: string) => void)('nothing matches this');
    });

    // The body that holds the whole state with the base-size text...
    const baseScaleBody = getEmptyStateFullHeight({ fontScale: 1 }) + state.tabBarHeight;
    act(() => {
      layoutBody(baseScaleBody);
    });
    expect(compact()).toBe(false);

    // ...no longer holds it once Dynamic Type grows the title, the hint and the
    // action, so the state must drop the icon bubble and tighten the gaps.
    state.fontScale = 2;
    await renderScreen();
    const grownHeader = requireNode('SessionListSearchHeader');
    act(() => {
      (grownHeader.props.onChangeText as (text: string) => void)('nothing matches this');
    });
    act(() => {
      layoutBody(baseScaleBody);
    });
    expect(compact()).toBe(true);

    act(() => {
      layoutBody(getEmptyStateFullHeight({ fontScale: 2 }) + state.tabBarHeight);
    });
    expect(compact()).toBe(false);
  });

  it('renders the live empty state compact in a short window and full in a tall one', async () => {
    await renderScreen();
    const compact = () => root().findByType(LiveSessionListEmptyState).props.compact as boolean;
    expect(compact()).toBe(false);

    act(() => {
      layoutBody(180);
    });
    expect(compact()).toBe(true);
    expect(root().findByType(EmptyState).props.compact).toBe(true);

    act(() => {
      layoutBody(900);
    });
    expect(compact()).toBe(false);
    expect(root().findByType(EmptyState).props.compact).toBe(false);
  });

  it('compacts the no-match state for the reserve reduced motion adds to the band', async () => {
    state.live.activeSessions = [row];
    await renderScreen();
    const compact = () => root().findByType(EmptyState).props.compact as boolean;
    const search = () => {
      (requireNode('SessionListSearchHeader').props.onChangeText as (text: string) => void)(
        'nothing matches this'
      );
    };
    act(search);

    // A body that holds the whole full state while no reserve sits above it...
    const holdsFullState = getEmptyStateFullHeight() + state.tabBarHeight;
    act(() => {
      layoutBody(holdsFullState);
    });
    expect(compact()).toBe(false);

    // ...no longer holds it once reduced motion reserves RefreshProgress's h-9
    // box (31.5dp) inside the band, so the state must go compact instead of
    // running its hint and Clear action under the bar.
    state.reducedMotion = true;
    await renderScreen();
    act(search);
    act(() => {
      layoutBody(holdsFullState);
    });
    expect(compact()).toBe(true);
  });
});

describe('Live list admission and lifecycle', () => {
  it.each(['pending', 'failed'] as const)(
    'admits personal creation while membership is %s',
    async mode => {
      state.boundary.orgs = undefined;
      state.boundary.isResolving = mode === 'pending';
      state.boundary.isError = mode === 'failed';
      state.live.hasAcceptedSuccess = false;
      await renderScreen();
      press('New session');
      expect(state.destination).toBe('/(app)/agent-chat/new');
      expect(state.liveQuery).toHaveBeenLastCalledWith({ organizationId: null, enabled: true });
    }
  );

  it.each([
    'account pending',
    'signed out',
    'signing out',
    'selection pending',
    'membership paused',
    'membership missing',
    'permission denied',
  ] as const)('suppresses protected rows for %s', async mode => {
    state.live.activeSessions = [row];
    state.organization.organizationId = 'org-1';
    state.boundary.orgs = [{ organizationId: 'org-1', organizationName: 'Engineering' }];
    if (mode === 'account pending') {
      state.auth.isLoading = true;
    }
    if (mode === 'signed out') {
      state.auth.token = undefined;
    }
    if (mode === 'signing out') {
      state.auth.isSigningOut = true;
    }
    if (mode === 'selection pending') {
      state.organization.isLoaded = false;
    }
    if (mode === 'membership paused') {
      state.boundary.orgs = undefined;
    }
    if (mode === 'membership missing') {
      state.boundary.orgs = [];
    }
    if (mode === 'permission denied') {
      state.live.terminalError = { kind: 'non-retryable', error: { data: { code: 'FORBIDDEN' } } };
    }
    await renderScreen();
    expect(state.liveQuery).toHaveBeenLastCalledWith({
      organizationId: 'org-1',
      enabled: mode === 'permission denied',
    });
    expect(nodes('FlashList')).toHaveLength(0);
    expect(header().props.eyebrow).toBeUndefined();
    expect(text()).not.toContain('Nothing running right now');
    if (mode !== 'permission denied') {
      expect(nodes('Pressable').some(node => node.props.testID === 'agents-new-session-fab')).toBe(
        false
      );
      expect(text()).not.toContain('Engineering');
    }
    if (mode === 'membership paused') {
      expect(listSkeletons()).toHaveLength(8);
      expect(text()).not.toContain('Organization unavailable');
    }
    if (mode === 'membership missing' || mode === 'permission denied') {
      expect(text()).toContain(
        mode === 'permission denied' ? 'Access denied' : 'Organization unavailable'
      );
      expect(nodes('Pressable').some(node => node.props.accessibilityLabel === 'Retry')).toBe(
        false
      );
    }
    headerAction().props.onPress();
    expect(state.destination).toBe('/(app)/(tabs)/(2_agents)/history');
  });

  it('refreshes the organization error through the context and resumes session refresh after recovery', async () => {
    state.organization.organizationId = 'org-1';
    state.boundary.isError = true;
    state.boundary.orgs = undefined;
    const pending = Promise.withResolvers<undefined>();
    state.boundaryRefetch.mockReturnValue(pending.promise);
    await renderScreen();
    const refresh = () =>
      nodes('CenteredState')[0]?.props.refreshControl as {
        props: { refreshing: boolean; onRefresh: () => void };
      };
    act(() => {
      refresh().props.onRefresh();
    });
    expect(state.boundaryRefetch).toHaveBeenCalledOnce();
    expect(state.refetch).not.toHaveBeenCalled();
    expect(refresh().props.refreshing).toBe(true);
    await act(async () => {
      pending.resolve(undefined);
      await pending.promise;
    });
    expect(refresh().props.refreshing).toBe(false);

    state.organization.organizationId = null;
    state.live.activeSessions = [row];
    await renderScreen();
    const readyRefresh = nodes('FlashList')[0]?.props.refreshControl as {
      props: { onRefresh: () => void };
    };
    await act(async () => {
      readyRefresh.props.onRefresh();
      await Promise.resolve();
    });
    expect(state.refetch).toHaveBeenCalledOnce();
    expect(state.boundaryRefetch).toHaveBeenCalledOnce();
  });

  it('recovers membership through boundary Retry and revokes admission on an unresolved organization change', async () => {
    state.organization.organizationId = 'org-1';
    state.boundary.isError = true;
    state.boundary.orgs = undefined;
    await renderScreen();
    expect(text()).toContain("Couldn't load your organizations");
    state.boundaryRefetch.mockImplementation(async () => {
      state.boundary.isError = false;
      state.boundary.orgs = [{ organizationId: 'org-1', organizationName: 'Engineering' }];
      await Promise.resolve();
    });
    await act(async () => {
      press('Retry');
      await Promise.resolve();
    });
    await renderScreen();
    expect(state.liveQuery).toHaveBeenLastCalledWith({ organizationId: 'org-1', enabled: true });
    expect(text()).toContain('Nothing running right now');
    press('New session');
    expect(state.destination).toBe('/(app)/agent-chat/new?organizationId=org-1');
    expect(state.boundaryRefetch).toHaveBeenCalledTimes(1);
    expect(state.refetch).not.toHaveBeenCalled();
    state.organization.organizationId = 'org-2';
    state.live.activeSessions = [row];
    await renderScreen();
    expect(state.liveQuery).toHaveBeenLastCalledWith({ organizationId: 'org-2', enabled: false });
    expect(nodes('FlashList')).toHaveLength(0);
    expect(header().props.eyebrow).toBeUndefined();
  });

  it('refreshes live sessions once on focus and foreground', async () => {
    state.refetch.mockImplementationOnce(async () => {
      await Promise.resolve();
      state.live.activeSessions = [row];
      return true;
    });
    await renderScreen();
    expect(nodes('FlashList')).toHaveLength(0);
    act(() => {
      for (const effect of state.focusCallbacks) {
        effect();
      }
    });
    await renderScreen();
    expect(nodes('RemoteSessionRow')[0]?.props.session).toMatchObject({ title: 'Live task' });
    state.refetch.mockImplementationOnce(async () => {
      await Promise.resolve();
      state.live.activeSessions = [{ ...row, title: 'Foreground result' }];
      return true;
    });
    act(foreground);
    await renderScreen();
    expect(nodes('RemoteSessionRow')[0]?.props.session).toMatchObject({
      title: 'Foreground result',
    });
    expect(state.refetch).toHaveBeenCalledTimes(2);
    expect(state.invalidate).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'does not refresh an unfocused tab, including post-mount blur=%s',
    async blurAfterMount => {
      state.refetch.mockImplementation(async () => {
        await Promise.resolve();
        state.live.activeSessions = [row];
        return true;
      });
      state.focused = blurAfterMount;
      await renderScreen();
      state.focused = false;
      act(foreground);
      await renderScreen();
      expect(text()).toContain('Nothing running right now');
      expect(nodes('FlashList')).toHaveLength(0);
      expect(state.refetch).not.toHaveBeenCalled();
      expect(state.invalidate).not.toHaveBeenCalled();
    }
  );
});
