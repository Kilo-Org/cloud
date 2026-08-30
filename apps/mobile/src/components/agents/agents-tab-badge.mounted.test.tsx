/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts the React Native tree without a DOM. */
import { createElement, Fragment, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TabsLayout from '@/app/(app)/(tabs)/_layout';
import { buildActiveSessionsTrayInput } from '@/lib/active-sessions-live';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';
import { AgentSessionListScreen } from './session-list-screen';

const organization = vi.hoisted(() => ({ organizationId: null as string | null, isLoaded: true }));
const fetchSessions = vi.hoisted(() => vi.fn<() => Promise<{ sessions: ActiveSession[] }>>());

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    activeSessions: {
      list: {
        queryKey: (input: unknown) => [['activeSessions', 'list'], { input, type: 'query' }],
        queryOptions: (input: unknown, options: object) => ({
          queryKey: [['activeSessions', 'list'], { input, type: 'query' }],
          queryFn: fetchSessions,
          ...options,
        }),
      },
    },
  }),
}));
vi.mock('@/lib/organization-context', () => ({ useOrganization: () => organization }));
vi.mock('@/lib/hooks/use-user-web-connection-state', () => ({
  useUserWebConnectionState: () => false,
}));
vi.mock('@/lib/active-sessions-live-sync', () => ({
  refreshActiveSessionsNow: vi.fn().mockResolvedValue(false),
}));
vi.mock('expo-router', () => ({
  Tabs: Object.assign((props: { children: ReactNode }) => createElement('Tabs', props), {
    Screen: 'TabScreen',
  }),
  usePathname: () => '/',
  useSegments: () => ['(app)', '(tabs)', '(0_home)'],
  useRouter: () => ({ replace: vi.fn() }),
  useNavigation: () => ({ isFocused: () => false }),
  useFocusEffect: () => undefined,
  useScrollToTop: () => undefined,
}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  InteractionManager: { runAfterInteractions: vi.fn() },
  View: 'View',
  FlatList: 'FlatList',
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  useWindowDimensions: () => ({ fontScale: 1 }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('@/components/ui/icons', () => ({
  Bot: 'Bot',
  Plus: 'Plus',
  House: 'House',
  MessageCircle: 'MessageCircle',
  MessageSquare: 'MessageSquare',
  UserRound: 'UserRound',
}));
vi.mock('@/components/ui/blur-bar', () => ({ BlurBar: 'BlurBar' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/agents/remote-session-row', () => ({ RemoteSessionRow: 'RemoteSessionRow' }));
vi.mock('@/components/agents/session-list-content', () => ({ FAB_MARGIN: 0, FAB_SIZE: 0 }));
vi.mock('@/components/agents/use-agent-session-navigator', () => ({
  useAgentSessionNavigator: () => vi.fn(),
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({ announcingToast: { error: vi.fn() } }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#666666' }),
}));
vi.mock('@/lib/analytics/posthog', () => ({
  FEATURE_FLAG_QUICK_CHAT: 'quick-chat',
  useFeatureFlag: () => false,
}));
vi.mock('@/lib/hooks/use-kiloclaw-tab-visible', () => ({ useKiloClawTabVisible: () => false }));

type Mount = Awaited<ReturnType<typeof renderWithProviders>>;
const mounts: Mount[] = [];

function key(organizationId: string | null = null) {
  return [
    ['activeSessions', 'list'],
    { input: buildActiveSessionsTrayInput(organizationId), type: 'query' },
  ];
}

function sessions(count: number, organizationId: string | null = null): ActiveSession[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${organizationId ?? 'personal'}-${index}`,
    connectionId: 'cli',
    title: `Session ${index}`,
    status: 'busy',
    organizationId,
  }));
}

function CountSurfaces() {
  return createElement(
    Fragment,
    null,
    createElement(TabsLayout),
    createElement(AgentSessionListScreen)
  );
}

async function mount(queryClient = createTestQueryClient()) {
  const result = await renderWithProviders(createElement(CountSurfaces), { queryClient });
  mounts.push(result);
  return result;
}

function isHostType(item: ReactTestInstance, type: string) {
  return typeof item.type === 'string' && item.type === type;
}

function node(renderer: Mount['renderer'], type: string) {
  return renderer.root.find(item => isHostType(item, type));
}

function agentsOptions(renderer: Mount['renderer']) {
  return renderer.root.find(
    item => isHostType(item, 'TabScreen') && item.props.name === '(2_agents)'
  ).props.options as { title: string; tabBarBadge?: number; tabBarAccessibilityLabel: string };
}

function expectCounts(renderer: Mount['renderer'], count?: number, label?: string) {
  expect(node(renderer, 'ScreenHeader').props.eyebrow).toBe(label);
  const options = agentsOptions(renderer);
  expect(options.tabBarBadge).toBe(count);
  expect(options.title).toBe('Agents');
  expect(options.tabBarAccessibilityLabel).toContain('Agents');
  expect(options.tabBarAccessibilityLabel).toContain('2 of 3');
  if (label) {
    expect(options.tabBarAccessibilityLabel).toContain(label);
  } else {
    expect(options.tabBarAccessibilityLabel).not.toContain('LIVE');
  }
}

function rerender({ renderer, queryClient }: Mount) {
  act(() => {
    renderer.update(
      createElement(QueryClientProvider, { client: queryClient }, createElement(CountSurfaces))
    );
  });
}

describe('Agents live count surfaces', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    organization.organizationId = null;
    organization.isLoaded = true;
    fetchSessions.mockReset();
    fetchSessions.mockReturnValue(new Promise(() => undefined));
  });

  afterEach(() => {
    for (const result of mounts) {
      result.unmount();
    }
    mounts.length = 0;
  });

  it.each([
    { count: 1, label: '1 LIVE' },
    { count: 3, label: '3 LIVE' },
    { count: 4, label: '4 LIVE' },
    { count: 12, label: '12 LIVE' },
  ])(
    'shares the active cache and updates to $count while Home has focus',
    async ({ count, label }) => {
      const queryClient = createTestQueryClient();
      queryClient.setQueryData(key(), { sessions: [] });
      const { renderer } = await mount(queryClient);
      expectCounts(renderer);
      expect(queryClient.getQueryCache().getAll()).toHaveLength(1);
      expect(queryClient.getQueryCache().find({ queryKey: key() })?.getObserversCount()).toBe(2);

      act(() => {
        queryClient.setQueryData(key(), {
          sessions: [
            ...sessions(count),
            ...sessions(2, 'other-org'),
            { id: 'unenriched', connectionId: 'cli', title: 'Unknown owner', status: 'busy' },
          ],
        });
      });
      await waitFor(() => agentsOptions(renderer).tabBarBadge === count);
      expectCounts(renderer, count, label);

      act(() => {
        queryClient.setQueryData(key(), { sessions: [] });
      });
      await waitFor(() => agentsOptions(renderer).tabBarBadge === undefined);
      expectCounts(renderer);
    }
  );

  it('hides counts while the initial live query loads', async () => {
    const { renderer, queryClient } = await mount();
    expect(queryClient.getQueryState(key())?.fetchStatus).toBe('fetching');
    expectCounts(renderer);
  });

  it('hides cached counts and disables fetching until the organization loads', async () => {
    organization.isLoaded = false;
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(key(), { sessions: sessions(3) }, { updatedAt: 0 });
    const result = await mount(queryClient);
    expectCounts(result.renderer);
    expect(queryClient.getQueryState(key())?.fetchStatus).toBe('idle');

    fetchSessions.mockResolvedValue({ sessions: sessions(4) });
    organization.isLoaded = true;
    rerender(result);
    await waitFor(() => agentsOptions(result.renderer).tabBarBadge === 4);
    expectCounts(result.renderer, 4, '4 LIVE');
  });

  it('hides counts after a fetch failure and restores them through Retry', async () => {
    fetchSessions.mockRejectedValue(new TypeError('Network request failed'));
    const { renderer } = await mount();
    await waitFor(() => renderer.root.findAll(item => isHostType(item, 'QueryError')).length === 1);
    expectCounts(renderer);

    fetchSessions.mockResolvedValue({ sessions: sessions(1) });
    const retry = node(renderer, 'QueryError').props.onRetry as () => void;
    act(retry);
    await waitFor(() => agentsOptions(renderer).tabBarBadge === 1);
    expectCounts(renderer, 1, '1 LIVE');
  });

  it('hides counts but retains cached rows after refetch failure, then recovers through refresh', async () => {
    const queryClient = createTestQueryClient();
    const cachedRows = sessions(3);
    queryClient.setQueryData(key(), { sessions: cachedRows });
    const { renderer } = await mount(queryClient);
    expectCounts(renderer, 3, '3 LIVE');
    fetchSessions.mockRejectedValue(new TypeError('Network request failed'));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: key() });
    });
    await waitFor(() => agentsOptions(renderer).tabBarBadge === undefined);
    expectCounts(renderer);
    expect(node(renderer, 'FlatList').props.data).toEqual(expect.arrayContaining(cachedRows));
    expect(node(renderer, 'FlatList').props.data).toHaveLength(3);
    expect(renderer.root.findAll(item => isHostType(item, 'QueryError'))).toHaveLength(0);

    fetchSessions.mockResolvedValue({ sessions: sessions(4) });
    const refreshControl = node(renderer, 'FlatList').props.refreshControl as {
      props: { onRefresh: () => void };
    };
    act(refreshControl.props.onRefresh);
    await waitFor(() => agentsOptions(renderer).tabBarBadge === 4);
    expectCounts(renderer, 4, '4 LIVE');
  });

  it('never carries the previous organization count through loading or authorization failure', async () => {
    organization.organizationId = 'org-a';
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(key('org-a'), { sessions: sessions(4, 'org-a') });
    const result = await mount(queryClient);
    expectCounts(result.renderer, 4, '4 LIVE');

    const pending = Promise.withResolvers<{ sessions: ActiveSession[] }>();
    fetchSessions.mockReturnValue(pending.promise);
    organization.organizationId = 'org-b';
    rerender(result);
    expectCounts(result.renderer);
    expect(queryClient.getQueryState(key('org-b'))?.fetchStatus).toBe('fetching');
    act(() => {
      pending.reject(Object.assign(new Error('Unauthorized'), { data: { code: 'UNAUTHORIZED' } }));
    });
    await waitFor(
      () => result.renderer.root.findAll(item => isHostType(item, 'QueryError')).length === 1
    );
    expectCounts(result.renderer);

    act(() => {
      queryClient.setQueryData(key('org-a'), { sessions: sessions(12, 'org-a') });
      queryClient.setQueryData(key('org-b'), {
        sessions: [...sessions(1, 'org-b'), ...sessions(4, 'org-a')],
      });
    });
    await waitFor(() => agentsOptions(result.renderer).tabBarBadge === 1);
    expectCounts(result.renderer, 1, '1 LIVE');
    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: key('org-a') })
        ?.getObserversCount()
    ).toBe(0);
    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: key('org-b') })
        ?.getObserversCount()
    ).toBe(2);
  });
});
