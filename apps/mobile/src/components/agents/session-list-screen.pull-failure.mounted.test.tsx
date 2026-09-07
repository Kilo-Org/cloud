/* eslint-disable max-lines, typescript-eslint/no-deprecated -- DOM-free mounted repro: the live Agents tab exercises the REAL hook chain (useLiveAgentSessions → useActiveSessions → ActiveSessionsLiveSync → query cache) with a controlled failing network, matching the app-level ActiveSessionsLiveSyncMount in (app)/_layout. */
import { createElement, Fragment, type ReactNode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';

import { AgentSessionListScreen } from './session-list-screen';
import { PULL_FEEDBACK_MIN_BEAT_MS } from './use-pull-refresh';
import { ActiveSessionsLiveSync } from '@/lib/active-sessions-live-sync';
import {
  makeCached,
  makeTestQueryClient,
  QUERY_KEY,
} from '@/lib/active-sessions-live-sync.test-helpers';
import { type CachedActiveSessionsData } from '@/lib/active-sessions-live';

type Responder = () => Promise<CachedActiveSessionsData>;

const network = vi.hoisted(() => ({
  responder: (() => {
    throw new Error('network responder not installed');
  }) as Responder,
  wsConnected: true,
}));

const appState = vi.hoisted(() => ({
  listener: undefined as ((nextState: string) => void) | undefined,
  addEventListener: (_event: string, listener: (nextState: string) => void) => {
    appState.listener = listener;
    return {
      remove: () => {
        appState.listener = undefined;
      },
    };
  },
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    activeSessions: {
      list: {
        queryKey: (input: unknown) => [['activeSessions', 'list'], { type: 'query', input }],
        queryOptions: (input: unknown, opts?: Record<string, unknown>) => ({
          queryKey: [['activeSessions', 'list'], { type: 'query', input }],
          queryFn: async () => {
            const result = await network.responder();
            return result;
          },
          ...opts,
        }),
      },
    },
  }),
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
vi.mock('@/components/centered-state-surface', () => ({
  StateSurfaceInsets: ({ children }: { children: ReactNode }): ReactNode => children,
}));
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  InteractionManager: {
    runAfterInteractions: (run: () => void) => {
      run();
      return { cancel: () => undefined };
    },
  },
  Platform: { OS: 'ios' },
  Modal: 'Modal',
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  useWindowDimensions: () => ({ fontScale: 1 }),
  AppState: appState,
  FlatList: (props: {
    data: { id: string }[];
    renderItem: (entry: { item: { id: string } }) => ReactNode;
    keyExtractor: (item: { id: string }) => string;
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
  useNavigation: () => ({ isFocused: () => true }),
  useFocusEffect: () => undefined,
  useRouter: () => ({
    push: () => undefined,
    replace: () => undefined,
  }),
  useScrollToTop: () => undefined,
}));
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: vi.fn() }),
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
  Search: 'Search',
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
vi.mock('@/components/agents/platform-filter-modal', () => ({
  SessionFilterModal: 'SessionFilterModal',
}));
vi.mock('@/components/agents/use-agent-session-navigator', () => ({
  useAgentSessionNavigator: () => () => undefined,
}));
vi.mock('@/components/home/section-header', () => ({ SectionHeader: 'SectionHeader' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', async () => {
  const { createContext } = await import('react');
  return { Text: 'Text', TextClassContext: createContext('') };
});
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ token: 'account', isLoading: false, isSigningOut: false, authEpoch: 0 }),
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({
    organizationId: null,
    isLoaded: true,
    error: null,
    retry: vi.fn(),
    setOrganizationId: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: () => ({
    orgs: [],
    org: undefined,
    isResolving: false,
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
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
  useCommittedConnectivityStatus: () => 'online',
}));
vi.mock('@/lib/hooks/use-user-web-connection-state', () => ({
  useUserWebConnectionState: () => network.wsConnected,
  useUserWebConnectionHealth: () => ({
    isConnected: network.wsConnected,
    reconnectExhausted: false,
  }),
}));
vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => ({ retryConnection: vi.fn() }),
}));
vi.mock('@/lib/a11y/announce', () => ({
  announceForA11y: vi.fn(),
}));
vi.mock('@/lib/tab-bar-layout', () => ({ getEffectiveTabBarHeight: () => 60 }));

let mountedRenderer: TestRenderer.ReactTestRenderer | undefined = undefined;
let client: ReturnType<typeof makeTestQueryClient> | undefined = undefined;
let detachSync: (() => void) | undefined = undefined;

function root() {
  if (!mountedRenderer) {
    throw new Error('Missing live list');
  }
  return mountedRenderer.root;
}

function nodes(type: string) {
  return root().findAll(node => typeof node.type === 'string' && node.type === type);
}

function text() {
  return nodes('Text')
    .map(node => node.children.filter(child => typeof child === 'string').join(''))
    .join('\n');
}

async function flushMount() {
  await new Promise(resolve => {
    setTimeout(resolve, 0);
  });
  await new Promise(resolve => {
    setTimeout(resolve, 0);
  });
  await new Promise(resolve => {
    setTimeout(resolve, 0);
  });
}

async function renderScreen() {
  const activeClient = client;
  if (!activeClient) {
    throw new Error('Missing query client');
  }
  const sync = new ActiveSessionsLiveSync({
    connection: {
      retain: () => () => undefined,
      isConnected: () => network.wsConnected,
      onSystemEvent: () => () => undefined,
      onConnectionChange: () => () => undefined,
    },
    queryClient: activeClient,
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const result = await network.responder();
      return result;
    },
  });
  detachSync = sync.attach();
  await act(async () => {
    const tree = createElement(
      QueryClientProvider,
      { client: activeClient },
      createElement(AgentSessionListScreen)
    );
    if (mountedRenderer) {
      mountedRenderer.update(tree);
    } else {
      mountedRenderer = TestRenderer.create(tree);
    }
    await flushMount();
  });
  if (!mountedRenderer) {
    throw new Error('Missing live list');
  }
  return mountedRenderer;
}

function refreshControl() {
  const control = nodes('FlatList')[0]?.props.refreshControl as
    | { props: { refreshing: boolean; onRefresh: () => void } }
    | undefined;
  if (!control) {
    throw new Error('Missing refresh control');
  }
  return control.props;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  network.wsConnected = true;
  appState.listener = undefined;
  readFilterRecord.mockReset().mockResolvedValue(null);
  client = makeTestQueryClient();
  client.setQueryData(QUERY_KEY, {
    sessions: [makeCached({ createdOnPlatform: 'cli', organizationId: null })],
  });
  network.responder = async () => {
    const result = await Promise.resolve({
      sessions: [makeCached({ createdOnPlatform: 'cli', organizationId: null })],
    });
    return result;
  };
});

afterEach(async () => {
  detachSync?.();
  detachSync = undefined;
  act(() => mountedRenderer?.unmount());
  mountedRenderer = undefined;
  client = undefined;
  await i18nChangeLanguageEn();
});

async function i18nChangeLanguageEn() {
  const { i18n } = await import('@/i18n');
  await i18n.changeLanguage('en');
}

describe('AgentSessionListScreen pull-to-refresh with the API down', () => {
  async function expectFailedPullKeepsRowsAndShowsInlineRetry() {
    await renderScreen();
    expect(nodes('FlatList')).toHaveLength(1);
    expect(nodes('RemoteSessionRow')).toHaveLength(1);
    expect(text()).not.toContain("Couldn't refresh");

    // Pull to refresh: the API just went down, and the fetch hangs in flight.
    const failure = new Error('nextjs is down (ECONNREFUSED)');
    const inFlight = Promise.withResolvers<CachedActiveSessionsData>();
    network.responder = async () => {
      const result = await inFlight.promise;
      return result;
    };
    act(() => {
      refreshControl().onRefresh();
    });
    expect(refreshControl().refreshing).toBe(true);

    // The in-flight pull shows the visible Updating status line (reserved
    // space beside the rows, announced to assistive tech).
    await act(async () => {
      await vi.waitFor(
        () => {
          expect(text()).toContain('Updating');
        },
        { timeout: 2000, interval: 10 }
      );
    });

    // The fetch then fails through the real query lifecycle. The rejected
    // pull holds the in-flight feedback through the beat first, so the
    // failure line lands past PULL_FEEDBACK_MIN_BEAT_MS.
    act(() => {
      inFlight.reject(failure);
    });
    await act(async () => {
      await new Promise(resolve => {
        setTimeout(resolve, PULL_FEEDBACK_MIN_BEAT_MS + 250);
      });
    });

    // The inline retryable failure with a working Retry action, next to the kept rows.
    expect(text()).toContain("Couldn't refresh");
    const retry = nodes('Pressable').find(node => node.props.accessibilityLabel === 'Retry');
    expect(retry).toBeDefined();
    expect(retry?.props.onPress).toBeTypeOf('function');
    expect(nodes('RemoteSessionRow')).toHaveLength(1);
    expect(refreshControl().refreshing).toBe(false);
  }

  it('keeps rows, shows Updating in flight, and the inline failure with Retry (socket up)', async () => {
    await expectFailedPullKeepsRowsAndShowsInlineRetry();
  }, 15_000);

  it('keeps the same unhappy state when the API outage also dropped the socket', async () => {
    // Stopping nextjs drops both HTTP and the user-web socket.
    network.wsConnected = false;
    await expectFailedPullKeepsRowsAndShowsInlineRetry();
  }, 15_000);

  it('retires the pull failure when a later app-foreground refresh lands', async () => {
    await expectFailedPullKeepsRowsAndShowsInlineRetry();

    // The API is back, and a refresh outside the pull lifecycle (app
    // foreground) settles on an accepted result: the list is up to date, so
    // the stale failure line must retire instead of claiming "Couldn't
    // refresh" with Retry on an up-to-date list.
    network.responder = async () => {
      const result = await Promise.resolve({
        sessions: [makeCached({ createdOnPlatform: 'cli', organizationId: null })],
      });
      return result;
    };
    await act(async () => {
      appState.listener?.('active');
      await flushMount();
      await vi.waitFor(
        () => {
          expect(text()).not.toContain("Couldn't refresh");
        },
        { timeout: 2000, interval: 10 }
      );
    });
    expect(
      nodes('Pressable').find(node => node.props.accessibilityLabel === 'Retry')
    ).toBeUndefined();
    expect(refreshControl().refreshing).toBe(false);
    expect(nodes('RemoteSessionRow')).toHaveLength(1);
  }, 15_000);
});
