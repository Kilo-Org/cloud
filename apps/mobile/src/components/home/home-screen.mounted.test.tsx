/* eslint-disable max-lines, typescript-eslint/no-deprecated -- The mounted Home matrix covers live provenance, admission, and independent recovery actions. */
import { createElement } from 'react';
import * as ReactQuery from '@tanstack/react-query';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { HomeScreen } from '@/components/home/home-screen';
import { type ActiveSession, type useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';
import { type BannerState } from '@/lib/offline-banner-state';

type Org = { organizationId: string; organizationName: string };
const state = vi.hoisted(() => ({
  auth: { token: 'account' as string | undefined, isLoading: false, isSigningOut: false },
  organization: { organizationId: null as string | null, isLoaded: true },
  boundary: {
    orgs: undefined as Org[] | undefined,
    org: undefined as Org | undefined,
    isResolving: false,
    isError: false,
  },
  live: {
    activeSessions: [] as ActiveSession[],
    isLoading: false,
    isError: false,
    hasAcceptedSuccess: false,
    isFetching: false,
    isPaused: false,
    terminalError: null as ReturnType<typeof useLiveAgentSessions>['terminalError'],
  },
  internet: 'online' as BannerState,
  connection: { isConnected: true, reconnectExhausted: false },
  prReviewEnabled: true,
  refetch: vi.fn<() => Promise<boolean>>(),
  boundaryRefetch: vi.fn(),
  socketRetry: vi.fn(),
  announcements: [] as string[],
  destination: '',
  owners: 0,
}));
const queryClient = new ReactQuery.QueryClient();
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof ReactQuery>()),
  useQueryClient: () => queryClient,
  useQuery: () => ({ data: [{ organizationId: 'org-1', organizationName: 'Home organization' }] }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({ organizations: { list: { queryOptions: () => ({}) } } }),
}));
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: vi.fn() }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  View: 'View',
  useWindowDimensions: () => ({ fontScale: 1 }),
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  LinearTransition: {},
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({
    canGoBack: () => false,
    push: (path: string) => {
      state.destination = path;
    },
    replace: (path: string) => {
      state.destination = path;
    },
  }),
}));
vi.mock('@/components/home/greeting', () => ({ buildTimedGreeting: () => 'Good morning' }));
vi.mock('@/components/home/new-task-button', () => ({ NewTaskButton: 'NewTaskButton' }));
vi.mock('@/components/home/section-header', () => ({ SectionHeader: 'SectionHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', async () => {
  const { createContext } = await import('react');
  return { Text: 'Text', TextClassContext: createContext('') };
});
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  ChevronDown: 'ChevronDown',
  GitMerge: 'GitMerge',
  GitPullRequest: 'GitPullRequest',
  Lock: 'Lock',
  SearchX: 'SearchX',
  ServerCrash: 'ServerCrash',
  ShieldCheck: 'ShieldCheck',
  WifiOff: 'WifiOff',
}));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalChevronRight: 'ChevronRight' }));
vi.mock('@/lib/analytics/posthog', () => ({
  FEATURE_FLAG_PR_REVIEW: 'mobile-pr-review',
  useFeatureFlag: (flag: string, fallback: boolean) =>
    flag === 'mobile-pr-review' ? state.prReviewEnabled : fallback,
}));
vi.mock('@/components/agents/remote-session-row', () => ({ RemoteSessionRow: 'RemoteSessionRow' }));
vi.mock('@/components/agents/use-agent-session-navigator', () => ({
  useAgentSessionNavigator: () => vi.fn(),
}));
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
  useOrgBoundary: () => ({ ...state.boundary, refetch: state.boundaryRefetch }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#777777' }),
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
vi.mock('@/lib/hooks/use-agent-sessions', async () => {
  const { useEffect } = await import('react');
  return {
    useLiveAgentSessions: () => {
      useEffect(() => {
        state.owners += 1;
        return () => {
          state.owners -= 1;
        };
      }, []);
      return { ...state.live, refetch: state.refetch };
    },
    useAgentSessions: () => {
      throw new Error('Home must not request delayed or failed stored history');
    },
  };
});
const row: ActiveSession = {
  id: 'live-1',
  status: 'running',
  title: 'Live task',
  connectionId: 'connection-1',
};
const failure = { kind: 'retryable', error: new Error('temporary') } as const;
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
function nodes(type: string) {
  if (!renderer) {
    throw new Error('Missing Home');
  }
  return renderer.root.findAll(node => typeof node.type === 'string' && node.type === type);
}
function text() {
  return nodes('Text')
    .map(node => node.children.filter(child => typeof child === 'string').join(''))
    .join('\n');
}
function action(label: string) {
  const button = nodes('Pressable').find(
    node =>
      node.props.accessibilityLabel === label ||
      (node.props.accessibilityLabel == null &&
        node.findAll(child => Object.is(child.type, 'Text') && child.children.includes(label))
          .length > 0)
  );
  if (!button) {
    throw new Error(`Missing action: ${label}`);
  }
  return button;
}
function press(label: string) {
  (action(label).props.onPress as () => void)();
}
async function renderHome() {
  await act(async () => {
    const tree = createElement(HomeScreen);
    if (renderer) {
      renderer.update(tree);
    } else {
      renderer = TestRenderer.create(tree);
    }
    await Promise.resolve();
  });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(state.auth, { token: 'account', isLoading: false, isSigningOut: false });
  Object.assign(state.organization, { organizationId: null, isLoaded: true });
  Object.assign(state.boundary, {
    orgs: undefined,
    org: undefined,
    isResolving: false,
    isError: false,
  });
  Object.assign(state.live, {
    activeSessions: [],
    isLoading: false,
    isError: false,
    hasAcceptedSuccess: false,
    isFetching: false,
    isPaused: false,
    terminalError: null,
  });
  Object.assign(state.connection, { isConnected: true, reconnectExhausted: false });
  state.internet = 'online';
  state.prReviewEnabled = true;
  state.destination = '';
  state.announcements = [];
  state.refetch.mockReset().mockResolvedValue(true);
  state.boundaryRefetch.mockReset();
  state.socketRetry.mockReset();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  queryClient.clear();
});

describe('HomeScreen composition', () => {
  it.each([
    { name: 'account pending', patch: { isLoading: true } },
    { name: 'signed out', patch: { token: undefined } },
    { name: 'signing out', patch: { isSigningOut: true } },
  ])('hides the cached header context while $name', async ({ patch }) => {
    state.organization.organizationId = 'org-1';
    state.boundary.orgs = [{ organizationId: 'org-1', organizationName: 'Home organization' }];
    state.boundary.org = state.boundary.orgs[0];
    await renderHome();
    expect(action('Home organization').props.accessibilityHint).toBe('Select account');
    Object.assign(state.auth, patch);
    await renderHome();
    expect(text()).not.toContain('Home organization');
    expect(
      nodes('Pressable').filter(node => node.props.accessibilityHint === 'Select account')
    ).toHaveLength(0);
    expect(nodes('RemoteSessionRow')).toHaveLength(0);
  });

  it.each([false, true])('keeps an accessible context control with readiness=%s', async loaded => {
    state.organization.organizationId = 'org-1';
    state.organization.isLoaded = loaded;
    state.boundary.orgs = [{ organizationId: 'org-1', organizationName: 'Home organization' }];
    state.boundary.org = state.boundary.orgs[0];
    state.live.hasAcceptedSuccess = true;
    await renderHome();
    const controls = nodes('Pressable').filter(
      node => node.props.accessibilityHint === 'Select account'
    );
    expect(controls).toHaveLength(1);
    const control = controls[0];
    expect(control?.props.accessibilityRole).toBe('button');
    expect(control?.props.accessibilityState).toEqual({ busy: !loaded, disabled: !loaded });
    expect(control?.props.accessibilityLabel).toBe(loaded ? 'Home organization' : 'Select account');
    expect(text()).not.toContain('Personal');
  });

  it.each([false, true])(
    'keeps the context control during a live error with retained rows=%s',
    async retained => {
      state.organization.organizationId = 'org-1';
      state.boundary.orgs = [{ organizationId: 'org-1', organizationName: 'Home organization' }];
      state.boundary.org = state.boundary.orgs[0];
      state.live.activeSessions = retained ? [row] : [];
      state.live.isError = true;
      state.live.terminalError = failure;
      await renderHome();
      expect(text()).toContain('Home organization');
      expect(action('Home organization').props.accessibilityHint).toBe('Select account');
      expect(action('Home organization').props.accessibilityState).toEqual({
        busy: false,
        disabled: false,
      });
      expect(text()).not.toContain('Personal');
      expect(text()).toContain("Couldn't load active sessions");
      expect(typeof action('Retry').props.onPress).toBe('function');
      expect(nodes('RemoteSessionRow')).toHaveLength(retained ? 1 : 0);
      expect(nodes('NewTaskButton')).toHaveLength(1);
      for (const label of ['Code Reviewer', 'Security Agent', 'PR Review']) {
        expect(typeof action(label).props.onPress).toBe('function');
      }
    }
  );
});

describe('Home live presentation', () => {
  it.each<{
    name: string;
    patch: Partial<typeof state.live>;
    skeleton?: boolean;
    empty?: boolean;
    rows?: boolean;
    error?: boolean;
    updating?: boolean;
  }>([
    { name: 'pending', patch: { isLoading: true, isFetching: true }, skeleton: true },
    { name: 'paused', patch: { isPaused: true }, skeleton: true },
    { name: 'socket-only empty', patch: {}, skeleton: true },
    { name: 'canceled without provenance', patch: {}, skeleton: true },
    { name: 'accepted empty', patch: { hasAcceptedSuccess: true }, empty: true },
    { name: 'initial failure', patch: { terminalError: failure, isError: true }, error: true },
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
  ])('keeps valid actions and truthful content during $name', async test => {
    Object.assign(state.live, test.patch);
    await renderHome();
    expect(nodes('Skeleton')).toHaveLength(test.skeleton ? 1 : 0);
    if (test.skeleton) {
      expect(nodes('Skeleton')[0]?.props.className).toContain('min-h-[72px]');
    }
    expect(text().includes('Nothing running right now')).toBe(Boolean(test.empty));
    expect(text().includes("Couldn't load active sessions")).toBe(Boolean(test.error));
    expect(text().includes('Updating')).toBe(Boolean(test.updating));
    expect(text().includes('Loading…')).toBe(Boolean(test.skeleton));
    expect(nodes('RemoteSessionRow')).toHaveLength(test.rows ? 1 : 0);
    expect(nodes('NewTaskButton')).toHaveLength(1);
    expect(text()).toContain('Code Reviewer');
    expect(text()).toContain('Security Agent');
    expect(text()).toContain('PR Review');
    expect(state.owners).toBe(1);
    expect(text()).toContain('Personal');
  });

  it.each(['offline', 'unknown', 'reconnecting', 'exhausted'] as const)(
    'retains row identity and running status while %s',
    async mode => {
      state.live.activeSessions = [row];
      await renderHome();
      const original = nodes('RemoteSessionRow')[0];
      state.connection.isConnected = false;
      state.connection.reconnectExhausted = mode === 'exhausted';
      state.internet = mode === 'offline' || mode === 'unknown' ? mode : 'online';
      await renderHome();
      expect(nodes('RemoteSessionRow')[0]).toBe(original);
      expect(nodes('RemoteSessionRow')[0]?.props.session).toBe(row);
      expect(nodes('RemoteSessionRow')[0]?.props.session).toMatchObject({ status: 'running' });
      expect(text().includes('No internet connection')).toBe(mode === 'offline');
      expect(text().includes('Connection lost')).toBe(mode === 'exhausted');
      expect(text().includes('Reconnecting…')).toBe(mode === 'reconnecting' || mode === 'unknown');
      expect(text()).not.toContain('Internet connection restored');
    }
  );

  it('shows Connecting on a cold socket and keeps it beside accepted empty content', async () => {
    state.connection.isConnected = false;
    state.live.hasAcceptedSuccess = true;
    await renderHome();
    expect(text()).toContain('Connecting…');
    expect(text()).toContain('Nothing running right now');
  });

  it('does not invent internet or retry activity for an unknown paused connection', async () => {
    state.internet = 'unknown';
    state.connection.isConnected = false;
    state.live.isPaused = true;
    await renderHome();
    expect(nodes('Skeleton')).toHaveLength(1);
    expect(text()).not.toContain('Nothing running right now');
    expect(text()).not.toContain('Connecting…');
    expect(text()).not.toContain('No internet connection');
    expect(text()).not.toContain('Updating');
  });

  it.each([
    ['FORBIDDEN', 'Access denied'],
    ['UNAUTHORIZED', 'Access denied'],
    ['NOT_FOUND', 'Not found'],
    ['BAD_REQUEST', "Couldn't load sessions"],
    ['UNPROCESSABLE_CONTENT', "Couldn't load sessions"],
  ])('suppresses denied rows and query Retry for %s', async (code, title) => {
    state.live.activeSessions = [row];
    state.live.hasAcceptedSuccess = true;
    state.live.terminalError = { kind: 'non-retryable', error: { data: { code } } };
    await renderHome();
    expect(nodes('RemoteSessionRow')).toHaveLength(0);
    expect(text()).toContain(title);
    expect(text()).not.toContain('Nothing running right now');
    expect(nodes('Pressable').some(node => node.props.accessibilityLabel === 'Retry')).toBe(false);
    press('Back to profile');
    expect(state.destination).toBe('/(app)/(tabs)/(3_profile)');
  });

  it('keeps query and socket Retry separate, busy, and recoverable after failed Retry', async () => {
    state.live.activeSessions = [row];
    state.live.terminalError = failure;
    state.connection.isConnected = false;
    state.connection.reconnectExhausted = true;
    const pending = Promise.withResolvers<boolean>();
    state.refetch.mockReturnValue(pending.promise);
    await renderHome();
    const original = nodes('RemoteSessionRow')[0];
    act(() => {
      press('Retry');
      press('Retry');
    });
    expect(action('Retry').props.disabled).toBe(true);
    expect(action('Retry').props.accessibilityState).toMatchObject({ busy: true, disabled: true });
    expect(action('Retry connection').props.disabled).toBe(false);
    expect(state.refetch).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Couldn't load active sessions");
    await act(async () => {
      pending.resolve(false);
      await pending.promise;
    });
    expect(action('Retry').props.disabled).toBe(false);
    expect(text()).toContain("Couldn't load active sessions");
    expect(nodes('RemoteSessionRow')[0]).toBe(original);
    expect(
      state.announcements.filter(message => message === "Couldn't load active sessions")
    ).toHaveLength(1);
    expect(state.announcements.filter(message => message === 'Connection lost')).toHaveLength(1);
    state.socketRetry.mockImplementation(() => {
      state.connection.reconnectExhausted = false;
    });
    act(() => {
      press('Retry connection');
    });
    await renderHome();
    expect(text()).toContain('Connecting…');
    expect(text()).not.toContain('Connection lost');
    expect(state.refetch).toHaveBeenCalledTimes(1);
    state.refetch.mockImplementation(async () => {
      await Promise.resolve();
      state.live.terminalError = null;
      state.live.hasAcceptedSuccess = true;
      return true;
    });
    await act(async () => {
      press('Retry');
      await Promise.resolve();
    });
    await renderHome();
    expect(text()).not.toContain("Couldn't load active sessions");
    expect(nodes('RemoteSessionRow')[0]).toBe(original);
  });

  it('keeps the retained error and Retry mounted as socket rows appear and disappear', async () => {
    state.live.terminalError = failure;
    await renderHome();
    const message = "Couldn't load active sessions";
    const retry = action('Retry');
    const status = nodes('Text').find(node => node.children.includes(message));
    expect(status).toBeDefined();
    expect(nodes('AlertCircle')).toHaveLength(1);

    async function updateSocketRows(activeSessions: ActiveSession[]) {
      state.live.activeSessions = activeSessions;
      await renderHome();
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

  it('waits for the live coordinator without requesting or waiting for stored history', async () => {
    const storedKey = [['cliSessionsV2', 'list']];
    const history = Promise.withResolvers<undefined>();
    queryClient.setQueryData(storedKey, 'history');
    const observer = new ReactQuery.QueryObserver(queryClient, {
      queryKey: storedKey,
      staleTime: Infinity,
      queryFn: async () => {
        await history.promise;
        return 'history';
      },
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      const pending = Promise.withResolvers<boolean>();
      state.refetch.mockReturnValue(pending.promise);
      await renderHome();
      const refresh = () =>
        nodes('ScrollView')[0]?.props.refreshControl as {
          props: { refreshing: boolean; onRefresh: () => void };
        };
      act(() => {
        refresh().props.onRefresh();
      });
      expect(refresh().props.refreshing).toBe(true);
      await act(async () => {
        pending.resolve(true);
        await pending.promise;
      });
      expect(refresh().props.refreshing).toBe(false);
      expect(queryClient.getQueryState(storedKey)?.fetchStatus).toBe('idle');
      expect(nodes('NewTaskButton')).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it('keeps cold-loading feedback stable until an accepted result', async () => {
    state.live.isLoading = true;
    state.live.isFetching = true;
    await renderHome();
    const loading = nodes('Text').find(node => node.children.includes('Loading…'));
    const skeleton = nodes('Skeleton')[0];
    expect(loading).toBeDefined();
    expect(skeleton).toBeDefined();
    expect(text()).not.toContain('Updating');
    expect(text()).not.toContain('Nothing running right now');
    expect(state.announcements).toEqual(['Loading…']);

    await renderHome();
    state.live.isLoading = false;
    state.live.isFetching = false;
    await renderHome();
    expect(nodes('Text').find(node => node.children.includes('Loading…'))).toBe(loading);
    expect(nodes('Skeleton')[0]).toBe(skeleton);
    expect(state.announcements).toEqual(['Loading…']);
    expect(text()).not.toContain('Nothing running right now');

    state.live.hasAcceptedSuccess = true;
    await renderHome();
    expect(text()).not.toContain('Loading…');
    expect(nodes('Skeleton')).toHaveLength(0);
    expect(text()).toContain('Nothing running right now');
    expect(state.announcements).toEqual(['Loading…']);
  });
});

describe('Home admission', () => {
  it.each(['unresolved', 'failed', 'missing'] as const)(
    'keeps PR Review behind its own flag and route while membership is %s',
    async mode => {
      state.organization.organizationId = 'org-1';
      state.boundary.isResolving = mode === 'unresolved';
      state.boundary.isError = mode === 'failed';
      state.boundary.orgs = mode === 'missing' ? [] : undefined;
      await renderHome();
      expect(nodes('NewTaskButton')).toHaveLength(0);
      expect(text()).not.toContain('Code Reviewer');
      expect(text()).not.toContain('Security Agent');
      press('PR Review');
      expect(state.destination).toBe('/(app)/pr-review');

      state.prReviewEnabled = false;
      await renderHome();
      expect(text()).not.toContain('PR Review');
      expect(nodes('SectionHeader').some(node => node.props.label === 'Explore')).toBe(false);
    }
  );
  it.each(['pending', 'failed'] as const)(
    'admits personal actions while membership is %s',
    async mode => {
      state.boundary.isResolving = mode === 'pending';
      state.boundary.isError = mode === 'failed';
      await renderHome();
      expect(nodes('NewTaskButton')).toHaveLength(1);
      expect(text()).toContain('Code Reviewer');
      expect(text()).toContain('Security Agent');
      expect(text()).toContain('PR Review');
      expect(text()).toContain('Personal');
      expect(text()).not.toContain("Couldn't load your organizations");
    }
  );

  it.each([
    'account pending',
    'signed out',
    'signing out',
    'selection pending',
    'membership paused',
    'membership missing',
    'wrong organization',
    'permission denied',
  ] as const)('suppresses protected rows for %s', async mode => {
    state.live.activeSessions = [row];
    state.live.hasAcceptedSuccess = true;
    state.organization.organizationId = 'org-1';
    state.boundary.orgs = [{ organizationId: 'org-1', organizationName: 'Engineering' }];
    state.boundary.org = state.boundary.orgs[0];
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
      state.boundary.org = undefined;
    }
    if (mode === 'wrong organization') {
      state.boundary.org = { organizationId: 'old-org', organizationName: 'Old organization' };
    }
    if (mode === 'permission denied') {
      state.live.terminalError = { kind: 'non-retryable', error: { data: { code: 'FORBIDDEN' } } };
    }
    await renderHome();
    expect(nodes('RemoteSessionRow')).toHaveLength(0);
    expect(text()).not.toContain('Nothing running right now');
    expect(text()).not.toContain('Old organization');
    expect(text().includes('PR Review')).toBe(
      mode !== 'account pending' && mode !== 'signed out' && mode !== 'signing out'
    );
    if (mode !== 'permission denied') {
      expect(nodes('NewTaskButton')).toHaveLength(0);
      expect(text()).not.toContain('Code Reviewer');
      expect(text()).not.toContain('Security Agent');
      expect(text()).not.toContain('Engineering');
    }
    if (mode === 'membership paused') {
      expect(nodes('Skeleton')).toHaveLength(1);
      expect(text()).not.toContain('Organization unavailable');
    }
    if (
      mode === 'membership missing' ||
      mode === 'wrong organization' ||
      mode === 'permission denied'
    ) {
      expect(text()).toContain(
        mode === 'permission denied' ? 'Access denied' : 'Organization unavailable'
      );
      expect(nodes('Pressable').some(node => node.props.accessibilityLabel === 'Retry')).toBe(
        false
      );
      press('Back to profile');
      expect(state.destination).toBe('/(app)/(tabs)/(3_profile)');
    }
  });

  it('recovers membership errors through boundary Retry and shows only the resolved context label', async () => {
    state.organization.organizationId = 'org-1';
    state.boundary.isError = true;
    state.live.hasAcceptedSuccess = true;
    state.boundaryRefetch.mockImplementation(async () => {
      state.boundary.isError = false;
      state.boundary.orgs = [{ organizationId: 'org-1', organizationName: 'Engineering' }];
      state.boundary.org = state.boundary.orgs[0];
      await Promise.resolve();
    });
    await renderHome();
    expect(text()).toContain("Couldn't load your organizations");
    await act(async () => {
      press('Retry');
      await Promise.resolve();
    });
    await renderHome();
    expect(text()).toContain('Engineering');
    expect(text()).not.toContain('Personal');
    expect(text()).toContain('Nothing running right now');
    expect(nodes('NewTaskButton')).toHaveLength(1);
    expect(state.refetch).not.toHaveBeenCalled();
    state.organization.organizationId = 'org-2';
    await renderHome();
    expect(text()).not.toContain('Engineering');
    expect(nodes('NewTaskButton')).toHaveLength(0);
  });
});
