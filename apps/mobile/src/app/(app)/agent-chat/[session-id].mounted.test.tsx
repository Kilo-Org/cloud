/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom). */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  data: null as { organization_id?: string } | null,
  refetch: vi.fn(),
}));

vi.mock('react-native', () => ({
  View: 'View',
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: useLocalSearchParamsMock,
  useRouter: useRouterMock,
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: useQueryMock,
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
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
  SessionSkeletonMessages: 'SessionSkeletonMessages',
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

vi.mock('@/components/screen-header', () => ({
  ScreenHeader: 'ScreenHeader',
}));

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
  useRouterMock.mockReturnValue({ replace: vi.fn() });
  useQueryMock.mockReset();
  useQueryMock.mockImplementation((options: { enabled?: boolean } | undefined) => {
    // A disabled TanStack query stays pending forever (`isPending: true` when
    // `enabled` is false). Model that so the invalid-param tests exercise the
    // real branch order instead of a skeleton that never resolves.
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
  queryState.data = null;
  queryState.refetch.mockClear();
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
