/* eslint-disable max-lines, typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest; max-lines holds the focus and foreground refetch tests beside the existing render-branch assertions in one mount test. */
import { createElement, type ReactElement } from 'react';
import { act, type default as TestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { i18n } from '@/i18n';
import {
  type StoredSession,
  type useAgentSessions,
  type useAgentSessionSearch,
  type useRecentAgentRepositories,
} from '@/lib/hooks/use-agent-sessions';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';
import type * as PlatformFilterModule from './platform-filter-modal';
import { SessionHistoryScreen } from './session-history-screen';

type MockStoredSession = Pick<StoredSession, 'session_id' | 'organization_id'> &
  Partial<Pick<StoredSession, 'git_url' | 'created_on_platform'>>;

const listState = vi.hoisted(() => ({
  storedSessions: [] as MockStoredSession[],
  isSearching: false,
  isError: false,
  organization: { organizationId: null as string | null, isLoaded: true },
  storedQuery: vi.fn<(options: Parameters<typeof useAgentSessions>[0]) => void>(),
  searchQuery: vi.fn<(options: Parameters<typeof useAgentSessionSearch>[0]) => void>(),
  repositoryQuery: vi.fn<(options: Parameters<typeof useRecentAgentRepositories>[0]) => void>(),
}));

const appState = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  return {
    listeners,
    addEventListener: (_event: string, listener: (state: string) => void) => {
      listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    },
    emit: (state: string): void => {
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
});

const focusState = vi.hoisted(() => ({ current: true as boolean }));
const focusCallbacks = vi.hoisted(() => ({
  current: new Set<() => void>(),
}));
const handleRefetchSpy = vi.hoisted(() => vi.fn());
const readFilterRecord = vi.hoisted(() => vi.fn<(storageKey: string) => Promise<string | null>>());

vi.mock('react-native', () => ({
  View: 'View',
  Modal: 'Modal',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  AppState: { addEventListener: appState.addEventListener },
}));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check', X: 'X' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ accentSoftForeground: '#1a1a10' }),
}));
vi.mock('expo-router', () => ({
  useNavigation: () => ({ isFocused: () => focusState.current }),
  useFocusEffect: (effect: () => void) => {
    focusCallbacks.current.add(effect);
  },
}));
vi.mock('@/components/agents/session-list-content', () => ({
  AgentSessionListContent: 'AgentSessionListContent',
}));
vi.mock('@/components/agents/session-list-header-actions', () => ({
  SessionListHeaderActions: 'SessionListHeaderActions',
}));
vi.mock('@/components/agents/session-list-search-header', () => ({
  SessionListSearchHeader: 'SessionListSearchHeader',
}));
vi.mock('@/components/agents/platform-filter-modal', async importOriginal => ({
  ...(await importOriginal<typeof PlatformFilterModule>()),
  SessionFilterModal: 'SessionFilterModal',
}));
vi.mock('@/components/agents/active-now-section', () => ({
  ActiveNowSection: 'ActiveNowSection',
}));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: 'ScreenHeader',
}));
vi.mock('@/components/agents/use-session-search-input', () => ({
  useSessionSearchInput: () => ({
    searchQuery: listState.isSearching ? 'no matching sessions' : '',
    searchInputRef: { current: null },
    hasText: listState.isSearching,
    awaitingCommit: false,
    searchInputKey: 'session-search-empty',
    searchDefaultValue: undefined,
    handleSearchInputChange: vi.fn(),
    handleClearSearchInput: vi.fn(),
    clearSearchInput: () => {
      listState.isSearching = false;
    },
    searchController: { clearSearchOnly: vi.fn() },
  }),
}));
vi.mock('@/components/agents/use-agent-session-navigator', () => ({
  useAgentSessionNavigator: () => vi.fn(),
}));
vi.mock('@/lib/hooks/use-agent-sessions', async () => {
  const { useQuery } = await import('@tanstack/react-query');
  return {
    useAgentSessions: (options: Parameters<typeof useAgentSessions>[0] = {}) => {
      listState.storedQuery(options);
      const { gitUrl, createdOnPlatform } = options;
      const active = useQuery({
        queryKey: ['existing-active-sessions'],
        queryFn: () => new Set<string>(),
        initialData: () => new Set<string>(),
      });
      const storedSessions = listState.storedSessions.filter(
        session =>
          (!gitUrl || gitUrl.includes(session.git_url ?? '')) &&
          (!createdOnPlatform || createdOnPlatform.includes(session.created_on_platform ?? ''))
      );
      return {
        storedSessions,
        activeSessionIds: active.data,
        dateGroups: storedSessions.length > 0 ? [{ label: 'Today', sessions: storedSessions }] : [],
        activeIsError: false,
        storedIsError: listState.isError,
        storedIsFetching: false,
        storedLoadedPageCount: 1,
        hasNextPage: false,
        isFetchingNextPage: false,
        fetchNextPage: vi.fn(),
        refetch: handleRefetchSpy,
      };
    },
    useAgentSessionSearch: (options: Parameters<typeof useAgentSessionSearch>[0]) => {
      listState.searchQuery(options);
      return {
        dateGroups: [],
        isError: listState.isError,
        isFetching: false,
        isPending: false,
        hasNextPage: false,
        isFetchingNextPage: false,
        isPlaceholderData: false,
        fetchNextPage: vi.fn(),
        refetch: handleRefetchSpy,
      };
    },
    useRecentAgentRepositories: (options: Parameters<typeof useRecentAgentRepositories>[0]) => {
      listState.repositoryQuery(options);
      return {
        data: {
          repositories: listState.storedSessions.flatMap(session =>
            session.git_url ? [{ gitUrl: session.git_url }] : []
          ),
        },
      };
    },
  };
});
vi.mock('expo-secure-store', () => ({ getItemAsync: readFilterRecord }));
vi.mock('@/lib/auth/account-metadata-write', () => ({
  setAccountMetadata: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
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
  useOrganization: () => listState.organization,
}));

const mountedRenderers: TestRenderer.ReactTestRenderer[] = [];

function findNodesByType(
  renderer: TestRenderer.ReactTestRenderer,
  type: string
): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(node => typeof node.type === 'string' && node.type === type);
}

function findNodeByType(
  renderer: TestRenderer.ReactTestRenderer,
  type: string
): TestRenderer.ReactTestInstance {
  return renderer.root.find(node => typeof node.type === 'string' && node.type === type);
}

function historyHeaderActions(renderer: TestRenderer.ReactTestRenderer) {
  const header = findNodeByType(renderer, 'ScreenHeader');
  return (
    header.props.headerRight as ReactElement<{
      activeFilterCount: number;
      onOpenFilters: () => void;
    }>
  ).props;
}

function applyFilters(
  renderer: TestRenderer.ReactTestRenderer,
  projectFilter: string[],
  platformFilter: string[]
) {
  act(() => {
    historyHeaderActions(renderer).onOpenFilters();
  });
  const modal = findNodeByType(renderer, 'SessionFilterModal');
  act(() => {
    (modal.props.onApply as (filters: unknown) => void)({ projectFilter, platformFilter });
    (modal.props.onClose as () => void)();
  });
  expect(findNodesByType(renderer, 'SessionFilterModal')).toHaveLength(0);
}

function storedSessionIds(renderer: TestRenderer.ReactTestRenderer) {
  const sections = findNodeByType(renderer, 'AgentSessionListContent').props.sections as {
    data: MockStoredSession[];
  }[];
  return sections.flatMap(section => section.data.map(session => session.session_id));
}

function fireFocus(): void {
  for (const effect of focusCallbacks.current) {
    effect();
  }
}

async function renderScreen(
  queryClient: QueryClient = createTestQueryClient()
): Promise<TestRenderer.ReactTestRenderer> {
  const { renderer } = await renderWithProviders(createElement(SessionHistoryScreen), {
    queryClient,
  });
  mountedRenderers.push(renderer);
  return renderer;
}

describe('SessionHistoryScreen', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    listState.storedSessions = [];
    listState.isSearching = false;
    listState.isError = false;
    Object.assign(listState.organization, { organizationId: null, isLoaded: true });
    listState.storedQuery.mockClear();
    listState.searchQuery.mockClear();
    listState.repositoryQuery.mockClear();
    readFilterRecord.mockReset();
    readFilterRecord.mockResolvedValue(null);
    focusState.current = true;
    focusCallbacks.current = new Set();
    handleRefetchSpy.mockClear();
    handleRefetchSpy.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => {
      for (const renderer of mountedRenderers) {
        renderer.unmount();
      }
    });
    mountedRenderers.length = 0;
    appState.listeners.clear();
    vi.restoreAllMocks();
  });

  const workflow = 'https://github.com/iscekic/kilo-workflow.git';
  const code = 'https://github.com/Kilo-Org/kilocode.git';
  const sessions: MockStoredSession[] = [
    {
      session_id: 'workflow',
      organization_id: null,
      git_url: workflow,
      created_on_platform: 'cloud-agent-web',
    },
    {
      session_id: 'code-cloud',
      organization_id: null,
      git_url: code,
      created_on_platform: 'cloud-agent',
    },
    { session_id: 'code-cli', organization_id: null, git_url: code, created_on_platform: 'cli' },
    {
      session_id: 'other',
      organization_id: null,
      git_url: 'https://github.com/example/other.git',
      created_on_platform: 'cloud-agent',
    },
  ];

  it('updates filters and counts through the modal without pills or moving search', async () => {
    listState.storedSessions = sessions;
    const renderer = await renderScreen();
    const searchHeader = findNodeByType(renderer, 'SessionListSearchHeader');
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
      applyFilters(renderer, step.projects, step.platforms);
      expect(historyHeaderActions(renderer).activeFilterCount).toBe(step.count);
      expect(storedSessionIds(renderer)).toEqual(step.ids);
      expect(findNodesByType(renderer, 'ScrollView')).toHaveLength(0);
      expect(findNodeByType(renderer, 'SessionListSearchHeader')).toBe(searchHeader);
      const tree = renderer.toJSON() as TestRenderer.ReactTestRendererJSON;
      expect(
        tree.children?.slice(0, 3).map(child => (typeof child === 'string' ? child : child.type))
      ).toEqual(['ScreenHeader', 'SessionListSearchHeader', 'View']);
    }
  });

  it('keeps saved repository and platform selections after a successful history retry', async () => {
    readFilterRecord.mockImplementation(async storageKey => {
      await Promise.resolve();
      return storageKey === 'agent-session-filters'
        ? JSON.stringify({ projectFilter: [code], platformFilter: ['cloud-agent'] })
        : null;
    });
    listState.isError = true;
    const queryClient = createTestQueryClient();
    const renderer = await renderScreen(queryClient);
    const content = findNodeByType(renderer, 'AgentSessionListContent');
    expect(content.props.isError).toBe(true);
    expect(historyHeaderActions(renderer).activeFilterCount).toBe(2);
    handleRefetchSpy.mockImplementationOnce(async () => {
      await Promise.resolve();
      listState.isError = false;
      listState.storedSessions = sessions;
    });
    await act(async () => {
      (content.props.onRetry as () => void)();
      await Promise.resolve();
      renderer.update(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(SessionHistoryScreen)
        )
      );
    });
    expect(findNodeByType(renderer, 'AgentSessionListContent').props.isError).toBe(false);
    expect(storedSessionIds(renderer)).toEqual(['code-cloud']);
    expect(historyHeaderActions(renderer).activeFilterCount).toBe(2);
    expect(findNodesByType(renderer, 'ScrollView')).toHaveLength(0);
    act(() => {
      historyHeaderActions(renderer).onOpenFilters();
    });
    expect(findNodeByType(renderer, 'SessionFilterModal').props).toMatchObject({
      selectedProjects: [code],
      selectedPlatforms: ['cloud-agent'],
    });
  });

  it('clears no-result filters and resets platform-only filtering through the modal', async () => {
    listState.storedSessions = sessions;
    const renderer = await renderScreen();
    applyFilters(renderer, [workflow], ['slack']);
    const content = findNodeByType(renderer, 'AgentSessionListContent');
    expect(content.props.hasActiveQuery).toBe(true);
    expect(content.props.isSearching).toBe(false);
    expect(storedSessionIds(renderer)).toEqual([]);
    expect(historyHeaderActions(renderer).activeFilterCount).toBe(2);
    act(() => {
      (content.props.onClearQuery as () => void)();
    });
    expect(storedSessionIds(renderer)).toEqual(['workflow', 'code-cloud', 'code-cli', 'other']);
    expect(historyHeaderActions(renderer).activeFilterCount).toBe(0);
    expect(findNodesByType(renderer, 'ScrollView')).toHaveLength(0);

    applyFilters(renderer, [], ['cloud-agent']);
    expect(storedSessionIds(renderer)).toEqual(['workflow', 'code-cloud', 'other']);
    expect(historyHeaderActions(renderer).activeFilterCount).toBe(1);
    applyFilters(renderer, [], []);
    expect(storedSessionIds(renderer)).toEqual(['workflow', 'code-cloud', 'code-cli', 'other']);
    expect(historyHeaderActions(renderer).activeFilterCount).toBe(0);
    expect(findNodesByType(renderer, 'ScrollView')).toHaveLength(0);
  });

  it('clears only the search when no-result recovery says Clear search', async () => {
    readFilterRecord.mockResolvedValue(
      JSON.stringify({ projectFilter: [code], platformFilter: ['cloud-agent'] })
    );
    listState.storedSessions = sessions;
    listState.isSearching = true;
    const queryClient = createTestQueryClient();
    const renderer = await renderScreen(queryClient);
    const content = findNodeByType(renderer, 'AgentSessionListContent');
    expect(content.props.isSearching).toBe(true);
    expect(storedSessionIds(renderer)).toEqual([]);
    act(() => {
      (content.props.onClearQuery as () => void)();
      renderer.update(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(SessionHistoryScreen)
        )
      );
    });
    expect(findNodeByType(renderer, 'AgentSessionListContent').props.isSearching).toBe(false);
    expect(storedSessionIds(renderer)).toEqual(['code-cloud']);
    expect(historyHeaderActions(renderer).activeFilterCount).toBe(2);
    expect(findNodesByType(renderer, 'ScrollView')).toHaveLength(0);
  });

  it.each([false, true])(
    'scopes history queries to the selected organization with readiness=%s',
    async loaded => {
      listState.organization = { organizationId: 'org-1', isLoaded: loaded };
      listState.isSearching = true;
      const renderer = await renderScreen();
      for (const query of [
        listState.storedQuery,
        listState.searchQuery,
        listState.repositoryQuery,
      ]) {
        expect(query).toHaveBeenLastCalledWith(
          expect.objectContaining({ organizationId: 'org-1', enabled: loaded })
        );
      }
      expect(findNodeByType(renderer, 'AgentSessionListContent').props.isLoading).toBe(!loaded);
    }
  );

  it('renders the agents title with a back button and default header size', async () => {
    const renderer = await renderScreen();
    const header = findNodeByType(renderer, 'ScreenHeader');

    expect(header.props.title).toBe(i18n.t('common.agents'));
    expect(header.props.size).toBeUndefined();
    expect(header.props.showBackButton).toBe(true);
  });

  it('hides the new-session header action', async () => {
    const renderer = await renderScreen();
    const header = findNodeByType(renderer, 'ScreenHeader');
    const headerRight = header.props.headerRight as ReactElement<{ showNewSession: boolean }>;

    expect(headerRight.props.showNewSession).toBe(false);
  });

  it('never renders the active tray or the new-session FAB', async () => {
    const renderer = await renderScreen();

    expect(findNodesByType(renderer, 'ActiveNowSection').length).toBe(0);
    expect(
      renderer.root.findAll(node => node.props.testID === 'agents-new-session-fab').length
    ).toBe(0);
  });

  it('keeps the search header unmounted when there are no stored rows and no active query', async () => {
    const renderer = await renderScreen();

    expect(findNodesByType(renderer, 'SessionListSearchHeader').length).toBe(0);
  });

  it('mounts the search header once stored rows exist', async () => {
    listState.storedSessions = [{ session_id: 'stored-1', organization_id: null }];
    const renderer = await renderScreen();

    expect(findNodesByType(renderer, 'SessionListSearchHeader').length).toBe(1);
  });

  it('keeps the search header and an active query while searching with no stored rows', async () => {
    listState.isSearching = true;
    listState.storedSessions = [];

    const renderer = await renderScreen();

    expect(findNodesByType(renderer, 'SessionListSearchHeader').length).toBe(1);
    const content = findNodeByType(renderer, 'AgentSessionListContent');
    expect(content.props.hasActiveQuery).toBe(true);
    expect(content.props.hasAnySessions).toBe(true);
  });

  it('hands the existing live query set through data and screen without another subscription', async () => {
    listState.storedSessions = [{ session_id: 'stored-1', organization_id: null }];
    const queryClient = createTestQueryClient();
    const renderer = await renderScreen(queryClient);
    const content = findNodeByType(renderer, 'AgentSessionListContent');
    const queryKey = ['existing-active-sessions'];
    const activeQuery = queryClient.getQueryCache().find({ queryKey });

    expect(content.props.activeSessionIds).toEqual(new Set());
    expect(activeQuery?.getObserversCount()).toBe(1);
    const liveIds = new Set(['stored-1']);
    act(() => {
      queryClient.setQueryData(queryKey, liveIds);
    });
    await waitFor(() => content.props.activeSessionIds === liveIds);
    expect(findNodeByType(renderer, 'AgentSessionListContent')).toBe(content);
    expect(content.props.activeSessionIds).toBe(liveIds);

    const nextIds = new Set(['stored-2']);
    act(() => {
      queryClient.setQueryData(queryKey, nextIds);
    });
    await waitFor(() => content.props.activeSessionIds === nextIds);
    expect(content.props.activeSessionIds).toBe(nextIds);
    expect(activeQuery?.getObserversCount()).toBe(1);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(1);
  });

  it('refetches stored sessions through the wrapped refetch on route focus', async () => {
    await renderScreen();

    act(() => {
      fireFocus();
    });
    expect(handleRefetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refetches stored sessions on foreground while focused', async () => {
    await renderScreen();

    act(() => {
      fireFocus();
    });
    expect(handleRefetchSpy).toHaveBeenCalledTimes(1);

    act(() => {
      appState.emit('background');
    });
    act(() => {
      appState.emit('active');
    });

    expect(handleRefetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not refetch stored sessions on foreground while unfocused', async () => {
    focusState.current = false;
    await renderScreen();

    act(() => {
      appState.emit('background');
    });
    act(() => {
      appState.emit('active');
    });

    expect(handleRefetchSpy).not.toHaveBeenCalled();
  });
});
