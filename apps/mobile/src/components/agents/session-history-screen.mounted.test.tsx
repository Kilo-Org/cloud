/* eslint-disable max-lines, typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest; max-lines holds the focus and foreground refetch tests beside the existing render-branch assertions in one mount test. */
import { createElement, type ReactElement } from 'react';
import { act, type default as TestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type QueryClient } from '@tanstack/react-query';

import { i18n } from '@/i18n';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';
import { SessionHistoryScreen } from './session-history-screen';

const listState = vi.hoisted(() => ({
  storedSessions: [] as { session_id: string; organization_id: string | null }[],
  isSearching: false,
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
  current: [] as (() => void)[],
}));
const handleRefetchSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  View: 'View',
  AppState: { addEventListener: appState.addEventListener },
}));
vi.mock('expo-router', () => ({
  useNavigation: () => ({ isFocused: () => focusState.current }),
  useFocusEffect: (effect: () => void) => {
    focusCallbacks.current.push(effect);
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
vi.mock('@/components/agents/platform-filter-modal', () => ({
  SessionFilterChips: 'SessionFilterChips',
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
    searchQuery: listState.isSearching ? 'title' : '',
    searchInputRef: { current: null },
    hasText: false,
    awaitingCommit: false,
    searchInputKey: 'session-search-empty',
    searchDefaultValue: undefined,
    handleSearchInputChange: vi.fn(),
    handleClearSearchInput: vi.fn(),
    clearSearchInput: vi.fn(),
    searchController: { clearBroadly: vi.fn() },
  }),
}));
vi.mock('@/components/agents/use-agent-session-navigator', () => ({
  useAgentSessionNavigator: () => vi.fn(),
}));
vi.mock('@/lib/hooks/use-agent-sessions', async () => {
  const { useQuery } = await import('@tanstack/react-query');
  return {
    useAgentSessions: () => {
      // This dependency owns the existing live query subscription. Keep the
      // data hook real so the test covers the complete set handoff.
      const active = useQuery({
        queryKey: ['existing-active-sessions'],
        queryFn: () => new Set<string>(),
        initialData: () => new Set<string>(),
      });
      return {
        storedSessions: listState.storedSessions,
        activeSessionIds: active.data,
        dateGroups: [],
        activeIsError: false,
        storedIsError: false,
        storedIsFetching: false,
        storedLoadedPageCount: 1,
        hasNextPage: false,
        isFetchingNextPage: false,
        fetchNextPage: vi.fn(),
        refetch: handleRefetchSpy,
      };
    },
    useAgentSessionSearch: () => ({
      dateGroups: [],
      isFetching: false,
      isPending: false,
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      isPlaceholderData: false,
      fetchNextPage: vi.fn(),
      refetch: vi.fn(),
    }),
    useRecentAgentRepositories: () => ({ data: { repositories: [] } }),
  };
});
vi.mock('@/lib/hooks/use-persisted-agent-session-filters', () => ({
  usePersistedAgentSessionFilters: () => ({
    platformFilter: [],
    projectFilter: [],
    sortBy: 'updated',
    hasLoaded: true,
    setFilters: vi.fn(),
    setPlatformFilter: vi.fn(),
    setProjectFilter: vi.fn(),
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
    focusState.current = true;
    focusCallbacks.current = [];
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

  it('renders the agents title with a back button and default header size', async () => {
    const renderer = await renderScreen();
    const header = findNodeByType(renderer, 'ScreenHeader');

    expect(header.props.title).toBe(i18n.t('tabs.agents'));
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
