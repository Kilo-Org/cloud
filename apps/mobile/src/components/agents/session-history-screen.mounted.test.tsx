/* eslint-disable max-lines, typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest; max-lines holds the focus and foreground refetch tests beside the existing render-branch assertions in one mount test. */
import { createElement, type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { type StoredSession, type useAgentSessions } from '@/lib/hooks/use-agent-sessions';
import type * as PlatformFilterModule from './platform-filter-modal';
import { SessionHistoryScreen } from './session-history-screen';

type MockStoredSession = Pick<StoredSession, 'session_id' | 'organization_id'> &
  Partial<Pick<StoredSession, 'git_url' | 'created_on_platform'>>;

const listState = vi.hoisted(() => ({
  storedSessions: [] as MockStoredSession[],
  isSearching: false,
  isError: false,
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
// Keep query construction and persisted filters real. Only the server response
// is modeled here, so dropped query dimensions change the resulting rows.
vi.mock('@/lib/hooks/use-agent-sessions', () => ({
  useAgentSessions: ({
    gitUrl,
    createdOnPlatform,
  }: Parameters<typeof useAgentSessions>[0] = {}) => {
    const storedSessions = listState.storedSessions.filter(
      session =>
        (!gitUrl || gitUrl.includes(session.git_url ?? '')) &&
        (!createdOnPlatform || createdOnPlatform.includes(session.created_on_platform ?? ''))
    );
    return {
      storedSessions,
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
  useAgentSessionSearch: () => ({
    dateGroups: [],
    isError: listState.isError,
    isFetching: false,
    isPending: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    isPlaceholderData: false,
    fetchNextPage: vi.fn(),
    refetch: handleRefetchSpy,
  }),
  useRecentAgentRepositories: () => ({
    data: {
      repositories: listState.storedSessions.flatMap(session =>
        session.git_url ? [{ gitUrl: session.git_url }] : []
      ),
    },
  }),
}));
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

async function renderScreen(): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(SessionHistoryScreen));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mountedRenderers.push(renderer);
  return renderer;
}

describe('SessionHistoryScreen', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    listState.storedSessions = [];
    listState.isSearching = false;
    listState.isError = false;
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

  it('keeps real pills, counts, query results, and search placement in sync through removal', async () => {
    listState.storedSessions = sessions;
    const renderer = await renderScreen();
    expect(findNodesByType(renderer, 'ScrollView')).toHaveLength(0);
    applyFilters(renderer, [workflow, code], ['cloud-agent']);
    expect(storedSessionIds(renderer)).toEqual(['workflow', 'code-cloud']);
    expect(historyHeaderActions(renderer).activeFilterCount).toBe(3);
    const strip = findNodeByType(renderer, 'ScrollView');
    expect((strip.props.className as string | undefined)?.split(' ')).toEqual(
      expect.arrayContaining(['grow-0', 'shrink-0'])
    );
    const selectedTree = renderer.toJSON() as TestRenderer.ReactTestRendererJSON;
    expect(
      selectedTree.children
        ?.slice(0, 3)
        .map(child => (typeof child === 'string' ? child : child.type))
    ).toEqual(['ScreenHeader', 'ScrollView', 'SessionListSearchHeader']);

    for (const step of [
      {
        label: i18n.t('agentChat.sessionFilter.removeProjectFilter', {
          label: 'iscekic/kilo-workflow',
        }),
        count: 2,
        ids: ['code-cloud'],
      },
      {
        label: i18n.t('agentChat.sessionFilter.removePlatformFilter', {
          label: i18n.t('agentChat.sessionFilter.platformCloud'),
        }),
        count: 1,
        ids: ['code-cloud', 'code-cli'],
      },
      {
        label: i18n.t('agentChat.sessionFilter.removeProjectFilter', {
          label: 'Kilo-Org/kilocode',
        }),
        count: 0,
        ids: ['workflow', 'code-cloud', 'code-cli', 'other'],
      },
    ]) {
      act(() => {
        const pill = renderer.root.findByProps({ accessibilityLabel: step.label });
        (pill.props.onPress as () => void)();
      });
      expect(historyHeaderActions(renderer).activeFilterCount).toBe(step.count);
      expect(storedSessionIds(renderer)).toEqual(step.ids);
    }
    expect(findNodesByType(renderer, 'ScrollView')).toHaveLength(0);
    const clearedTree = renderer.toJSON() as TestRenderer.ReactTestRendererJSON;
    expect(
      clearedTree.children
        ?.slice(0, 3)
        .map(child => (typeof child === 'string' ? child : child.type))
    ).toEqual(['ScreenHeader', 'SessionListSearchHeader', 'View']);
  });

  it('keeps saved repository and platform selections after a successful history retry', async () => {
    readFilterRecord.mockImplementation(async storageKey => {
      await Promise.resolve();
      return storageKey === 'agent-session-filters'
        ? JSON.stringify({ projectFilter: [code], platformFilter: ['cloud-agent'] })
        : null;
    });
    listState.isError = true;
    const renderer = await renderScreen();
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
      renderer.update(createElement(SessionHistoryScreen));
    });
    expect(findNodeByType(renderer, 'AgentSessionListContent').props.isError).toBe(false);
    expect(storedSessionIds(renderer)).toEqual(['code-cloud']);
    expect(historyHeaderActions(renderer).activeFilterCount).toBe(2);
    expect(
      findNodeByType(renderer, 'ScrollView').findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'Pressable'
      )
    ).toHaveLength(2);
  });

  it('clears no-result filters without a strip gap and keeps platform-only filtering usable', async () => {
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
    act(() => {
      const pill = renderer.root.findByProps({
        accessibilityLabel: i18n.t('agentChat.sessionFilter.removePlatformFilter', {
          label: i18n.t('agentChat.sessionFilter.platformCloud'),
        }),
      });
      (pill.props.onPress as () => void)();
    });
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
    const renderer = await renderScreen();
    const content = findNodeByType(renderer, 'AgentSessionListContent');
    expect(content.props.isSearching).toBe(true);
    expect(storedSessionIds(renderer)).toEqual([]);
    act(() => {
      (content.props.onClearQuery as () => void)();
      renderer.update(createElement(SessionHistoryScreen));
    });
    expect(findNodeByType(renderer, 'AgentSessionListContent').props.isSearching).toBe(false);
    expect(storedSessionIds(renderer)).toEqual(['code-cloud']);
    expect(historyHeaderActions(renderer).activeFilterCount).toBe(2);
    expect(findNodesByType(renderer, 'ScrollView')).toHaveLength(1);
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
