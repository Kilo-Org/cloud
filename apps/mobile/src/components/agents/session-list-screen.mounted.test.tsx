/* eslint-disable max-lines, typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest; the file holds the four-state live-tab render branches plus the combined-list regression mocks in one mount test. */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentSessionListScreen } from './session-list-screen';

type MountedRenderer = TestRenderer.ReactTestRenderer;

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
const routerPushSpy = vi.hoisted(() => vi.fn());
const routerDismissToSpy = vi.hoisted(() => vi.fn());
const invalidateQueries = vi.hoisted(() => vi.fn());
const toastErrorSpy = vi.hoisted(() => vi.fn());
const orgState = vi.hoisted(() => ({
  organizationId: null as string | null,
  isLoaded: true,
}));
const sessionListState = vi.hoisted(() => ({
  activeSessions: [] as { id: string; organizationId: string | null }[],
  isLoading: false,
  isError: false,
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { addEventListener: appState.addEventListener },
  FlatList: 'FlatList',
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  View: 'View',
  useWindowDimensions: () => ({ fontScale: 1 }),
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
  useRouter: () => ({ push: routerPushSpy, dismissTo: routerDismissToSpy }),
  useScrollToTop: () => undefined,
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Combined-list machinery is mocked as inert string nodes so a regression that
// re-renders any of it shows up as a tree node the assertions below reject.
vi.mock('@/components/ui/icons', () => ({
  Plus: 'Plus',
  Bot: 'Bot',
}));
vi.mock('@/components/empty-state', () => ({
  EmptyState: 'EmptyState',
}));
vi.mock('@/components/query-error', () => ({
  QueryError: 'QueryError',
}));
vi.mock('@/components/agents/remote-session-row', () => ({
  RemoteSessionRow: 'RemoteSessionRow',
}));
vi.mock('@/components/agents/session-list-content', () => ({
  AgentSessionListContent: 'AgentSessionListContent',
  FAB_MARGIN: 0,
  FAB_SIZE: 0,
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
vi.mock('@/components/agents/session-list-routes', () => ({
  getNewAgentSessionPath: () => '/(app)/agent-chat/new',
}));
vi.mock('@/components/agents/use-agent-session-navigator', () => ({
  useAgentSessionNavigator: () => vi.fn(),
}));
vi.mock('@/components/ui/button', () => ({
  Button: 'Button',
}));
vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: 'Skeleton',
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: 'ScreenHeader',
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: toastErrorSpy },
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({
    organizationId: orgState.organizationId,
    isLoaded: orgState.isLoaded,
  }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primaryForeground: '#ffffff', foreground: '#000000' }),
}));
vi.mock('@/lib/tab-bar-layout', () => ({
  getEffectiveTabBarHeight: () => 0,
}));
vi.mock('@/lib/hooks/use-agent-sessions', () => ({
  useLiveAgentSessions: () => ({
    activeSessions: sessionListState.activeSessions,
    isLoading: sessionListState.isLoading,
    isError: sessionListState.isError,
    refetch: refetchSpy,
  }),
}));

const mountedRenderers: MountedRenderer[] = [];

async function renderScreen(): Promise<MountedRenderer> {
  const rendererRef: { current: MountedRenderer | undefined } = {
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

function headerRightOf(renderer: MountedRenderer) {
  const header = renderer.root.find(
    node => typeof node.type === 'string' && (node.type as string) === 'ScreenHeader'
  );
  return header.props.headerRight as { type: string; props: Record<string, unknown> };
}

function findTypeCount(renderer: MountedRenderer, type: string): number {
  return renderer.root.findAll(node => typeof node.type === 'string' && node.type === type).length;
}

describe('AgentSessionListScreen live tab', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    focusState.current = true;
    focusCallback.current = undefined;
    orgState.organizationId = null;
    orgState.isLoaded = true;
    sessionListState.activeSessions = [];
    sessionListState.isLoading = false;
    sessionListState.isError = false;
    refetchSpy.mockClear();
    refetchSpy.mockResolvedValue(true);
    routerPushSpy.mockClear();
    routerDismissToSpy.mockClear();
    invalidateQueries.mockClear();
    toastErrorSpy.mockClear();
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

  it.each([
    {
      label: 'loading',
      activeSessions: [] as { id: string; organizationId: string | null }[],
      isLoading: true,
      isError: false,
    },
    {
      label: 'empty',
      activeSessions: [] as { id: string; organizationId: string | null }[],
      isLoading: false,
      isError: false,
    },
    {
      label: 'cold error',
      activeSessions: [] as { id: string; organizationId: string | null }[],
      isLoading: false,
      isError: true,
    },
    {
      label: 'happy',
      activeSessions: [{ id: 'a1', organizationId: null }] as {
        id: string;
        organizationId: string | null;
      }[],
      isLoading: false,
      isError: false,
    },
  ])('keeps See-all mounted in the $label state', async state => {
    sessionListState.activeSessions = state.activeSessions;
    sessionListState.isLoading = state.isLoading;
    sessionListState.isError = state.isError;

    const renderer = await renderScreen();
    const headerRight = headerRightOf(renderer);

    expect(headerRight.props.testID).toBe('agents-view-history');
    expect(headerRight.props.accessibilityRole).toBe('button');
  });

  it('pushes the history route when See-all is pressed', async () => {
    const renderer = await renderScreen();
    const headerRight = headerRightOf(renderer);

    const onPress = headerRight.props.onPress as () => void;
    onPress();
    expect(routerPushSpy).toHaveBeenCalledWith('/(app)/(tabs)/(2_agents)/history');
  });

  it('renders no search header, filter chips, animated wrappers, or active-now section', async () => {
    sessionListState.activeSessions = [{ id: 'a1', organizationId: null }];
    const renderer = await renderScreen();

    for (const type of [
      'SessionListSearchHeader',
      'SessionFilterChips',
      'SessionFilterModal',
      'ActiveNowSection',
      'AgentSessionListContent',
      'AnimatedView',
    ]) {
      expect(findTypeCount(renderer, type)).toBe(0);
    }
  });

  it('keeps the header right as a single See-all label with no plus icon', async () => {
    const renderer = await renderScreen();
    const headerRight = headerRightOf(renderer);

    expect(headerRight.type).toBe('Pressable');
    const children = headerRight.props.children as { type: string };
    expect(children.type).toBe('Text');
  });

  it('hides the FAB when there are no live rows', async () => {
    const renderer = await renderScreen();
    expect(
      renderer.root.findAll(node => node.props.testID === 'agents-new-session-fab')
    ).toHaveLength(0);
  });

  it('shows the FAB when live rows exist', async () => {
    sessionListState.activeSessions = [{ id: 'a1', organizationId: null }];
    const renderer = await renderScreen();
    expect(
      renderer.root.findAll(node => node.props.testID === 'agents-new-session-fab')
    ).toHaveLength(1);
  });

  it('treats a not-loaded org as loading so the empty state cannot flash', async () => {
    orgState.isLoaded = false;
    sessionListState.isLoading = false;
    sessionListState.isError = false;

    const renderer = await renderScreen();

    expect(findTypeCount(renderer, 'EmptyState')).toBe(0);
    expect(findTypeCount(renderer, 'Skeleton')).toBe(8);
  });

  it('renders skeletons while the live query is loading with no cached rows', async () => {
    sessionListState.isLoading = true;
    sessionListState.isError = false;
    sessionListState.activeSessions = [];

    const renderer = await renderScreen();

    expect(findTypeCount(renderer, 'Skeleton')).toBe(8);
    expect(findTypeCount(renderer, 'EmptyState')).toBe(0);
    expect(findTypeCount(renderer, 'QueryError')).toBe(0);
  });

  it('renders the empty state when there are no live sessions', async () => {
    const renderer = await renderScreen();
    const emptyState = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'EmptyState'
    );
    expect(emptyState.props.title).toBe('home.noLiveSessions');
    expect(emptyState.props.description).toBe('agents.sessionList.noSessionsYetDescription');
    expect(findTypeCount(renderer, 'EmptyState')).toBe(1);
    expect(findTypeCount(renderer, 'FlatList')).toBe(0);

    const createAction = emptyState.props.action as {
      type: string;
      props: { onPress: () => void };
    };
    expect(createAction.type).toBe('Button');
    createAction.props.onPress();
    expect(routerPushSpy).toHaveBeenCalledWith('/(app)/agent-chat/new');
  });

  it('renders QueryError for a cold error with no cached rows', async () => {
    sessionListState.isError = true;
    const renderer = await renderScreen();

    const queryError = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'QueryError'
    );
    expect(queryError.props.message).toBe('agents.sessionList.couldNotLoadActive');

    const onRetry = queryError.props.onRetry as () => void;
    onRetry();
    expect(refetchSpy).toHaveBeenCalledTimes(1);

    expect(findTypeCount(renderer, 'QueryError')).toBe(1);
    expect(findTypeCount(renderer, 'FlatList')).toBe(0);
    expect(
      renderer.root.findAll(node => node.props.testID === 'agents-new-session-fab')
    ).toHaveLength(0);
  });

  it('keeps cached rows mounted when a refetch fails', async () => {
    sessionListState.activeSessions = [{ id: 'a1', organizationId: null }];
    sessionListState.isError = true;

    const renderer = await renderScreen();

    expect(findTypeCount(renderer, 'QueryError')).toBe(0);
    const list = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'FlatList'
    );
    expect(list.props.data).toHaveLength(1);
  });

  it('announces a refresh failure once on a failed pull with cached rows', async () => {
    sessionListState.activeSessions = [{ id: 'a1', organizationId: null }];
    refetchSpy.mockResolvedValue(false);

    const renderer = await renderScreen();

    const flatList = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'FlatList'
    );
    const refreshControl = flatList.props.refreshControl as {
      props: { onRefresh: () => void };
    };
    act(() => {
      refreshControl.props.onRefresh();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(toastErrorSpy).toHaveBeenCalledTimes(1);
    expect(toastErrorSpy).toHaveBeenCalledWith('common.couldNotRefresh');
  });

  it('does not announce on a successful pull with cached rows', async () => {
    sessionListState.activeSessions = [{ id: 'a1', organizationId: null }];
    refetchSpy.mockResolvedValue(true);

    const renderer = await renderScreen();

    const flatList = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'FlatList'
    );
    const refreshControl = flatList.props.refreshControl as {
      props: { onRefresh: () => void };
    };
    act(() => {
      refreshControl.props.onRefresh();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(toastErrorSpy).not.toHaveBeenCalled();
  });

  it('refetches live sessions on route focus', async () => {
    await renderScreen();

    act(() => {
      focusCallback.current?.();
    });
    expect(refetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refetches and invalidates the active-sessions tray on foreground while focused', async () => {
    await renderScreen();

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
