import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { act, TestRenderer } from '@/test/renderer';
import { PrReviewConnectGate } from './pr-review-connect-gate';

// Mutable so each test publishes the provider scope the layout would carry.
const scopeState = vi.hoisted(() => ({
  value: null as { ref: unknown } | null,
}));
// Mutable so each test answers the provider status and the memberships list.
const queryState = vi.hoisted(
  (): {
    status: Record<string, unknown>;
    memberships?: { organizationId: string }[];
    membershipsError?: boolean;
  } => ({
    status: { connected: false, revoked: false },
    memberships: undefined,
    membershipsError: false,
  })
);
vi.mock('@/lib/pr-review/provider-pr-ref', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useProviderPrScopeOrNull: () => scopeState.value,
  };
});
vi.mock('@/lib/hooks/use-organizations-list', () => ({
  useOrganizationsList: () => ({
    data: queryState.memberships,
    isError: queryState.membershipsError === true,
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: queryState.status,
    isPending: false,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useMutation: () => ({ mutateAsync: vi.fn(), isError: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    githubApps: {
      getUserAuthorization: { queryOptions: () => ({}), queryKey: () => [] },
      connectUserAuthorization: { mutationOptions: () => ({}) },
    },
    organizations: {
      reviewAgent: {
        getGitLabStatus: { queryOptions: () => ({}) },
        getBitbucketReadiness: { queryOptions: () => ({}) },
      },
    },
    personalReviewAgent: { getGitLabStatus: { queryOptions: () => ({}) } },
  }),
}));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://web.example' }));
const router = vi.hoisted(() => ({ dismissTo: vi.fn() }));
vi.mock('expo-router', () => ({
  usePathname: () => '/pr-review/gitlab/group/repo/3',
  useRouter: () => router,
  useFocusEffect: (effect: () => undefined | (() => void)) => {
    React.useEffect(effect, [effect]);
  },
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6F6A61', primaryForeground: '#FFFFFF' }),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync: vi.fn(),
  openBrowserAsync: vi.fn(),
  WebBrowserResultType: { OPENED: 'opened', DISMISS: 'dismiss', CANCEL: 'cancel' },
}));
vi.mock('@/components/ui/icons', () => ({
  PlugZap: 'PlugZap',
  RefreshCcw: 'RefreshCcw',
  ShieldAlert: 'ShieldAlert',
}));
vi.mock('@/components/icons/github-icon', () => ({ GitHubIcon: 'GitHubIcon' }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/empty-state', () => ({
  EmptyState: (props: { description?: React.ReactNode; action?: React.ReactNode }) =>
    React.createElement('EmptyState', props, props.description, props.action),
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/pr-review/pr-review-context-line', () => ({
  PrReviewContextLine: 'PrReviewContextLine',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  AppState: { addEventListener: vi.fn() },
  BackHandler: { addEventListener: () => ({ remove: vi.fn() }) },
  Platform: { OS: 'android' },
  View: 'View',
}));

let mounted: TestRenderer.ReactTestRenderer | undefined = undefined;

function mount(platform: 'gitlab' | 'bitbucket', organizationId: string | null = null) {
  act(() => {
    mounted = TestRenderer.create(
      <PrReviewConnectGate platform={platform} organizationId={organizationId}>
        {React.createElement('ReviewContent')}
      </PrReviewConnectGate>
    );
  });
  if (!mounted) {
    throw new Error('gate did not mount');
  }
  return mounted;
}

/** Every string the gate rendered, so a test can assert on the visible copy. */
function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType('Text')
    .flatMap(node => node.children.filter(child => typeof child === 'string'))
    .join(' ');
}

beforeEach(() => {
  vi.resetAllMocks();
  scopeState.value = null;
  queryState.status = { connected: false, revoked: false };
  queryState.memberships = undefined;
  queryState.membershipsError = false;
});

describe('provider gate instance hint', () => {
  it('passes a self-managed GitLab instance hint to the context line', () => {
    scopeState.value = {
      ref: {
        platform: 'gitlab',
        projectPath: 'group/repo',
        mrIid: 3,
        instanceHint: 'https://gitlab.example.com',
      },
    };
    const renderer = mount('gitlab');
    expect(renderer.root.findByType('PrReviewContextLine').props.instanceHint).toBe(
      'https://gitlab.example.com'
    );
  });

  it('passes no instance hint for gitlab.com or a missing hint', () => {
    scopeState.value = {
      ref: {
        platform: 'gitlab',
        projectPath: 'group/repo',
        mrIid: 3,
        instanceHint: 'https://gitlab.com',
      },
    };
    const hinted = mount('gitlab');
    expect(hinted.root.findByType('PrReviewContextLine').props.instanceHint).toBeUndefined();

    scopeState.value = { ref: { platform: 'gitlab', projectPath: 'group/repo', mrIid: 3 } };
    const bare = mount('gitlab');
    expect(bare.root.findByType('PrReviewContextLine').props.instanceHint).toBeUndefined();
  });
});

describe('organization GitLab reconnect state', () => {
  it('offers re-authorization when the organization connection cannot be used', () => {
    queryState.status = { connected: false, reconnectRequired: true };
    const renderer = mount('gitlab', 'org-1');
    expect(renderer.root.findByType('EmptyState').props.title).toBe('GitLab connection expired');
    expect(renderedText(renderer)).toContain('Your GitLab connection is no longer valid');
    // The CTA is the integration-page action, not a second connect attempt.
    expect(renderedText(renderer)).toContain('Connect GitLab');
  });

  it('keeps the first-time connect copy for an organization with no connection', () => {
    queryState.status = { connected: false, reconnectRequired: false };
    const renderer = mount('gitlab', 'org-1');
    expect(renderer.root.findByType('EmptyState').props.title).toBe('Connect GitLab');
    expect(renderedText(renderer)).not.toContain('GitLab connection expired');
  });
});

describe('Bitbucket org-only guidance', () => {
  const SWITCH_COPY = 'Switch the account above to an organization';
  const NO_ORGANIZATION_COPY = 'This account has no organizations yet';

  it('points at the account switch when the reader has an organization', () => {
    queryState.memberships = [{ organizationId: 'org-1' }];
    const renderer = mount('bitbucket');
    expect(renderedText(renderer)).toContain(SWITCH_COPY);
    expect(renderedText(renderer)).not.toContain(NO_ORGANIZATION_COPY);
  });

  it('says no organization is available when the reader has none', () => {
    queryState.memberships = [];
    const renderer = mount('bitbucket');
    expect(renderedText(renderer)).toContain(NO_ORGANIZATION_COPY);
    expect(renderedText(renderer)).not.toContain(SWITCH_COPY);
  });

  it('keeps the switch guidance while the memberships list is unresolved', () => {
    queryState.memberships = undefined;
    const renderer = mount('bitbucket');
    expect(renderedText(renderer)).toContain(SWITCH_COPY);
    expect(renderedText(renderer)).not.toContain(NO_ORGANIZATION_COPY);
  });

  it('adds no guidance of its own when the memberships read failed', () => {
    // The context line reports the failure and offers a retry; neither the
    // switch copy nor "no organizations" is true, so the gate says neither.
    queryState.memberships = undefined;
    queryState.membershipsError = true;
    const renderer = mount('bitbucket');
    expect(renderedText(renderer)).not.toContain(SWITCH_COPY);
    expect(renderedText(renderer)).not.toContain(NO_ORGANIZATION_COPY);
    expect(renderer.root.findByType('EmptyState').props.title).toBe(
      'Bitbucket is available for organizations only.'
    );
  });
});
