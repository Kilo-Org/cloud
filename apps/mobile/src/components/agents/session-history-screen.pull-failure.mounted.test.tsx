/* eslint-disable max-lines -- DOM-free mounted repro: the live Agents history screen exercises the REAL AgentSessionListContent and SessionListSearchHeader (pull state, Updating status, inline retry) over a mocked data hook with a controlled failing refetch, mirroring the live-tab pull-failure mount test. */
import { createElement, type ReactNode } from 'react';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { type StoredSession } from '@/lib/hooks/use-agent-sessions';
import { createTestQueryClient, renderWithProviders } from '@/test/render-with-providers';
import { PULL_FEEDBACK_BUDGET_MS } from './use-pull-refresh';
import { SessionHistoryScreen } from './session-history-screen';

type MockStoredSession = Pick<StoredSession, 'session_id' | 'organization_id'> &
  Partial<Pick<StoredSession, 'git_url' | 'created_on_platform'>>;

const listState = vi.hoisted(() => ({
  storedSessions: [] as MockStoredSession[],
  isError: false,
  storedIsFetching: false,
}));

const refetchControl = vi.hoisted(() => {
  let pending: Promise<void> | undefined = undefined;
  return {
    settle: undefined as (() => void) | undefined,
    /** Next refetch call hangs until `settle` runs; resolves immediately when no hang is armed.
     * React Query refetches never reject — they resolve and the query error state renders. */
    refetch: async (): Promise<void> => {
      if (!pending) {
        return;
      }
      const armed = pending;
      pending = undefined;
      await armed;
    },
    armHang: (): void => {
      pending = new Promise<void>(resolve => {
        refetchControl.settle = () => {
          refetchControl.settle = undefined;
          resolve();
        };
      });
    },
  };
});

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
  TextInput: 'TextInput',
  useWindowDimensions: () => ({ fontScale: 1 }),
  AppState: appState,
  SectionList: (props: {
    sections: { data: MockStoredSession[] }[];
    renderItem: (entry: { item: MockStoredSession }) => ReactNode;
    keyExtractor: (item: MockStoredSession) => string;
  }) =>
    createElement(
      'SectionList',
      props,
      props.sections.flatMap(section =>
        section.data.map(item =>
          createElement('View', { key: props.keyExtractor(item) }, props.renderItem({ item }))
        )
      )
    ),
}));
vi.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'AnimatedView', createAnimatedComponent: (component: unknown) => component },
  FadeIn: { duration: () => undefined },
  FadeOut: { duration: () => undefined },
  LinearTransition: 'LinearTransition',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('expo-router', () => ({
  useNavigation: () => ({ isFocused: () => true }),
  useFocusEffect: () => undefined,
  useScrollToTop: () => undefined,
}));
vi.mock('@/components/ui/icons', () => ({
  Search: 'Search',
  X: 'X',
  Check: 'Check',
  Bot: 'Bot',
}));
vi.mock('@/components/ui/button', () => ({
  Button: (props: Record<string, unknown>): ReactNode => createElement('Pressable', props),
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
vi.mock('@/components/ui/refresh-progress', () => ({ RefreshProgress: 'RefreshProgress' }));
vi.mock('@/components/ui/text', async () => {
  const { createContext } = await import('react');
  return { Text: 'Text', TextClassContext: createContext('') };
});
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    mutedForeground: '#777777',
    primaryForeground: '#ffffff',
    foreground: '#000000',
  }),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'u1', isLoading: false }),
}));
vi.mock('@/lib/persist/use-draft-load', () => ({
  useFencedDraftLoad: () => ({ value: null, settled: true }),
}));
vi.mock('@/lib/persist/drafts', () => ({
  SESSION_SEARCH_DRAFT_KEY: 'session-search-query',
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: null, isLoaded: true }),
}));
vi.mock('@/lib/hooks/use-session-mutations', () => ({
  useSessionMutations: () => ({ deleteSession: vi.fn(), renameSession: vi.fn() }),
}));
vi.mock('@/lib/a11y/announce', () => ({ moveA11yFocus: vi.fn() }));
vi.mock('@/lib/a11y/status-announcement', () => ({
  useStatusAnnouncement: vi.fn(),
}));
vi.mock('@/lib/tab-bar-layout', () => ({ getEffectiveTabBarHeight: () => 60 }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/agents/session-list-header-actions', () => ({
  SessionListHeaderActions: 'SessionListHeaderActions',
}));
vi.mock('@/components/agents/session-list-section-header', () => ({
  SessionListSectionHeader: 'SessionListSectionHeader',
}));
vi.mock('@/components/agents/session-row', () => ({ StoredSessionRow: 'StoredSessionRow' }));
vi.mock('@/components/agents/session-list-body-empty', () => ({ BodyEmpty: 'BodyEmpty' }));
vi.mock('@/components/agents/platform-filter-modal', () => ({
  SessionFilterModal: 'SessionFilterModal',
}));
vi.mock('@/components/agents/use-agent-session-navigator', () => ({
  useAgentSessionNavigator: () => () => undefined,
}));
vi.mock('@/components/agents/use-session-search-input', () => ({
  useSessionSearchInput: () => ({
    searchQuery: '',
    searchInputRef: { current: null },
    hasText: false,
    awaitingCommit: false,
    searchInputKey: 'session-search-empty',
    searchDefaultValue: undefined,
    handleSearchInputChange: vi.fn(),
    handleClearSearchInput: vi.fn(),
    clearSearchInput: vi.fn(),
    searchController: { clearSearchOnly: vi.fn() },
  }),
}));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn().mockResolvedValue(null) }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/hooks/use-agent-sessions', () => ({
  useAgentSessions: () => {
    const storedSessions = listState.storedSessions;
    return {
      storedSessions,
      activeSessionIds: new Set<string>(),
      dateGroups: storedSessions.length > 0 ? [{ label: 'Today', sessions: storedSessions }] : [],
      activeIsError: false,
      storedIsError: listState.isError,
      storedIsFetching: listState.storedIsFetching,
      storedLoadedPageCount: 1,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: refetchControl.refetch,
    };
  },
  useAgentSessionSearch: () => ({
    dateGroups: [],
    isError: false,
    isFetching: false,
    isPending: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    isPlaceholderData: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  }),
  useRecentAgentRepositories: () => ({ data: { repositories: [] } }),
}));

let mountedRenderer: ReactTestRenderer | undefined = undefined;

function root() {
  if (!mountedRenderer) {
    throw new Error('Missing live history list');
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

function refreshControl() {
  const list = nodes('SectionList')[0]?.props.refreshControl as
    | { props: { refreshing: boolean; onRefresh: () => void } }
    | undefined;
  if (!list) {
    throw new Error('Missing refresh control');
  }
  return list.props;
}

async function renderScreen() {
  const { renderer } = await renderWithProviders(createElement(SessionHistoryScreen), {
    queryClient: createTestQueryClient(),
  });
  mountedRenderer = renderer;
  return renderer;
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  listState.storedSessions = [
    {
      session_id: 'ses_greeting',
      organization_id: null,
      created_on_platform: 'cloud-agent',
    },
  ];
  listState.isError = false;
  listState.storedIsFetching = false;
});

afterEach(() => {
  act(() => mountedRenderer?.unmount());
  mountedRenderer = undefined;
});

describe('SessionHistoryScreen pull-to-refresh with the API down', () => {
  it('keeps rows, announces Updating in flight, then shows the inline failure with Retry', async () => {
    await renderScreen();
    expect(nodes('SectionList')).toHaveLength(1);
    expect(nodes('StoredSessionRow')).toHaveLength(1);
    expect(text()).not.toContain("Couldn't refresh");

    // Pull to refresh: the API just went down, and the refetch hangs in flight.
    refetchControl.armHang();
    act(() => {
      refreshControl().onRefresh();
    });
    expect(refreshControl().refreshing).toBe(true);

    // The in-flight pull announces Updating without drawing the copy.
    await vi.waitFor(
      () => {
        expect(text()).toContain('Updating');
      },
      { timeout: 2000, interval: 10 }
    );
    expect(
      nodes('Text').find(node => node.children.includes('Updating'))?.props.className
    ).toContain('absolute');

    // The refetch settles into the query error state with the rows kept.
    // The error flag lands through the screen's data hook (in production the
    // query error re-renders the screen; here the hook mock reads the flag
    // on the forced root update).
    act(() => {
      listState.isError = true;
      refetchControl.settle?.();
      mountedRenderer?.update(createElement(SessionHistoryScreen));
    });
    await vi.waitFor(
      () => {
        expect(text()).toContain("Couldn't refresh");
      },
      { timeout: 2000, interval: 10 }
    );

    // The inline retryable failure with a working Retry action, next to the kept rows.
    expect(text()).toContain("Couldn't refresh");
    const retry = nodes('Pressable').find(node => node.props.accessibilityLabel === 'Retry');
    expect(retry).toBeDefined();
    expect(retry?.props.onPress).toBeTypeOf('function');
    expect(nodes('StoredSessionRow')).toHaveLength(1);
    expect(refreshControl().refreshing).toBe(false);
    expect(text()).not.toContain('Updating');
  });

  it('retires the pull failure when a later app-foreground refresh settles', async () => {
    await renderScreen();
    expect(nodes('SectionList')).toHaveLength(1);
    expect(nodes('StoredSessionRow')).toHaveLength(1);
    expect(text()).not.toContain("Couldn't refresh");

    vi.useFakeTimers();
    try {
      // The pull hangs past the feedback budget: the failure line takes over
      // while the hung pull never settles on its own.
      refetchControl.armHang();
      act(() => {
        refreshControl().onRefresh();
      });
      expect(refreshControl().refreshing).toBe(true);
      act(() => {
        vi.advanceTimersByTime(PULL_FEEDBACK_BUDGET_MS);
      });
      expect(text()).toContain("Couldn't refresh");
      expect(refreshControl().refreshing).toBe(false);
      const retry = nodes('Pressable').find(node => node.props.accessibilityLabel === 'Retry');
      expect(retry).toBeDefined();

      // A refresh outside the pull lifecycle (app foreground) settles
      // afterwards: the stale failure line must retire instead of claiming
      // "Couldn't refresh" with Retry on an up-to-date list.
      await act(async () => {
        appState.listener?.('active');
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    } finally {
      vi.useRealTimers();
    }
    expect(text()).not.toContain("Couldn't refresh");
    expect(
      nodes('Pressable').find(node => node.props.accessibilityLabel === 'Retry')
    ).toBeUndefined();
    expect(refreshControl().refreshing).toBe(false);
  });
});
