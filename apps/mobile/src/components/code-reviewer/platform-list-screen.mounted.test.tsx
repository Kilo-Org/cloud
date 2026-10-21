// The Code Reviewer scope landing shares the Profile row's scope resolution, so
// an organization the reader may not see must reach the no-access surface
// instead of three platform rows whose status reads "unavailable".

import { type ComponentType, createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { PlatformListScreen } from './platform-list-screen';

const accessMock = vi.hoisted(() => vi.fn());
const refetchMocks = vi.hoisted(() => ({
  list: vi.fn(),
  github: vi.fn(),
  gitlab: vi.fn(),
  bitbucket: vi.fn(),
}));

vi.mock('@/lib/hooks/use-organization-scope-access', () => ({
  useOrganizationScopeAccess: (...args: unknown[]) => accessMock(...args),
}));

vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  PERSONAL_SCOPE: 'personal',
  useGitHubStatus: () => ({
    data: { connected: false },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: refetchMocks.github,
  }),
  useGitLabStatus: () => ({
    data: { connected: false },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: refetchMocks.gitlab,
  }),
  useBitbucketReadiness: () => ({
    data: { ready: false },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: refetchMocks.bitbucket,
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: [{ organizationId: 'org-lost', organizationName: 'Drain Labs' }],
    isFetching: false,
    refetch: refetchMocks.list,
  }),
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: { list: { queryOptions: () => ({ queryKey: ['organizations', 'list'] }) } },
  }),
}));

vi.mock('@/components/organization/scope-access-denied-screen', () => ({
  ScopeAccessDeniedScreen: (props: { title?: string; eyebrow?: string; kind?: string; onRetry?: () => void }) =>
    createElement('ScopeAccessDeniedScreenMock', props),
}));

vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { title?: string; eyebrow?: string }) =>
    createElement('ScreenHeaderMock', { title: props.title, eyebrow: props.eyebrow }),
}));

vi.mock('@/components/ui/configure-row', () => ({
  ConfigureRow: (props: { title?: string }) => createElement('ConfigureRowMock', { title: props.title }),
}));

vi.mock('@/components/ui/text', () => ({
  Text: (props: { children?: ReactNode }) => createElement('TextMock', null, props.children),
}));

vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));
vi.mock('@/components/ui/icons', () => ({
  CirclePlus: 'CirclePlus',
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
  accessMock.mockReset();
  accessMock.mockReturnValue('granted');
  for (const refetch of Object.values(refetchMocks)) {
    refetch.mockReset();
  }
});

describe('PlatformListScreen organization access', () => {
  it('renders the no-access surface instead of the platform rows for a lost organization', () => {
    accessMock.mockReturnValue('denied');
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

  it('re-reads the membership and every platform status on Retry', () => {
    accessMock.mockReturnValue('not-found');
    const renderer = mountScreen();
    const denied = findByType(renderer.root, 'ScopeAccessDeniedScreenMock')[0];
    if (!denied) {
      throw new Error('the no-access surface did not render');
    }

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
