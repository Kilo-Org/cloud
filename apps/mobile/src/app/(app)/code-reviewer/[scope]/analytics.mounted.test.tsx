// The analytics screen reads one organization's dashboard. A reader who is not
// a member of that organization cannot see it, so the screen must say so on the
// same surface the platform list paints — naming the scope, offering Retry and a
// way back — instead of a generic "could not load". The period control must also
// say which unit its three windows are in.

import { type ComponentType, createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import CodeReviewerAnalyticsRoute from './analytics';

type Membership = { organizationId: string; organizationName: string };

type Dashboard = {
  summary: {
    trackedReviews: number;
    totalFindings: number;
    highImpactChanges: number;
    estimatedImpactPoints: number;
  };
  repositories: {
    repository: string;
    trackedPrsOrMrs: number;
    criticalFindings: number;
    warningFindings: number;
    suggestionFindings: number;
  }[];
  settings: { enabled: boolean };
};

const queries = vi.hoisted(() => ({
  organizations: {
    data: [] as Membership[],
    isFetching: false,
    refetch: vi.fn<() => Promise<void>>(),
  },
  dashboard: {
    data: undefined as unknown,
    isPending: false,
    isError: false,
    isFetching: false,
    error: undefined as unknown,
    refetch: vi.fn<() => Promise<void>>(),
  },
}));

const dashboard: Dashboard = {
  summary: {
    trackedReviews: 12,
    totalFindings: 34,
    highImpactChanges: 5,
    estimatedImpactPoints: 120,
  },
  repositories: [],
  settings: { enabled: true },
};

const denial = { data: { code: 'UNAUTHORIZED', httpStatus: 401 } };

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: readonly unknown[] }) =>
    options.queryKey[0] === 'organizations' ? queries.organizations : queries.dashboard,
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ scope: 'org-drain' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: { list: { queryOptions: () => ({ queryKey: ['organizations', 'list'] }) } },
    codeReviews: {
      analytics: {
        getDashboard: { queryOptions: () => ({ queryKey: ['analytics', 'dashboard'] }) },
      },
    },
  }),
}));

vi.mock('@/components/invalid-route-state', () => ({ InvalidRouteState: 'InvalidRouteState' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyStateMock' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'SkeletonMock' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));

vi.mock('@/components/query-error', () => ({
  QueryError: (props: { variant?: string; title?: string; onRetry?: () => void }) =>
    createElement('QueryErrorMock', props),
}));

vi.mock('@/components/organization/scope-access-denied-screen', () => ({
  ScopeAccessDeniedScreen: (props: {
    title?: string;
    eyebrow?: string;
    kind?: string;
    backFallback?: string;
    onRetry?: () => void;
  }) => createElement('ScopeAccessDeniedScreenMock', props),
}));

vi.mock('@/components/code-reviewer/reviewer-header', () => ({
  ReviewerHeader: (props: { title?: string; eyebrow?: string }) =>
    createElement('ReviewerHeaderMock', props),
}));

vi.mock('@/components/ui/segmented-control', () => ({
  SegmentedControl: (props: {
    options: readonly { value: string; label: string }[];
    value: string;
    accessibilityLabel?: string;
    onChange?: (value: string) => void;
  }) => createElement('SegmentedControlMock', props),
}));

vi.mock('@/components/ui/configure-row', () => ({
  ConfigureRow: (props: { title?: string }) => createElement('ConfigureRowMock', props),
}));

vi.mock('@/components/ui/text', () => ({
  Text: (props: { children?: ReactNode }) => createElement('TextMock', null, props.children),
}));

vi.mock('@/components/ui/icons', () => ({
  FileText: 'FileText',
  GitPullRequest: 'GitPullRequest',
  LineChart: 'LineChart',
}));

vi.mock('react-native', () => ({ View: 'View' }));

const Screen = CodeReviewerAnalyticsRoute as ComponentType<Record<string, never>>;

function mountScreen(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Screen));
  });
  if (!ref.current) {
    throw new Error('analytics screen did not render');
  }
  return ref.current;
}

function findByType(root: TestRenderer.ReactTestInstance, type: string) {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

function segmentedControl(renderer: TestRenderer.ReactTestRenderer, index: number) {
  const control = findByType(renderer.root, 'SegmentedControlMock')[index];
  if (!control) {
    throw new Error(`segmented control ${index} did not render`);
  }
  return control;
}

beforeEach(() => {
  queries.organizations.data = [{ organizationId: 'org-drain', organizationName: 'Drain Labs' }];
  queries.organizations.isFetching = false;
  queries.organizations.refetch.mockReset();
  queries.dashboard.data = dashboard;
  queries.dashboard.isPending = false;
  queries.dashboard.isError = false;
  queries.dashboard.isFetching = false;
  queries.dashboard.error = undefined;
  queries.dashboard.refetch.mockReset();
});

describe('CodeReviewerAnalytics denied scope', () => {
  it('renders the no-access surface, not a failed read, and names the organization', () => {
    queries.dashboard.data = undefined;
    queries.dashboard.isError = true;
    queries.dashboard.error = denial;
    const renderer = mountScreen();

    const denied = findByType(renderer.root, 'ScopeAccessDeniedScreenMock')[0];
    expect(denied?.props.kind).toBe('denied');
    expect(denied?.props.title).toBe('Drain Labs');
    expect(denied?.props.eyebrow).toBe('Code Reviewer');
    expect(denied?.props.backFallback).toBe('/(app)/(tabs)/(0_home)');
    expect(findByType(renderer.root, 'QueryErrorMock')).toHaveLength(0);
    expect(findByType(renderer.root, 'SegmentedControlMock')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('falls back to the generic organization title when the membership list no longer names it', () => {
    queries.dashboard.data = undefined;
    queries.dashboard.isError = true;
    queries.dashboard.error = denial;
    queries.organizations.data = [];
    const renderer = mountScreen();

    const denied = findByType(renderer.root, 'ScopeAccessDeniedScreenMock')[0];
    expect(denied?.props.title).toBe('Organization');

    act(() => {
      renderer.unmount();
    });
  });

  it('treats a deleted organization as the not-found surface the platform list shows', () => {
    queries.dashboard.data = undefined;
    queries.dashboard.isError = true;
    queries.dashboard.error = { data: { code: 'NOT_FOUND', httpStatus: 404 } };
    const renderer = mountScreen();

    expect(findByType(renderer.root, 'ScopeAccessDeniedScreenMock')[0]?.props.kind).toBe(
      'not-found'
    );

    act(() => {
      renderer.unmount();
    });
  });

  it('re-reads the membership and the dashboard on Retry', () => {
    queries.dashboard.data = undefined;
    queries.dashboard.isError = true;
    queries.dashboard.error = denial;
    const renderer = mountScreen();
    const denied = findByType(renderer.root, 'ScopeAccessDeniedScreenMock')[0];
    if (!denied) {
      throw new Error('the no-access surface did not render');
    }

    act(() => {
      (denied.props.onRetry as () => void)();
    });

    expect(queries.organizations.refetch).toHaveBeenCalledTimes(1);
    expect(queries.dashboard.refetch).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.unmount();
    });
  });
});

describe('CodeReviewerAnalytics retryable failure', () => {
  it('keeps the dashboard error state with a Retry for a server failure', () => {
    queries.dashboard.data = undefined;
    queries.dashboard.isError = true;
    queries.dashboard.error = { data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 } };
    const renderer = mountScreen();

    const error = findByType(renderer.root, 'QueryErrorMock')[0];
    expect(error?.props.title).toBe('Could not load analytics');
    expect(typeof error?.props.onRetry).toBe('function');
    expect(findByType(renderer.root, 'ScopeAccessDeniedScreenMock')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('withholds Retry from a dashboard error that cannot recover', () => {
    queries.dashboard.data = undefined;
    queries.dashboard.isError = true;
    // A code the shared terminal list carries, so retrying cannot recover it.
    queries.dashboard.error = { data: { code: 'UNPROCESSABLE_CONTENT', httpStatus: 422 } };
    const renderer = mountScreen();

    expect(findByType(renderer.root, 'QueryErrorMock')[0]?.props.onRetry).toBeUndefined();

    act(() => {
      renderer.unmount();
    });
  });
});

describe('CodeReviewerAnalytics period labels', () => {
  it('labels each period segment with its day unit and selects the 30-day window', () => {
    const renderer = mountScreen();
    const periods = segmentedControl(renderer, 1);

    expect(periods.props.options).toEqual([
      { value: '7', label: '7 days' },
      { value: '30', label: '30 days' },
      { value: '90', label: '90 days' },
    ]);
    expect(periods.props.value).toBe('30');
    expect(periods.props.accessibilityLabel).toBe('Time range');

    act(() => {
      renderer.unmount();
    });
  });

  it('switches the dashboard to the picked window', () => {
    const renderer = mountScreen();
    const periods = segmentedControl(renderer, 1);

    act(() => {
      (periods.props.onChange as (value: string) => void)('90');
    });

    expect(segmentedControl(renderer, 1).props.value).toBe('90');

    act(() => {
      renderer.unmount();
    });
  });
});

describe('CodeReviewerAnalytics empty state', () => {
  it('drops the generic description when analytics is off and keeps it when analytics is on', () => {
    queries.dashboard.data = { ...dashboard, settings: { enabled: false } };
    const offRenderer = mountScreen();

    const offTexts = findByType(offRenderer.root, 'TextMock').map(node => node.props.children);
    expect(offTexts).toContain('Analytics is off for this organization.');
    const offEmpty = findByType(offRenderer.root, 'EmptyStateMock')[0];
    expect(offEmpty?.props.title).toBe('No reviews with analytics yet');
    expect(offEmpty?.props.description).toBeUndefined();

    act(() => {
      offRenderer.unmount();
    });

    queries.dashboard.data = dashboard;
    const onRenderer = mountScreen();

    expect(findByType(onRenderer.root, 'EmptyStateMock')[0]?.props.description).toBe(
      'Analytics records completed reviews while it is enabled for the organization.'
    );

    act(() => {
      onRenderer.unmount();
    });
  });
});

describe('CodeReviewerAnalytics header', () => {
  it('titles the screen with the organization and keeps the screen name as the eyebrow', () => {
    const renderer = mountScreen();
    const header = findByType(renderer.root, 'ReviewerHeaderMock')[0];

    expect(header?.props.title).toBe('Drain Labs');
    expect(header?.props.eyebrow).toBe('Analytics');

    act(() => {
      renderer.unmount();
    });
  });
});
