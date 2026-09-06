/* eslint-disable max-lines, typescript-eslint/no-deprecated -- DOM-free live-list matrix and focus/navigation regressions share one mounted fixture. */
import { createElement, Fragment, type ReactNode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import type * as PlatformFilterModule from './platform-filter-modal';
import { AgentSessionListScreen } from './session-list-screen';
import { StateSurfaceInsets } from '@/components/centered-state-surface';
import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { type ActiveSession, type useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';
import { type BannerState } from '@/lib/offline-banner-state';

type Org = { organizationId: string; organizationName: string };
const state = vi.hoisted(() => ({
  focused: true,
  fontScale: 1,
  topInset: 0,
  tabBarHeight: 60,
  focusCallbacks: new Set<() => void>(),
  listeners: new Set<(state: string) => void>(),
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
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  Modal: 'Modal',
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  useWindowDimensions: () => ({ fontScale: state.fontScale }),
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
  useSafeAreaInsets: () => ({ top: state.topInset, bottom: 0 }),
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
  const right = header().props.headerRight as {
    props: { children: (HeaderElement | null)[] };
  };
  return right.props.children.filter((child): child is HeaderElement => child !== null);
}
function headerAction(testID = 'agents-view-history') {
  const button = headerActions().find(child => child.props.testID === testID);
  const isMounted = nodes('Pressable').some(node => node.props.testID === testID);
  if (!button || !isMounted) {
    throw new Error(`Missing header action: ${testID}`);
  }
  return button;
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
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.focused = true;
  state.fontScale = 1;
  state.topInset = 0;
  state.tabBarHeight = 60;
  state.focusCallbacks.clear();
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
    expect(text().includes('Could not load active sessions')).toBe(Boolean(test.error));
    expect(text().includes('Updating')).toBe(Boolean(test.updating));
    expect(text().includes('Loading…')).toBe(Boolean(test.skeleton));
    expect(nodes('FlatList')).toHaveLength(test.rows ? 1 : 0);
    expect(nodes('ScrollView')).toHaveLength(0);
    expect(nodes('CenteredState')).toHaveLength(test.empty || (test.error && !test.rows) ? 1 : 0);
    expect(root().findByType(StateSurfaceInsets).props.bottomInset).toBe(
      state.tabBarHeight + (test.empty ? 0 : 64)
    );
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
    expect(header().props.context).toBeUndefined();
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
    const list = nodes('FlatList')[0];
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
    expect(nodes('FlatList')[0]).toBe(list);
    expect(nodes('RemoteSessionRow')[0]).toBe(originalRow);
    expect(nodes('FlatList')[0]?.props.maintainVisibleContentPosition).toEqual({
      minIndexForVisible: 0,
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
      expect(text()).toContain(expected);
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
      act(() => {
        press('Retry');
        press('Retry');
      });
      expect(action('Retry').props.disabled).toBe(true);
      expect(action('Retry').props.accessibilityState).toMatchObject({
        busy: true,
        disabled: true,
      });
      expect(action('Retry connection').props.disabled).toBe(false);
      const queryRetry = action('Retry');
      const socketRetry = action('Retry connection');
      expect(
        nodes('View').filter(
          view =>
            view.props.accessible === true &&
            view.findAll(node => node === queryRetry || node === socketRetry).length > 0
        )
      ).toHaveLength(0);
      expect(state.refetch).toHaveBeenCalledTimes(1);
      await act(async () => {
        pending.resolve(false);
        await pending.promise;
      });
      expect(action('Retry').props.disabled).toBe(false);
      expect(text()).toContain('Could not load active sessions');
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
      expect(nodes('FlatList')).toHaveLength(cached ? 1 : 0);
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
    const message = 'Could not load active sessions';
    expect(text()).toContain(message);
    expect(nodes('CenteredState')).toHaveLength(1);

    async function updateSocketRows(activeSessions: ActiveSession[]) {
      state.live.activeSessions = activeSessions;
      await renderScreen();
      expect(nodes('RemoteSessionRow')).toHaveLength(activeSessions.length);
      expect(nodes('CenteredState')).toHaveLength(activeSessions.length === 0 ? 1 : 0);
      expect(text()).toContain(message);
      expect(state.announcements).toEqual([message]);
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
      nodes('FlatList')[0]?.props.refreshControl as {
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
    expect(refresh().props.refreshing).toBe(false);
    expect(text()).toContain('Could not load active sessions');
    expect(
      state.announcements.filter(message => message === 'Could not load active sessions')
    ).toHaveLength(1);
  });

  it('does not announce on a successful pull with cached rows', async () => {
    state.live.activeSessions = [row];
    await renderScreen();
    const refresh = nodes('FlatList')[0]?.props.refreshControl as {
      props: { onRefresh: () => void };
    };
    await act(async () => {
      refresh.props.onRefresh();
      await Promise.resolve();
    });
    expect(state.refetch).toHaveBeenCalledTimes(1);
    expect(state.announcements).toEqual([]);
  });

  it('passes a numeric attention revision as extraData to the live FlatList', async () => {
    state.live.activeSessions = [row];
    await renderScreen();
    expect(typeof nodes('FlatList')[0]?.props.extraData).toBe('number');
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
    const actions = history.parent;
    const actionSlot = actions?.parent;
    const title = header().findByProps({ accessibilityRole: 'header' });
    expect(actionSlot?.props.className).toContain('max-w-[50%]');
    expect(actionSlot?.props.className).not.toContain('shrink-0');
    expect(history.props.className).toContain('min-w-0');
    expect(history.props.className).toContain('shrink');
    expect(actions?.props.className).toContain('items-center');
    expect(label.props.className).toContain('text-center');
    expect(label.props.numberOfLines).toBeUndefined();
    expect(label.props.allowFontScaling).not.toBe(false);
    expect(label.props.adjustsFontSizeToFit).not.toBe(true);
    expect(title.parent?.parent?.parent).toBe(actionSlot?.parent);
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
    expect(nodes('FlatList')).toHaveLength(0);
    expect(header().props.eyebrow).toBeUndefined();
    state.boundary.isResolving = false;
    await renderScreen();
    expect(state.liveQuery).toHaveBeenLastCalledWith({ organizationId: 'org-1', enabled: true });
    expect(nodes('RemoteSessionRow')[0]?.props.session).toBe(row);
    expect(header().props.eyebrow).toBe('1 LIVE');
  });

  it('centers the header controls without a context control above search', async () => {
    state.live.activeSessions = [{ ...row, gitUrl: 'https://github.com/kilo/cloud.git' }];
    await renderScreen();
    expect(header().props.context).toBeUndefined();
    expect(
      nodes('Pressable').filter(node => node.props.accessibilityHint === 'Select account')
    ).toHaveLength(0);
    expect(text()).not.toContain('Personal');
    expect(nodes('SessionListSearchHeader')).toHaveLength(1);
    const history = nodes('Pressable').find(node => node.props.testID === 'agents-view-history');
    const filters = nodes('Pressable').find(node => node.props.testID === 'agents-open-filters');
    expect(history?.parent?.props.className).toContain('items-center');
    expect(history?.parent?.props.className).toContain('min-h-11');
    expect(filters?.parent?.parent).toBe(history?.parent);
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
    expect(nodes('FlatList')).toHaveLength(0);
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
    expect(nodes('FlatList')).toHaveLength(orgLoaded ? 1 : 0);
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
    expect(nodes('FlatList')).toHaveLength(0);
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

    const list = requireNode('FlatList');
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
    expect(nodes('FlatList')).toHaveLength(0);
    expect(requireNode('SessionListSearchHeader')).toBe(searchHeader);
    act(() => {
      (emptyState.props.action as { props: { onPress: () => void } }).props.onPress();
    });

    expect(nodes('FlatList')).toHaveLength(1);
    expect(nodes('CenteredState')).toHaveLength(0);
    expect(requireNode('SessionListSearchHeader')).toBe(searchHeader);
    expect(headerAction('agents-open-filters').props.activeCount).toBe(1);
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

    const list = requireNode('FlatList');
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
        (requireNode('FlatList').props.data as ActiveSession[]).map(session => session.id)
      ).toEqual(step.ids);
      expect(header().props.eyebrow).toBe('4 LIVE');
      expect(nodes('ScrollView')).toHaveLength(0);
      expect(requireNode('SessionListSearchHeader')).toBe(searchHeader);
      expect(header().parent?.children[0]).toBe(header());
      const tree = renderer.toJSON() as TestRenderer.ReactTestRendererJSON;
      expect(
        tree.children?.slice(0, 4).map(child => (typeof child === 'string' ? child : child.type))
      ).toEqual(['View', 'SessionListSearchHeader', 'View', 'FlatList']);
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
    const rows = requireNode('FlatList').props.data as ActiveSession[];
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

    const list = requireNode('FlatList');
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
    expect(nodes('ScrollView')).toHaveLength(0);
    expect(header().props.eyebrow).toBe('1 LIVE');

    const clearAction = emptyState.props.action as { props: { onPress: () => void } };
    act(() => {
      clearAction.props.onPress();
    });
    expect(nodes('FlatList')).toHaveLength(1);
    expect(headerAction('agents-open-filters').props.activeCount).toBe(0);
    expect(nodes('ScrollView')).toHaveLength(0);
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
    expect(nodes('FlatList')).toHaveLength(0);
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
    const readyRefresh = nodes('FlatList')[0]?.props.refreshControl as {
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
    expect(nodes('FlatList')).toHaveLength(0);
    expect(header().props.eyebrow).toBeUndefined();
  });

  it('refreshes live sessions once on focus and foreground', async () => {
    state.refetch.mockImplementationOnce(async () => {
      await Promise.resolve();
      state.live.activeSessions = [row];
      return true;
    });
    await renderScreen();
    expect(nodes('FlatList')).toHaveLength(0);
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
      expect(nodes('FlatList')).toHaveLength(0);
      expect(state.refetch).not.toHaveBeenCalled();
      expect(state.invalidate).not.toHaveBeenCalled();
    }
  );
});
