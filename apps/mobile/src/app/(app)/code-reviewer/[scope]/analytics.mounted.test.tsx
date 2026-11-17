import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import CodeReviewerAnalyticsRoute from './analytics';

const useLocalSearchParamsMock = vi.hoisted(() => vi.fn());

const state = vi.hoisted(() => ({
  scope: 'org-analytics-1' as string | undefined,
  dashboard: {
    data: null as unknown,
    error: null as { data?: { code?: string } } | null,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle' as 'fetching' | 'paused' | 'idle',
    isPending: true,
    refetch: vi.fn(),
  },
  connectivity: 'online' as 'online' | 'offline' | 'unknown',
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: useLocalSearchParamsMock,
}));

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  useColorScheme: () => 'light',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/ui/icons', () => ({
  FileText: 'FileText',
  GitPullRequest: 'GitPullRequest',
  LineChart: 'LineChart',
}));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: 'TabScreenScrollView',
}));
vi.mock('@/components/ui/segmented-control', () => ({
  SegmentedControl: 'SegmentedControl',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/configure-row', () => ({
  ConfigureRow: 'ConfigureRow',
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    codeReviews: {
      analytics: {
        getDashboard: {
          queryOptions: () => ({}),
        },
      },
    },
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => state.dashboard,
}));

vi.mock('@/lib/hooks/use-code-reviewer-analytics-filters', () => ({
  useCodeReviewerAnalyticsFilters: () => ({
    platform: 'github',
    period: 30,
    setPlatform: vi.fn(),
    setPeriod: vi.fn(),
  }),
}));

vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => state.connectivity,
}));

vi.mock('@/components/invalid-route-state', () => ({
  InvalidRouteState: 'InvalidRouteState',
}));

vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));

vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));

vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));

vi.mock('@/components/code-reviewer/reviewer-header', () => ({
  ReviewerHeader: 'ReviewerHeader',
}));

function findByType(root: TestRenderer.ReactTestInstance, type: string) {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

function mountRoute() {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(CodeReviewerAnalyticsRoute));
  });
  if (!ref.current) {
    throw new Error('route did not render');
  }
  return ref.current;
}

const DASHBOARD = {
  summary: {
    trackedReviews: 3,
    totalFindings: 9,
    highImpactChanges: 1,
    estimatedImpactPoints: 4,
  },
  repositories: [
    {
      repository: 'org/repo',
      trackedPrsOrMrs: 3,
      criticalFindings: 1,
      warningFindings: 2,
      suggestionFindings: 6,
    },
  ],
  settings: { enabled: true },
};

beforeEach(() => {
  useLocalSearchParamsMock.mockReset();
  useLocalSearchParamsMock.mockReturnValue({ scope: state.scope });
  state.scope = 'org-analytics-1';
  state.dashboard = {
    data: null,
    error: null,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
    isPending: true,
    refetch: vi.fn(),
  };
  state.connectivity = 'online';
});

describe('CodeReviewerAnalyticsRoute read states', () => {
  it('renders the invalid route when the scope is missing', () => {
    useLocalSearchParamsMock.mockReturnValue({ scope: undefined });
    const renderer = mountRoute();
    expect(findByType(renderer.root, 'InvalidRouteState')).toHaveLength(1);
    act(() => {
      renderer.unmount();
    });
  });

  it('shows the skeleton while the first read is in flight', () => {
    state.dashboard.fetchStatus = 'fetching';
    const renderer = mountRoute();
    expect(findByType(renderer.root, 'Skeleton')).not.toHaveLength(0);
    act(() => {
      renderer.unmount();
    });
  });

  it('shows the retryable offline state instead of the skeleton when the read is paused offline', () => {
    // The old branch map reported `isPending` as the skeleton forever: a paused
    // read never reaches `isError`, so no Retry ever appeared (finding).
    state.dashboard.isPending = true;
    state.dashboard.fetchStatus = 'paused';
    state.connectivity = 'offline';
    const renderer = mountRoute();

    const errors = findByType(renderer.root, 'QueryError');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.props.variant).toBe('offline');
    expect(errors[0]?.props.onRetry).toBeTypeOf('function');
    expect(findByType(renderer.root, 'Skeleton')).toHaveLength(0);
    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the skeleton while the pause is not a confirmed offline state', () => {
    state.dashboard.isPending = true;
    state.dashboard.fetchStatus = 'paused';
    state.connectivity = 'unknown';
    const renderer = mountRoute();

    expect(findByType(renderer.root, 'QueryError')).toHaveLength(0);
    expect(findByType(renderer.root, 'Skeleton')).not.toHaveLength(0);
    act(() => {
      renderer.unmount();
    });
  });

  it('shows the retryable server state when the first read fails', () => {
    state.dashboard.isPending = false;
    state.dashboard.isError = true;
    state.dashboard.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    const renderer = mountRoute();

    const errors = findByType(renderer.root, 'QueryError');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.props.variant).toBe('server');
    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the permanent denial retryable-free when the read fails with FORBIDDEN', () => {
    state.dashboard.isPending = false;
    state.dashboard.isError = true;
    state.dashboard.error = { data: { code: 'FORBIDDEN' } };
    const renderer = mountRoute();

    const errors = findByType(renderer.root, 'QueryError');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.props.variant).toBe('permission');
    expect(errors[0]?.props.onRetry).toBeUndefined();
    act(() => {
      renderer.unmount();
    });
  });

  it('renders the metrics when the read settles', () => {
    state.dashboard.isPending = false;
    state.dashboard.data = DASHBOARD;
    const renderer = mountRoute();

    expect(findByType(renderer.root, 'QueryError')).toHaveLength(0);
    expect(findByType(renderer.root, 'Skeleton')).toHaveLength(0);
    const rows = findByType(renderer.root, 'ConfigureRow');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.props.title).toBe('org/repo');
    act(() => {
      renderer.unmount();
    });
  });

  it('keeps cached metrics and adds the offline stale notice when the refresh pauses', () => {
    state.dashboard.isPending = false;
    state.dashboard.data = DASHBOARD;
    state.dashboard.fetchStatus = 'paused';
    state.connectivity = 'offline';
    const renderer = mountRoute();

    expect(findByType(renderer.root, 'QueryError')).toHaveLength(0);
    const alerts = findByType(renderer.root, 'Text').filter(
      node => node.props.accessibilityRole === 'alert'
    );
    expect(alerts).toHaveLength(1);
    act(() => {
      renderer.unmount();
    });
  });

  it('keeps cached metrics and adds the failure stale notice when the refresh fails', () => {
    state.dashboard.isPending = false;
    state.dashboard.data = DASHBOARD;
    state.dashboard.isError = true;
    state.dashboard.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    const renderer = mountRoute();

    expect(findByType(renderer.root, 'QueryError')).toHaveLength(0);
    const alerts = findByType(renderer.root, 'Text').filter(
      node => node.props.accessibilityRole === 'alert'
    );
    expect(alerts).toHaveLength(1);
    act(() => {
      renderer.unmount();
    });
  });
});
