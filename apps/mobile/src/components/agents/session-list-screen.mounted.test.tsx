/* eslint-disable max-lines, typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest; the file holds the four-state live-tab render branches plus the combined-list regression mocks in one mount test. */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PlatformFilterModule from './platform-filter-modal';
import { AgentSessionListScreen } from './session-list-screen';
import { ScreenHeader } from '@/components/screen-header';

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
const focusCallbacks = vi.hoisted(() => ({
  current: new Set<() => void>(),
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
type MockActiveSession = {
  id: string;
  organizationId: string | null;
  title?: string;
  gitUrl?: string | null;
  createdOnPlatform?: string;
};

const sessionListState = vi.hoisted(() => ({
  activeSessions: [] as MockActiveSession[],
  isLoading: false,
  isError: false,
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  AppState: { addEventListener: appState.addEventListener },
  FlatList: 'FlatList',
  Modal: 'Modal',
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  View: 'View',
  useWindowDimensions: () => ({ fontScale: 1 }),
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
  useNavigation: () => ({ isFocused: () => focusState.current }),
  useFocusEffect: (effect: () => void) => {
    focusCallbacks.current.add(effect);
  },
  useRouter: () => ({ push: routerPushSpy, dismissTo: routerDismissToSpy, canGoBack: () => false }),
  useScrollToTop: () => undefined,
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
  useQuery: () => ({
    data: [{ organizationId: 'org-1', organizationName: 'Agents organization' }],
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { label: string }) => (options ? `${key}: ${options.label}` : key),
  }),
}));
vi.mock('@/i18n', () => ({
  i18n: { t: (key: string) => key, language: 'en' },
}));
// The real persisted-filters hook runs; only its native edges are stubbed, so
// the apply/clear transitions below exercise the actual filter state. The
// stored record resolves through `readFilterRecord` so a test can hold it pending.
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

// Combined-list machinery is mocked as inert string nodes so a regression that
// re-renders any of it shows up as a tree node the assertions below reject.
vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'ChevronDown',
  Plus: 'Plus',
  Bot: 'Bot',
  Check: 'Check',
  X: 'X',
  SlidersHorizontal: 'SlidersHorizontal',
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
vi.mock('@/components/agents/platform-filter-modal', async importOriginal => ({
  ...(await importOriginal<typeof PlatformFilterModule>()),
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
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: vi.fn() }),
}));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => ({ token: 'token' }) }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({ organizations: { list: { queryOptions: () => ({}) } } }),
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: toastErrorSpy },
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({
    organizationId: orgState.organizationId,
    isLoaded: orgState.isLoaded,
    error: null,
    retry: vi.fn(),
    setOrganizationId: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    primaryForeground: '#ffffff',
    foreground: '#000000',
    mutedForeground: '#888888',
  }),
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

type HeaderElement = { type: string; props: Record<string, unknown> };

function headerRightOf(renderer: MountedRenderer) {
  const header = renderer.root.findByType(ScreenHeader);
  return header.props.headerRight as HeaderElement;
}

function headerActionsOf(renderer: MountedRenderer): HeaderElement[] {
  const { children } = headerRightOf(renderer).props;
  return (Array.isArray(children) ? children : [children]).filter(Boolean) as HeaderElement[];
}

function headerActionOf(renderer: MountedRenderer, testID: string): HeaderElement | undefined {
  return headerActionsOf(renderer).find(action => action.props.testID === testID);
}

function requireHeaderAction(renderer: MountedRenderer, testID: string): HeaderElement {
  const action = headerActionOf(renderer, testID);
  const isMounted = renderer.root.findAll(node => node.props.testID === testID).length > 0;
  if (!action || !isMounted) {
    throw new Error(`header action ${testID} was not rendered`);
  }
  return action;
}

function findTypeCount(renderer: MountedRenderer, type: string): number {
  return renderer.root.findAll(node => typeof node.type === 'string' && node.type === type).length;
}

function fireFocus(): void {
  for (const effect of focusCallbacks.current) {
    effect();
  }
}

describe('AgentSessionListScreen live tab', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    focusState.current = true;
    focusCallbacks.current = new Set();
    orgState.organizationId = null;
    orgState.isLoaded = true;
    sessionListState.activeSessions = [];
    sessionListState.isLoading = false;
    sessionListState.isError = false;
    readFilterRecord.mockReset();
    readFilterRecord.mockResolvedValue(null);
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
    const seeAll = requireHeaderAction(renderer, 'agents-view-history');

    expect(seeAll.props.accessibilityRole).toBe('button');
    const control = renderer.root.find(
      node =>
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityHint === 'profile.selectAccount'
    );
    expect(control.props.accessibilityRole).toBe('button');
    expect(control.props.accessibilityLabel).toBe('profile.personal');
    expect(control.props.accessibilityState).toEqual({ busy: false, disabled: false });
  });

  it('pushes the history route when See-all is pressed', async () => {
    const renderer = await renderScreen();
    const seeAll = requireHeaderAction(renderer, 'agents-view-history');

    const onPress = seeAll.props.onPress as () => void;
    onPress();
    expect(routerPushSpy).toHaveBeenCalledWith('/(app)/(tabs)/(2_agents)/history');
  });

  it('renders no history list, animated wrappers, or active-now section', async () => {
    sessionListState.activeSessions = [{ id: 'a1', organizationId: null }];
    const renderer = await renderScreen();

    for (const type of [
      'SessionFilterModal',
      'ActiveNowSection',
      'AgentSessionListContent',
      'AnimatedView',
    ]) {
      expect(findTypeCount(renderer, type)).toBe(0);
    }
  });

  it('shows the search header only once there are live rows', async () => {
    const empty = await renderScreen();
    expect(findTypeCount(empty, 'SessionListSearchHeader')).toBe(0);

    sessionListState.activeSessions = [{ id: 'a1', organizationId: null }];
    const withRows = await renderScreen();
    expect(findTypeCount(withRows, 'SessionListSearchHeader')).toBe(1);
  });

  it('holds the skeletons until the persisted filter record resolves', async () => {
    // A never-settling read stands in for a slow SecureStore: the list must not
    // paint unfiltered rows that a stored filter would then remove.
    readFilterRecord.mockReturnValue(new Promise<string | null>(() => undefined));
    sessionListState.activeSessions = [{ id: 'a1', organizationId: null }];

    const renderer = await renderScreen();

    expect(findTypeCount(renderer, 'Skeleton')).toBe(8);
    expect(findTypeCount(renderer, 'FlatList')).toBe(0);
  });

  it('applies a persisted filter without first painting the unfiltered list', async () => {
    readFilterRecord.mockResolvedValue(
      JSON.stringify({ platformFilter: [], projectFilter: ['https://github.com/kilo/cloud.git'] })
    );
    sessionListState.activeSessions = [
      { id: 'a1', organizationId: null, gitUrl: 'https://github.com/kilo/cloud.git' },
      { id: 'a2', organizationId: null, gitUrl: 'https://github.com/kilo/other.git' },
    ];

    const renderer = await renderScreen();

    const list = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'FlatList'
    );
    expect((list.props.data as { id: string }[]).map(session => session.id)).toEqual(['a1']);
    expect(requireHeaderAction(renderer, 'agents-open-filters').props.activeCount).toBe(1);
  });

  it('clears only the search when the no-match CTA says Clear search', async () => {
    readFilterRecord.mockResolvedValue(
      JSON.stringify({ platformFilter: [], projectFilter: ['https://github.com/kilo/cloud.git'] })
    );
    sessionListState.activeSessions = [
      {
        id: 'a1',
        organizationId: null,
        title: 'Ship it',
        gitUrl: 'https://github.com/kilo/cloud.git',
      },
    ];
    const renderer = await renderScreen();

    const searchHeader = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'SessionListSearchHeader'
    );
    act(() => {
      (searchHeader.props.onChangeText as (text: string) => void)('nothing matches this');
    });

    const emptyState = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'EmptyState'
    );
    expect(emptyState.props.description).toBe('agents.sessionList.tryDifferentSearch');
    act(() => {
      (emptyState.props.action as { props: { onPress: () => void } }).props.onPress();
    });

    // The row is back, and the persisted repository filter survived.
    expect(findTypeCount(renderer, 'FlatList')).toBe(1);
    expect(requireHeaderAction(renderer, 'agents-open-filters').props.activeCount).toBe(1);
  });

  it('narrows the live list to the search text', async () => {
    sessionListState.activeSessions = [
      { id: 'a1', organizationId: null, title: 'Fix the login redirect' },
      { id: 'a2', organizationId: null, title: 'Bump deps' },
    ];
    const renderer = await renderScreen();

    const searchHeader = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'SessionListSearchHeader'
    );
    act(() => {
      (searchHeader.props.onChangeText as (text: string) => void)('bump');
    });

    const list = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'FlatList'
    );
    expect((list.props.data as { id: string }[]).map(session => session.id)).toEqual(['a2']);
  });

  it('keeps the header right to See-all alone while nothing is filterable', async () => {
    const renderer = await renderScreen();

    expect(headerActionsOf(renderer)).toHaveLength(1);
    expect(headerActionOf(renderer, 'agents-open-filters')).toBeUndefined();
  });

  it('offers the filter button once a live row carries a repository', async () => {
    sessionListState.activeSessions = [
      { id: 'a1', organizationId: null, gitUrl: 'https://github.com/kilo/cloud.git' },
    ];
    const renderer = await renderScreen();

    const filterButton = requireHeaderAction(renderer, 'agents-open-filters');
    expect(filterButton.props.activeCount).toBe(0);
  });

  it('keeps real pills, counts, results, and search placement in sync through removal', async () => {
    const workflow = 'https://github.com/iscekic/kilo-workflow.git';
    const code = 'https://github.com/Kilo-Org/kilocode.git';
    sessionListState.activeSessions = [
      {
        id: 'workflow',
        organizationId: null,
        gitUrl: workflow,
        createdOnPlatform: 'cloud-agent-web',
      },
      { id: 'code-cloud', organizationId: null, gitUrl: code, createdOnPlatform: 'cloud-agent' },
      { id: 'code-cli', organizationId: null, gitUrl: code, createdOnPlatform: 'cli' },
      {
        id: 'other',
        organizationId: null,
        gitUrl: 'https://github.com/example/other.git',
        createdOnPlatform: 'cloud-agent',
      },
    ];
    const renderer = await renderScreen();
    expect(findTypeCount(renderer, 'ScrollView')).toBe(0);
    act(() => {
      (requireHeaderAction(renderer, 'agents-open-filters').props.onPress as () => void)();
    });
    const modal = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'SessionFilterModal'
    );
    act(() => {
      (modal.props.onApply as (filters: unknown) => void)({
        projectFilter: [workflow, code],
        platformFilter: ['cloud-agent'],
      });
      (modal.props.onClose as () => void)();
    });
    const visibleIds = () => {
      const rows = renderer.root.find(
        node => typeof node.type === 'string' && (node.type as string) === 'FlatList'
      ).props.data as MockActiveSession[];
      return rows.map(row => row.id);
    };
    expect(visibleIds()).toEqual(['workflow', 'code-cloud']);
    expect(requireHeaderAction(renderer, 'agents-open-filters').props.activeCount).toBe(3);
    const strip = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'ScrollView'
    );
    expect((strip.props.className as string | undefined)?.split(' ')).toEqual(
      expect.arrayContaining(['grow-0', 'shrink-0'])
    );
    const header = renderer.root.findByType(ScreenHeader);
    expect(header.parent?.children[0]).toBe(header);
    const selectedTree = renderer.toJSON() as TestRenderer.ReactTestRendererJSON;
    expect(
      selectedTree.children
        ?.slice(0, 3)
        .map(child => (typeof child === 'string' ? child : child.type))
    ).toEqual(['View', 'SessionListSearchHeader', 'ScrollView']);

    for (const step of [
      {
        label: 'agentChat.sessionFilter.removeProjectFilter: iscekic/kilo-workflow',
        count: 2,
        ids: ['code-cloud'],
      },
      {
        label:
          'agentChat.sessionFilter.removePlatformFilter: agentChat.sessionFilter.platformCloud',
        count: 1,
        ids: ['code-cloud', 'code-cli'],
      },
      {
        label: 'agentChat.sessionFilter.removeProjectFilter: Kilo-Org/kilocode',
        count: 0,
        ids: ['workflow', 'code-cloud', 'code-cli', 'other'],
      },
    ]) {
      act(() => {
        const pill = renderer.root.findByProps({ accessibilityLabel: step.label });
        (pill.props.onPress as () => void)();
      });
      expect(requireHeaderAction(renderer, 'agents-open-filters').props.activeCount).toBe(
        step.count
      );
      expect(visibleIds()).toEqual(step.ids);
    }
    expect(findTypeCount(renderer, 'ScrollView')).toBe(0);
    const clearedTree = renderer.toJSON() as TestRenderer.ReactTestRendererJSON;
    expect(
      clearedTree.children
        ?.slice(0, 3)
        .map(child => (typeof child === 'string' ? child : child.type))
    ).toEqual(['View', 'SessionListSearchHeader', 'FlatList']);
  });

  it('keeps saved repository and platform selections after a successful list retry', async () => {
    const gitUrl = 'https://github.com/example/a-long-saved-repository-name.git';
    readFilterRecord.mockImplementation(async storageKey => {
      await Promise.resolve();
      return storageKey === 'live-session-filters'
        ? JSON.stringify({ projectFilter: [gitUrl], platformFilter: ['cloud-agent'] })
        : null;
    });
    sessionListState.isError = true;
    const renderer = await renderScreen();
    const error = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'QueryError'
    );
    expect(error.props.message).toBe('agents.sessionList.couldNotLoadActive');
    expect(requireHeaderAction(renderer, 'agents-open-filters').props.activeCount).toBe(2);
    refetchSpy.mockImplementationOnce(async () => {
      await Promise.resolve();
      sessionListState.isError = false;
      sessionListState.activeSessions = [
        { id: 'matching', organizationId: null, gitUrl, createdOnPlatform: 'cloud-agent-web' },
        { id: 'wrong-platform', organizationId: null, gitUrl, createdOnPlatform: 'cli' },
        {
          id: 'wrong-repository',
          organizationId: null,
          gitUrl: 'https://github.com/example/other.git',
          createdOnPlatform: 'cloud-agent',
        },
      ];
      return true;
    });
    await act(async () => {
      (error.props.onRetry as () => void)();
      await Promise.resolve();
      renderer.update(createElement(AgentSessionListScreen));
    });
    expect(findTypeCount(renderer, 'QueryError')).toBe(0);
    const rows = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'FlatList'
    ).props.data as MockActiveSession[];
    expect(rows.map(row => row.id)).toEqual(['matching']);
    expect(requireHeaderAction(renderer, 'agents-open-filters').props.activeCount).toBe(2);
    expect(
      renderer.root
        .find(node => typeof node.type === 'string' && (node.type as string) === 'ScrollView')
        .findAll(node => typeof node.type === 'string' && (node.type as string) === 'Pressable')
    ).toHaveLength(2);
  });

  it('filters the live list down to the applied repository', async () => {
    sessionListState.activeSessions = [
      { id: 'a1', organizationId: null, gitUrl: 'https://github.com/kilo/cloud.git' },
      { id: 'a2', organizationId: null, gitUrl: 'https://github.com/kilo/other.git' },
    ];
    const renderer = await renderScreen();

    const filterButton = requireHeaderAction(renderer, 'agents-open-filters');
    act(() => {
      (filterButton.props.onPress as () => void)();
    });

    const modal = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'SessionFilterModal'
    );
    expect(modal.props.projectOptions).toHaveLength(2);
    act(() => {
      (modal.props.onApply as (filters: unknown) => void)({
        platformFilter: [],
        projectFilter: ['https://github.com/kilo/cloud.git'],
        sortBy: 'updated_at',
      });
    });

    const list = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'FlatList'
    );
    expect((list.props.data as { id: string }[]).map(session => session.id)).toEqual(['a1']);
  });

  it('shows a clearable no-match state when every live row is filtered out', async () => {
    sessionListState.activeSessions = [
      { id: 'a1', organizationId: null, gitUrl: 'https://github.com/kilo/cloud.git' },
    ];
    const renderer = await renderScreen();

    act(() => {
      (requireHeaderAction(renderer, 'agents-open-filters').props.onPress as () => void)();
    });
    const modal = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'SessionFilterModal'
    );
    act(() => {
      (modal.props.onApply as (filters: unknown) => void)({
        platformFilter: ['slack'],
        projectFilter: [],
        sortBy: 'updated_at',
      });
    });

    const emptyState = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'EmptyState'
    );
    expect(emptyState.props.title).toBe('agents.sessionList.noMatches');
    expect(requireHeaderAction(renderer, 'agents-open-filters').props.activeCount).toBe(1);
    expect(findTypeCount(renderer, 'ScrollView')).toBe(1);

    const clearAction = emptyState.props.action as { props: { onPress: () => void } };
    act(() => {
      clearAction.props.onPress();
    });
    expect(findTypeCount(renderer, 'FlatList')).toBe(1);
    expect(requireHeaderAction(renderer, 'agents-open-filters').props.activeCount).toBe(0);
    expect(findTypeCount(renderer, 'ScrollView')).toBe(0);
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

  it('keeps the context and list unresolved until the organization restores', async () => {
    orgState.isLoaded = false;
    sessionListState.isLoading = false;
    sessionListState.isError = false;
    const renderer = await renderScreen();
    expect(findTypeCount(renderer, 'EmptyState')).toBe(0);
    expect(findTypeCount(renderer, 'Skeleton')).toBe(9);
    const control = () =>
      renderer.root.find(
        node =>
          (node.type as string) === 'Pressable' &&
          node.props.accessibilityHint === 'profile.selectAccount'
      );
    expect(control().props.accessibilityState).toEqual({ busy: true, disabled: true });
    expect(
      renderer.root.findAll(node => (node.type as string) === 'Text').flatMap(node => node.children)
    ).not.toContain('profile.personal');
    orgState.organizationId = 'org-1';
    orgState.isLoaded = true;
    await act(() => {
      renderer.update(createElement(AgentSessionListScreen));
    });
    expect(control().props.accessibilityLabel).toBe('Agents organization');
    expect(control().props.accessibilityState).toEqual({ busy: false, disabled: false });
    expect(requireHeaderAction(renderer, 'agents-view-history').props.accessibilityRole).toBe(
      'button'
    );
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

  it('passes a numeric attention revision as extraData to the live FlatList', async () => {
    sessionListState.activeSessions = [{ id: 'a1', organizationId: null }];

    const renderer = await renderScreen();

    const list = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'FlatList'
    );
    expect(typeof list.props.extraData).toBe('number');
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
      fireFocus();
    });
    expect(refetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refetches and invalidates the active-sessions tray on foreground while focused', async () => {
    await renderScreen();

    act(() => {
      fireFocus();
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
      fireFocus();
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
