/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as session-list-body-empty.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentSessionListScreen } from './session-list-screen';

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
const focusCallback = vi.hoisted(() => ({
  current: undefined as (() => void) | undefined,
}));
const refetchSpy = vi.hoisted(() => vi.fn());
const invalidateQueries = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  View: 'View',
  useWindowDimensions: () => ({ fontScale: 1 }),
  AppState: { addEventListener: appState.addEventListener },
}));
vi.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'AnimatedView' },
  LinearTransition: 'LinearTransition',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock('expo-router', () => ({
  useNavigation: () => ({ isFocused: () => focusState.current }),
  useFocusEffect: (effect: () => void) => {
    focusCallback.current = effect;
  },
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock('@/components/ui/icons', () => ({
  Plus: 'Plus',
}));
vi.mock('@/components/agents/active-now-section', () => ({
  ActiveNowSection: 'ActiveNowSection',
}));
vi.mock('@/components/agents/session-list-content', () => ({
  AgentSessionListContent: 'AgentSessionListContent',
  FAB_MARGIN: 0,
  FAB_SIZE: 0,
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
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: 'ScreenHeader',
}));
vi.mock('@/components/agents/use-session-search-input', () => ({
  useSessionSearchInput: () => ({
    searchQuery: '',
    searchInputRef: { current: null },
    hasText: false,
    awaitingCommit: false,
    handleSearchInputChange: vi.fn(),
    handleClearSearchInput: vi.fn(),
    clearSearchInput: vi.fn(),
    searchController: { clearBroadly: vi.fn() },
  }),
}));
vi.mock('@/components/agents/use-agent-session-navigator', () => ({
  useAgentSessionNavigator: () => vi.fn(),
}));
vi.mock('@/components/agents/use-agent-session-list-data', () => ({
  useAgentSessionListData: () => ({
    storedSessions: [],
    activeSessions: [],
    activeIsError: false,
    isLoading: false,
    paging: {},
    refetch: refetchSpy,
    handleRetry: vi.fn(),
    handleRefetch: vi.fn(),
    isSearching: false,
    search: { isFetching: false },
    projectOptions: [],
    contentIsError: false,
    pinnedActive: [],
    sections: [],
  }),
}));
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
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: null, isLoaded: true }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primaryForeground: '#ffffff' }),
}));

const mountedRenderers: TestRenderer.ReactTestRenderer[] = [];

async function renderScreen(): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(AgentSessionListScreen));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mountedRenderers.push(renderer);
  return renderer;
}

describe('AgentSessionListScreen foreground refresh', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    focusState.current = true;
    focusCallback.current = undefined;
    refetchSpy.mockClear();
    invalidateQueries.mockClear();
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

  it('refetches and invalidates the active-sessions tray on foreground while focused', async () => {
    await renderScreen();

    // The route-focus refetch fires once on mount focus.
    act(() => {
      focusCallback.current?.();
    });
    expect(refetchSpy).toHaveBeenCalledTimes(1);

    act(() => {
      appState.emit('background');
    });
    act(() => {
      appState.emit('active');
    });

    expect(refetchSpy).toHaveBeenCalledTimes(2);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: [['activeSessions']] });
  });

  it('does not refetch or invalidate on foreground while unfocused', async () => {
    focusState.current = false;
    await renderScreen();

    act(() => {
      appState.emit('background');
    });
    act(() => {
      appState.emit('active');
    });

    expect(refetchSpy).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('does not refetch or invalidate on foreground after focus is lost post-mount', async () => {
    await renderScreen();

    // The route-focus refetch fires once on mount focus.
    act(() => {
      focusCallback.current?.();
    });
    expect(refetchSpy).toHaveBeenCalledTimes(1);

    // Blur the tab after mount WITHOUT re-rendering: a frozen (unfocused) tab
    // does not re-render, so the AppState callback must read focus live.
    focusState.current = false;

    act(() => {
      appState.emit('background');
    });
    act(() => {
      appState.emit('active');
    });

    expect(refetchSpy).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
