// The Code Reviewer scope landing shares the Profile row's scope resolution, so
// an organization the reader may not see must reach the no-access surface
// instead of three platform rows whose status reads "unavailable".

import { type ComponentType, createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { _resetScopeNamesForTests } from '@/lib/code-reviewer-scope-name';
import { PlatformListScreen } from './platform-list-screen';

const refetchMocks = vi.hoisted(() => ({
  list: vi.fn<() => void>(),
  github: vi.fn<() => void>(),
  gitlab: vi.fn<() => void>(),
  bitbucket: vi.fn<() => void>(),
  bitbucketStatus: vi.fn<() => void>(),
}));
const membership = vi.hoisted(() => ({
  organizations: [] as { organizationId: string; organizationName: string }[],
}));
const status = vi.hoisted(() => ({ error: undefined as unknown }));
/** The connected value the Bitbucket readiness read answers; GitHub and GitLab never read it. */
const bitbucketReadiness = vi.hoisted(() => ({ connected: false }));
/** The Bitbucket integration-status read, which only the Bitbucket row reads. */
const bitbucketStatus = vi.hoisted(() => ({
  data: undefined as Record<string, unknown> | undefined,
  isPending: false,
  isError: false,
  error: undefined as unknown,
}));
const router = vi.hoisted(() => ({ push: vi.fn() }));

const denial = { data: { code: 'UNAUTHORIZED', httpStatus: 401 } };

function statusResult(refetch: () => void) {
  return {
    data: status.error
      ? undefined
      : { connected: refetch === refetchMocks.bitbucket ? bitbucketReadiness.connected : false },
    isLoading: false,
    isError: status.error !== undefined,
    isFetching: false,
    error: status.error,
    refetch,
  };
}

vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  PERSONAL_SCOPE: 'personal',
  useGitHubStatus: () => statusResult(refetchMocks.github),
  useGitLabStatus: () => statusResult(refetchMocks.gitlab),
  useBitbucketReadiness: () => statusResult(refetchMocks.bitbucket),
  useBitbucketIntegrationStatus: (_scope: string, enabled = true) => ({
    // A disabled read (personal scope) keeps `isPending` true with no data and
    // no error — the shape the classifier must not read as loading on this
    // screen either, because the row itself is hidden there.
    isLoading: false,
    isPending: enabled ? bitbucketStatus.isPending : true,
    isError: enabled ? bitbucketStatus.isError : false,
    isFetching: false,
    data: enabled ? bitbucketStatus.data : undefined,
    error: enabled ? bitbucketStatus.error : undefined,
    refetch: refetchMocks.bitbucketStatus,
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: membership.organizations,
    isFetching: false,
    refetch: refetchMocks.list,
  }),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: router.push, replace: vi.fn() }),
  useFocusEffect: () => undefined,
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: { list: { queryOptions: () => ({ queryKey: ['organizations', 'list'] }) } },
  }),
}));

vi.mock('@/components/organization/scope-access-denied-screen', () => ({
  ScopeAccessDeniedScreen: (props: {
    title?: string;
    eyebrow?: string;
    kind?: string;
    onRetry?: () => void;
  }) => createElement('ScopeAccessDeniedScreenMock', props),
}));

vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { title?: string; eyebrow?: string; backFallback?: string }) =>
    createElement('ScreenHeaderMock', {
      title: props.title,
      eyebrow: props.eyebrow,
      backFallback: props.backFallback,
    }),
}));

vi.mock('@/components/ui/configure-row', () => ({
  ConfigureRow: (props: { title?: string; subtitle?: string; onPress?: () => void }) =>
    createElement('ConfigureRowMock', {
      title: props.title,
      subtitle: props.subtitle,
      onPress: props.onPress,
    }),
}));

vi.mock('@/components/ui/text', () => ({
  Text: (props: { children?: ReactNode }) => createElement('TextMock', null, props.children),
}));

vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));
vi.mock('@/components/ui/icons', () => ({
  CirclePlus: 'CirclePlus',
  LineChart: 'LineChart',
  GitBranch: 'GitBranch',
  GitMerge: 'GitMerge',
  GitPullRequest: 'GitPullRequest',
  History: 'History',
}));
vi.mock('react-native', () => ({ View: 'View' }));

const Screen = PlatformListScreen as ComponentType<{ scope: string }>;

function mountScreen(scope = 'org-lost'): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Screen, { scope }));
  });
  if (!ref.current) {
    throw new Error('platform list did not render');
  }
  return ref.current;
}

function findByType(root: TestRenderer.ReactTestInstance, type: string) {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

beforeEach(() => {
  // The remembered scope names are a module singleton: a name painted by an
  // earlier test would title the next one's scope.
  _resetScopeNamesForTests();
  status.error = undefined;
  // The default readiness answers "no token integration" and the default
  // status read answers "no integration" the way the server does for an
  // organization with none, so the Bitbucket row reads Not connected.
  bitbucketReadiness.connected = false;
  bitbucketStatus.data = { method: 'workspace_access_token', status: 'not_connected' };
  bitbucketStatus.isPending = false;
  bitbucketStatus.isError = false;
  bitbucketStatus.error = undefined;
  router.push.mockClear();
  membership.organizations = [{ organizationId: 'org-lost', organizationName: 'Drain Labs' }];
  for (const refetch of Object.values(refetchMocks)) {
    refetch.mockReset();
  }
});

describe('PlatformListScreen organization access', () => {
  it('renders the no-access surface instead of the platform rows when the scope is denied', () => {
    status.error = denial;
    const renderer = mountScreen();
    const denied = findByType(renderer.root, 'ScopeAccessDeniedScreenMock')[0];

    expect(denied?.props.kind).toBe('denied');
    expect(denied?.props.title).toBe('Drain Labs');
    expect(denied?.props.eyebrow).toBe('Code Reviewer');
    expect(findByType(renderer.root, 'ConfigureRowMock')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('falls back to the generic organization title when the membership list no longer names it', () => {
    status.error = denial;
    membership.organizations = [];
    const renderer = mountScreen();
    const denied = findByType(renderer.root, 'ScopeAccessDeniedScreenMock')[0];

    expect(denied?.props.title).toBe('Organization');

    act(() => {
      renderer.unmount();
    });
  });

  it('re-reads the membership and every platform status on Retry', () => {
    status.error = { data: { code: 'NOT_FOUND', httpStatus: 404 } };
    const renderer = mountScreen();
    const denied = findByType(renderer.root, 'ScopeAccessDeniedScreenMock')[0];
    if (!denied) {
      throw new Error('the no-access surface did not render');
    }
    expect(denied.props.kind).toBe('not-found');

    act(() => {
      (denied.props.onRetry as () => void)();
    });

    expect(refetchMocks.list).toHaveBeenCalledTimes(1);
    expect(refetchMocks.github).toHaveBeenCalledTimes(1);
    expect(refetchMocks.gitlab).toHaveBeenCalledTimes(1);
    expect(refetchMocks.bitbucket).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the platform rows when access resolves', () => {
    const renderer = mountScreen();

    expect(findByType(renderer.root, 'ScopeAccessDeniedScreenMock')).toHaveLength(0);
    expect(findByType(renderer.root, 'ConfigureRowMock').length).toBeGreaterThan(0);

    act(() => {
      renderer.unmount();
    });
  });
});

// The header paints Back from its own fallback rather than waiting for the
// navigation container: a restored screen renders before its stack settles, so
// a list opened without a settled parent still needs a way out.
describe('PlatformListScreen back control', () => {
  it('offers Back from the Home tab when the list has no history behind it', () => {
    const renderer = mountScreen();
    const header = findByType(renderer.root, 'ScreenHeaderMock')[0];

    expect(header?.props.backFallback).toBe('/(app)/(tabs)/(0_home)');

    act(() => {
      renderer.unmount();
    });
  });
});

describe('PlatformListScreen double tap', () => {
  it('opens the platform overview once when its row is double tapped', () => {
    const renderer = mountScreen();
    const row = findByType(renderer.root, 'ConfigureRowMock').find(
      candidate => candidate.props.title === 'GitHub'
    );
    if (!row) {
      throw new Error('the GitHub row did not render');
    }

    act(() => {
      (row.props.onPress as () => void)();
      (row.props.onPress as () => void)();
    });

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith('/(app)/code-reviewer/org-lost/github');

    act(() => {
      renderer.unmount();
    });
  });

  it('opens the review list once when its row is double tapped', () => {
    const renderer = mountScreen();
    const row = findByType(renderer.root, 'ConfigureRowMock').find(
      candidate => candidate.props.title === 'Recent reviews'
    );
    if (!row) {
      throw new Error('the reviews row did not render');
    }

    act(() => {
      (row.props.onPress as () => void)();
      (row.props.onPress as () => void)();
    });

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith('/(app)/code-reviewer/org-lost/reviews');

    act(() => {
      renderer.unmount();
    });
  });
});
