// The Bitbucket row of the Code Reviewer scope landing reads two reads: the
// workspace token readiness and the OAuth integration status.

import { type ComponentType, createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
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

// The Bitbucket row reads both the readiness and the integration status: the
// readiness alone reports an OAuth connection as "Not connected".
describe('PlatformListScreen Bitbucket row', () => {
  function bitbucketRow() {
    const renderer = mountScreen();
    const row = findByType(renderer.root, 'ConfigureRowMock').find(
      candidate => candidate.props.title === 'Bitbucket'
    );
    if (!row) {
      throw new Error('the Bitbucket row did not render');
    }
    return {
      subtitle: row.props.subtitle,
      unmount: () => {
        act(() => {
          renderer.unmount();
        });
      },
    };
  }

  it('reads a status failure as unavailable, not as not connected', () => {
    bitbucketStatus.data = undefined;
    bitbucketStatus.isPending = true;
    bitbucketStatus.isError = true;
    bitbucketStatus.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };

    const row = bitbucketRow();

    expect(row.subtitle).toBe(i18n.t('codeReviewer.platformList.statusUnavailable'));
    row.unmount();
  });

  it('re-reads the integration status together with the other reads on Retry', () => {
    // A denial on the status read denies the scope like the other reads' do.
    bitbucketStatus.isError = true;
    bitbucketStatus.error = denial;

    const renderer = mountScreen();
    const denied = findByType(renderer.root, 'ScopeAccessDeniedScreenMock')[0];
    if (!denied) {
      throw new Error('the no-access surface did not render');
    }
    bitbucketStatus.isError = false;
    bitbucketStatus.error = undefined;

    act(() => {
      (denied.props.onRetry as () => void)();
    });

    expect(refetchMocks.bitbucket).toHaveBeenCalledTimes(1);
    expect(refetchMocks.bitbucketStatus).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.unmount();
    });
  });

  it('reports the row per connection state', () => {
    const cases: {
      tokenConnected: boolean;
      integrationStatus: Record<string, unknown> | undefined;
      subtitle: string;
    }[] = [
      {
        // The token integration answers from the readiness read alone.
        tokenConnected: true,
        integrationStatus: undefined,
        subtitle: i18n.t('common.connected'),
      },
      {
        tokenConnected: false,
        integrationStatus: {
          method: 'oauth',
          status: 'connected',
          workspace: { uuid: 'ws-uuid', slug: 'acme', displayName: 'Acme' },
        },
        subtitle: i18n.t('common.connected'),
      },
      {
        tokenConnected: false,
        integrationStatus: {
          method: 'oauth',
          status: 'workspace_selection_required',
          workspace: null,
        },
        subtitle: i18n.t('codeReviewer.platformList.needsAttention'),
      },
      {
        tokenConnected: false,
        integrationStatus: {
          method: 'oauth',
          status: 'reconnect_required',
          workspace: null,
        },
        subtitle: i18n.t('codeReviewer.platformList.needsAttention'),
      },
      {
        tokenConnected: false,
        integrationStatus: {
          method: 'workspace_access_token',
          status: 'not_connected',
        },
        subtitle: i18n.t('common.notConnected'),
      },
    ];
    for (const { tokenConnected, integrationStatus, subtitle } of cases) {
      // Each case sets both reads' answers; errors stay reset.
      status.error = undefined;
      bitbucketReadiness.connected = tokenConnected;
      bitbucketStatus.data = integrationStatus;

      const row = bitbucketRow();

      expect(row.subtitle).toBe(subtitle);
      row.unmount();
    }
  });
});
