/* eslint-disable max-lines, typescript-eslint/no-deprecated -- DOM-free live-list matrix and focus/navigation regressions share one mounted fixture. */
import { createElement, Fragment, type ReactNode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type * as PlatformFilterModule from './platform-filter-modal';
import { AgentSessionListScreen } from './session-list-screen';
import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { type ActiveSession, type useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';
import { type BannerState } from '@/lib/offline-banner-state';

type Org = { organizationId: string; organizationName: string };
const state = vi.hoisted(() => ({
  focused: true,
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
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  Modal: 'Modal',
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  useWindowDimensions: () => ({ fontScale: 1 }),
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
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
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
vi.mock('@/lib/tab-bar-layout', () => ({ getEffectiveTabBarHeight: () => 60 }));
vi.mock('@/lib/hooks/use-agent-sessions', () => ({
  useLiveAgentSessions: () => ({ ...state.live, refetch: state.refetch }),
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
  return nodes('Skeleton').filter(node => node.props.className.includes('h-[76px]'));
}
function contextControl() {
  return header().find(
    node => node.type === 'Pressable' && node.props.accessibilityHint === 'Select account'
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
  readFilterRecord.mockReset().mockResolvedValue(null);
});
afterEach(() => {
  act(() => mountedRenderer?.unmount());
  mountedRenderer = undefined;
  state.listeners.clear();
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
    expect(nodes('FlatList')).toHaveLength(test.rows ? 1 : 0);
    expect(text()).toContain('Personal');
    expect(headerAction().props.testID).toBe('agents-view-history');
    expect(headerAction().props.accessibilityRole).toBe('button');
    headerAction().props.onPress();
    expect(state.destination).toBe('/(app)/(tabs)/(2_agents)/history');
    if (test.empty) {
      expect(nodes('Pressable').some(node => node.props.testID === 'agents-new-session-fab')).toBe(
        false
      );
      press('New coding task');
    } else {
      press('New session');
    }
    expect(state.destination).toBe('/(app)/agent-chat/new');
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

  it('keeps the retained error and Retry mounted as socket rows appear and disappear', async () => {
    state.live.hasAcceptedSuccess = false;
    state.live.terminalError = failure;
    await renderScreen();
    const message = 'Could not load active sessions';
    const retry = action('Retry');
    const status = nodes('Text').find(node => node.children.includes(message));
    expect(status).toBeDefined();
    expect(nodes('AlertCircle')).toHaveLength(1);

    async function updateSocketRows(activeSessions: ActiveSession[]) {
      state.live.activeSessions = activeSessions;
      await renderScreen();
      expect(nodes('RemoteSessionRow')).toHaveLength(activeSessions.length);
      expect.soft(action('Retry') === retry).toBe(true);
      expect
        .soft(nodes('Text').find(node => node.children.includes(message)) === status)
        .toBe(true);
      expect.soft(state.announcements).toEqual([message]);
      expect(nodes('AlertCircle')).toHaveLength(activeSessions.length === 0 ? 1 : 0);
    }
    await updateSocketRows([row]);
    await updateSocketRows([]);
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

describe('AgentSessionListScreen context control', () => {
  it('keeps the context picker and history action mounted', async () => {
    await renderScreen();
    expect(header().parent?.children[0]).toBe(header());
    expect(contextControl().props.accessibilityRole).toBe('button');
    expect(contextControl().props.accessibilityLabel).toBe('Personal');
    expect(contextControl().props.accessibilityState).toEqual({ busy: false, disabled: false });
    expect(headerAction().props.accessibilityRole).toBe('button');
  });

  it('keeps the context and list unresolved until the organization restores', async () => {
    state.organization.isLoaded = false;
    state.boundary.orgs = [{ organizationId: 'org-1', organizationName: 'Agents organization' }];
    await renderScreen();
    expect(contextControl().props.accessibilityState).toEqual({ busy: true, disabled: true });
    expect(contextControl().props.accessibilityLabel).toBe('Select account');
    expect(nodes('Skeleton')).toHaveLength(9);
    expect(nodes('FlatList')).toHaveLength(0);
    expect(text()).not.toContain('Personal');
    state.organization.organizationId = 'org-1';
    state.organization.isLoaded = true;
    await renderScreen();
    expect(contextControl().props.accessibilityLabel).toBe('Agents organization');
    expect(contextControl().props.accessibilityState).toEqual({ busy: false, disabled: false });
    expect(headerAction().props.accessibilityRole).toBe('button');
  });
});

describe('AgentSessionListScreen live counts', () => {
  it.each([
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
    act(() => {
      (emptyState.props.action as { props: { onPress: () => void } }).props.onPress();
    });

    expect(nodes('FlatList')).toHaveLength(1);
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

  it('keeps real pills, counts, results, and search placement in sync through removal', async () => {
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
    expect(nodes('ScrollView')).toHaveLength(0);
    act(() => {
      headerAction('agents-open-filters').props.onPress();
    });
    const modal = requireNode('SessionFilterModal');
    act(() => {
      (modal.props.onApply as (filters: unknown) => void)({
        projectFilter: [workflow, code],
        platformFilter: ['cloud-agent'],
      });
      (modal.props.onClose as () => void)();
    });
    const visibleIds = () =>
      (requireNode('FlatList').props.data as ActiveSession[]).map(session => session.id);
    expect(visibleIds()).toEqual(['workflow', 'code-cloud']);
    expect(headerAction('agents-open-filters').props.activeCount).toBe(3);
    const strip = nodes('ScrollView')[0];
    expect((strip?.props.className as string | undefined)?.split(' ')).toEqual(
      expect.arrayContaining(['grow-0', 'shrink-0'])
    );
    expect(header().parent?.children[0]).toBe(header());
    const selectedTree = renderer.toJSON() as TestRenderer.ReactTestRendererJSON;
    expect(
      selectedTree.children
        ?.slice(0, 4)
        .map(child => (typeof child === 'string' ? child : child.type))
    ).toEqual(['View', 'View', 'SessionListSearchHeader', 'ScrollView']);

    for (const step of [
      {
        label: 'Remove iscekic/kilo-workflow project filter',
        count: 2,
        ids: ['code-cloud'],
      },
      {
        label: 'Remove Cloud platform filter',
        count: 1,
        ids: ['code-cloud', 'code-cli'],
      },
      {
        label: 'Remove Kilo-Org/kilocode project filter',
        count: 0,
        ids: ['workflow', 'code-cloud', 'code-cli', 'other'],
      },
    ]) {
      act(() => {
        press(step.label);
      });
      expect(headerAction('agents-open-filters').props.activeCount).toBe(step.count);
      expect(visibleIds()).toEqual(step.ids);
    }
    expect(nodes('ScrollView')).toHaveLength(0);
    const clearedTree = renderer.toJSON() as TestRenderer.ReactTestRendererJSON;
    expect(
      clearedTree.children
        ?.slice(0, 4)
        .map(child => (typeof child === 'string' ? child : child.type))
    ).toEqual(['View', 'View', 'SessionListSearchHeader', 'FlatList']);
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
    expect(
      requireNode('ScrollView').findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'Pressable'
      )
    ).toHaveLength(2);
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
    expect(nodes('ScrollView')).toHaveLength(1);

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
      expect(text()).toContain('Personal');
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
    expect(nodes('FlatList')).toHaveLength(0);
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

  it('recovers membership through boundary Retry, scopes empty content, and drops old labels on a context change', async () => {
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
    expect(text()).toContain('Engineering');
    expect(text()).toContain('Nothing running right now');
    press('New coding task');
    expect(state.destination).toBe('/(app)/agent-chat/new?organizationId=org-1');
    expect(state.refetch).not.toHaveBeenCalled();
    state.organization.organizationId = 'org-2';
    state.live.activeSessions = [row];
    await renderScreen();
    expect(text()).not.toContain('Engineering');
    expect(nodes('FlatList')).toHaveLength(0);
  });

  it('refreshes live sessions on focus and preserves foreground tray invalidation', async () => {
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
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: [['activeSessions']] });
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
