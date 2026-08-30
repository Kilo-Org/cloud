/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom). */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import SessionDetailScreen from './[session-id]';

const useLocalSearchParamsMock = vi.hoisted(() => vi.fn());
const useRouterMock = vi.hoisted(() => vi.fn());
const useQueryMock = vi.hoisted(() => vi.fn());
const queryOptionsMock = vi.hoisted(() => vi.fn());

const queryState = vi.hoisted(() => ({
  isPending: false,
  isError: false,
  isFetching: false,
  error: null as { data?: { code?: string } } | null,
  data: null as { organization_id?: string | null } | null,
  refetch: vi.fn(),
}));

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: useLocalSearchParamsMock,
  useRouter: useRouterMock,
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: useQueryMock,
}));

// This suite covers route-param parsing only; the foreground refresh hook
// needs a real QueryClient, which the react-query mock above does not provide.
vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({
  useRouteForegroundRefresh: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: { list: { queryOptions: () => ({ query: 'organizations' }) } },
    cliSessionsV2: {
      get: { queryOptions: queryOptionsMock },
    },
  }),
}));

vi.mock('@/components/invalid-route-state', () => ({
  InvalidRouteState: 'InvalidRouteState',
}));

vi.mock('@/components/agents/session-detail-content', () => ({
  SessionDetailContent: 'SessionDetailContent',
}));

vi.mock('@/components/agents/session-detail-skeleton', () => ({
  SessionSkeletonMessages: 'SessionSkeletonMessages',
  SessionComposerSkeleton: 'SessionComposerSkeleton',
}));

vi.mock('@/components/agents/session-connection-indicator', () => ({
  SessionConnectionIndicator: 'SessionConnectionIndicator',
}));

vi.mock('@/components/agents/session-context-metrics', () => ({
  SessionContextMetrics: 'SessionContextMetrics',
}));

vi.mock('@/components/agents/session-provider', () => ({
  AgentSessionProvider: 'AgentSessionProvider',
}));

vi.mock('@/components/agents/session-terminal-error', () => ({
  buildTerminalErrorCopyText: () => '',
}));

vi.mock('@/components/agents/use-message-copy', () => ({
  performCopy: vi.fn(),
}));

vi.mock('@/components/query-error', () => ({
  QueryError: 'QueryError',
}));

vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: vi.fn() }),
}));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => ({ token: 'token' }) }));
const globalContext = vi.hoisted(() => ({
  organizationId: 'global-org' as string | null,
  isLoaded: true,
  error: null,
  retry: vi.fn(),
  setOrganizationId: vi.fn(),
}));
vi.mock('@/lib/organization-context', () => ({ useOrganization: () => globalContext }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({
  ChevronLeft: 'ChevronLeft',
  ChevronDown: 'ChevronDown',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));

vi.mock('@/components/ui/button', () => ({
  Button: 'Button',
}));

vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));

vi.mock('@/lib/spawned-not-found-retry', () => ({
  shouldRetryNotFoundOnSpawnedRoute: () => false,
}));

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

function propOf(instance: TestRenderer.ReactTestInstance | undefined, key: string): unknown {
  if (!instance) {
    return undefined;
  }
  /* eslint-disable typescript-eslint/no-unsafe-member-access -- react-test-renderer props are an index signature */
  return instance.props[key];
  /* eslint-enable typescript-eslint/no-unsafe-member-access */
}

function mountRoute(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(SessionDetailScreen));
  });
  if (!ref.current) {
    throw new Error('route did not render');
  }
  return ref.current;
}

function queryEnabled(): boolean | undefined {
  const options = useQueryMock.mock.calls[0]?.[0] as { enabled?: boolean } | undefined;
  return options?.enabled;
}

function queryInput(): { session_id?: string } | undefined {
  return queryOptionsMock.mock.calls[0]?.[0] as { session_id?: string } | undefined;
}

beforeEach(() => {
  useLocalSearchParamsMock.mockReset();
  useRouterMock.mockReset();
  useRouterMock.mockReturnValue({ replace: vi.fn(), canGoBack: () => true, back: vi.fn() });
  useQueryMock.mockReset();
  useQueryMock.mockImplementation((options: { enabled?: boolean; query?: string } | undefined) => {
    if (options?.query === 'organizations') {
      return { data: [{ organizationId: 'org-a', organizationName: 'Session organization' }] };
    }
    // A disabled query remains pending, including invalid session links.
    const disabled = options?.enabled === false;
    return {
      ...queryState,
      isPending: disabled ? true : queryState.isPending,
    };
  });
  queryOptionsMock.mockReset();
  queryOptionsMock.mockReturnValue({});
  queryState.isPending = false;
  queryState.isError = false;
  queryState.isFetching = false;
  queryState.error = null;
  queryState.data = {};
  queryState.refetch.mockReset();
  globalContext.organizationId = 'global-org';
  globalContext.setOrganizationId.mockClear();
});

describe('SessionDetailScreen invalid session-id', () => {
  it('renders InvalidRouteState with the app backTo when session-id is undefined', () => {
    useLocalSearchParamsMock.mockReturnValue({ 'session-id': undefined });
    const renderer = mountRoute();

    const invalid = findByType(renderer.root, 'InvalidRouteState');
    expect(invalid).toHaveLength(1);
    expect(propOf(invalid[0], 'backTo')).toBe('/(app)');
    expect(findByType(renderer.root, 'SessionDetailContent')).toHaveLength(0);
    expect(queryEnabled()).toBe(false);

    act(() => {
      renderer.unmount();
    });
  });

  it('renders InvalidRouteState with the app backTo when session-id is an array', () => {
    useLocalSearchParamsMock.mockReturnValue({ 'session-id': ['sess-1', 'sess-2'] });
    const renderer = mountRoute();

    const invalid = findByType(renderer.root, 'InvalidRouteState');
    expect(invalid).toHaveLength(1);
    expect(propOf(invalid[0], 'backTo')).toBe('/(app)');
    expect(findByType(renderer.root, 'SessionDetailContent')).toHaveLength(0);
    expect(queryEnabled()).toBe(false);

    act(() => {
      renderer.unmount();
    });
  });
});

describe('SessionDetailScreen display scope', () => {
  it.each([
    { label: 'route organization', route: 'org-a', data: null, expected: 'org-a' },
    {
      label: 'fetched organization',
      route: undefined,
      data: { organization_id: 'org-a' },
      expected: 'org-a',
    },
    {
      label: 'explicit Personal',
      route: undefined,
      data: { organization_id: null },
      expected: null,
    },
    { label: 'legacy Personal', route: undefined, data: {}, expected: null },
  ])('passes resolved $label without changing global scope', state => {
    useLocalSearchParamsMock.mockReturnValue({
      'session-id': 'sess-1',
      organizationId: state.route,
    });
    queryState.data = state.data;
    globalContext.organizationId = state.expected === null ? 'global-org' : null;
    const globalId = globalContext.organizationId;
    const renderer = mountRoute();
    const content = findByType(renderer.root, 'SessionDetailContent')[0];
    expect(propOf(content, 'displayScope')).toEqual({
      organizationId: state.expected,
      isResolved: true,
    });
    expect(propOf(findByType(renderer.root, 'AgentSessionProvider')[0], 'organizationId')).toBe(
      state.expected ?? undefined
    );
    expect(globalContext.organizationId).toBe(globalId);
    expect(globalContext.setOrganizationId).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it.each(['pending', 'INTERNAL_SERVER_ERROR', 'NOT_FOUND', 'UNAUTHORIZED'])(
    'keeps the %s header unresolved and read-only',
    state => {
      useLocalSearchParamsMock.mockReturnValue({ 'session-id': 'sess-1' });
      queryState.data = null;
      queryState.isPending = state === 'pending';
      queryState.isError = state !== 'pending';
      queryState.error = { data: { code: state } };
      const renderer = mountRoute();
      const label = renderer.root.find(
        node => (node.type as string) === 'View' && node.props.accessibilityRole === 'text'
      );
      expect(label.props.accessibilityState).toEqual({ busy: true });
      expect(findByType(renderer.root, 'Text').flatMap(node => node.children)).not.toContain(
        'Personal'
      );
      expect(
        findByType(renderer.root, 'Pressable').filter(
          node => node.props.accessibilityHint === 'Select account'
        )
      ).toHaveLength(0);
      if (state !== 'pending') {
        expect(Boolean(propOf(findByType(renderer.root, 'QueryError')[0], 'onRetry'))).toBe(
          state === 'INTERNAL_SERVER_ERROR'
        );
        expect(findByType(renderer.root, 'Text').flatMap(node => node.children)).toContain('Copy');
        expect(findByType(renderer.root, 'Button')).toHaveLength(2);
      }
      expect(globalContext.organizationId).toBe('global-org');
      expect(globalContext.setOrganizationId).not.toHaveBeenCalled();
      act(() => {
        renderer.unmount();
      });
    }
  );

  it('resolves scope through the existing session Retry', () => {
    useLocalSearchParamsMock.mockReturnValue({ 'session-id': 'sess-1' });
    queryState.data = null;
    queryState.isError = true;
    queryState.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    const renderer = mountRoute();
    queryState.refetch.mockImplementation(() => {
      queryState.isError = false;
      queryState.data = { organization_id: 'org-a' };
      renderer.update(createElement(SessionDetailScreen));
    });
    const retry = propOf(findByType(renderer.root, 'QueryError')[0], 'onRetry') as () => void;
    act(() => {
      retry();
    });
    expect(propOf(findByType(renderer.root, 'SessionDetailContent')[0], 'displayScope')).toEqual({
      organizationId: 'org-a',
      isResolved: true,
    });
    expect(findByType(renderer.root, 'QueryError')).toHaveLength(0);
    expect(globalContext.organizationId).toBe('global-org');
    act(() => {
      renderer.unmount();
    });
  });
});

describe('SessionDetailScreen valid session-id', () => {
  it('renders the session content with the parsed session-id and enables the query', () => {
    useLocalSearchParamsMock.mockReturnValue({ 'session-id': 'sess-1' });
    const renderer = mountRoute();

    const content = findByType(renderer.root, 'SessionDetailContent');
    expect(content).toHaveLength(1);
    expect(propOf(content[0], 'sessionId')).toBe('sess-1');
    expect(findByType(renderer.root, 'InvalidRouteState')).toHaveLength(0);
    expect(queryEnabled()).toBe(true);
    expect(queryInput()).toEqual({ session_id: 'sess-1' });

    act(() => {
      renderer.unmount();
    });
  });
});
