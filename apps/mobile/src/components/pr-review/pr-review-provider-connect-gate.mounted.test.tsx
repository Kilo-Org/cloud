/* eslint-disable max-lines -- one harness mounts the provider gate for every role and connect state; the copy and action assertions share its mocks. */
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
// Mutable so each test answers the caller's organization role. The default is
// a plain member: the tests that expect the Connect CTA raise it to a billing
// role explicitly.
type MockPermission =
  | { status: 'loading' }
  | { status: 'error'; refetch: () => void; isRetrying: boolean }
  | { status: 'ready'; canEdit: boolean; canManage: boolean };
const permissionState = vi.hoisted((): { value: MockPermission } => ({
  value: { status: 'ready', canEdit: false, canManage: false },
}));
vi.mock('@/lib/hooks/use-reviewer-permission', () => ({
  useReviewerPermission: () => permissionState.value,
}));
// Mutable so each test answers the restored account selection. The layout and
// the gate read the same context, so they agree on when it has landed.
const organizationState = vi.hoisted(() => ({
  value: {
    organizationId: 'org-1' as string | null,
    isLoaded: true,
    error: null as 'restore' | 'save' | null,
  },
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => organizationState.value,
}));
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
  permissionState.value = { status: 'ready', canEdit: false, canManage: false };
  organizationState.value = { organizationId: 'org-1', isLoaded: true, error: null };
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
    permissionState.value = { status: 'ready', canEdit: true, canManage: true };
    queryState.status = { connected: false, reconnectRequired: true };
    const renderer = mount('gitlab', 'org-1');
    expect(renderer.root.findByType('EmptyState').props.title).toBe('GitLab connection expired');
    expect(renderedText(renderer)).toContain(
      "Re-check your connection — you'll be prompted to reconnect if needed."
    );
    // The title above already names the provider, so the description never
    // restates the expiry.
    expect(renderedText(renderer)).not.toContain('no longer valid');
    // The CTA is the integration-page action, not a second connect attempt.
    expect(renderedText(renderer)).toContain('Connect GitLab');
  });

  it('names the roles that can reconnect instead of offering a refused action', () => {
    // A plain member cannot complete the organization page's re-authorization:
    // the server restricts replacing an existing integration to billing roles.
    queryState.status = { connected: false, reconnectRequired: true };
    const renderer = mount('gitlab', 'org-1');
    expect(renderer.root.findByType('EmptyState').props.title).toBe('GitLab connection expired');
    expect(renderedText(renderer)).toContain(
      'The GitLab connection expired. Ask an organization owner, admin, or billing manager to reconnect it.'
    );
    // The description below the expiry title must not claim the provider was
    // never connected.
    expect(renderedText(renderer)).not.toContain("GitLab isn't connected");
    expect(renderedText(renderer)).not.toContain('Connect GitLab');
    expect(renderer.root.findAllByType('Button')).toHaveLength(0);
  });

  it('keeps the first-time connect copy for an organization with no connection', () => {
    queryState.status = { connected: false, reconnectRequired: false };
    const renderer = mount('gitlab', 'org-1');
    expect(renderer.root.findByType('EmptyState').props.title).toBe('Connect GitLab');
    expect(renderedText(renderer)).not.toContain('GitLab connection expired');
  });

  it('keeps the first-time connect action for a member', () => {
    // The organization OAuth connect only requires a billing role when a
    // connection already exists, so a member can complete a first connect.
    queryState.status = { connected: false, reconnectRequired: false };
    const renderer = mount('gitlab', 'org-1');
    expect(renderedText(renderer)).toContain('Connect GitLab');
    expect(renderer.root.findAllByType('Button')).toHaveLength(1);
  });

  it('waits for the restored selection instead of painting the personal scope', () => {
    // Before the stored selection lands the layout passes a null organization,
    // so the gate would show the personal Connect screen and then repaint the
    // organization's — a visible jump on the same route.
    organizationState.value = { organizationId: null, isLoaded: false, error: null };
    const renderer = mount('gitlab', null);
    expect(renderer.root.findByType('ActivityIndicator')).toBeDefined();
    expect(renderer.root.findAllByType('EmptyState')).toHaveLength(0);
  });

  it('settles when the selection restore failed, which never reports isLoaded', () => {
    // The provider publishes `error: 'restore'` and leaves `isLoaded` false, so
    // waiting on that flag alone would spin for good.
    organizationState.value = { organizationId: null, isLoaded: false, error: 'restore' };
    const renderer = mount('gitlab', null);
    expect(renderer.root.findByType('EmptyState')).toBeDefined();
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
  });

  it('keeps the resolved scope when the selection is restored again', () => {
    // A restore re-runs on a token change and briefly reports the selection as
    // unrestored; the reader's review subtree must not become a spinner.
    queryState.status = { connected: false, reconnectRequired: true };
    const renderer = mount('gitlab', 'org-1');
    expect(renderer.root.findByType('EmptyState').props.title).toBe('GitLab connection expired');

    organizationState.value = { organizationId: 'org-1', isLoaded: false, error: null };
    act(() => {
      renderer.update(
        <PrReviewConnectGate platform="gitlab" organizationId="org-1">
          {React.createElement('ReviewContent')}
        </PrReviewConnectGate>
      );
    });
    expect(renderer.root.findByType('EmptyState').props.title).toBe('GitLab connection expired');
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
  });

  it.each<[string, MockPermission]>([
    ['loading', { status: 'loading' }],
    ['failed', { status: 'error', refetch: () => undefined, isRetrying: false }],
  ])('keeps the Connect action while the role read is %s', (_case, permission) => {
    // The provider procedures stay server-authorized, so an unsettled
    // membership read must not strand the reader without an action.
    permissionState.value = permission;
    queryState.status = { connected: false, reconnectRequired: true };
    const renderer = mount('gitlab', 'org-1');
    expect(renderer.root.findAllByType('Button')).toHaveLength(1);
  });
});

describe('organization Bitbucket connect state', () => {
  it('names the roles that can connect instead of offering a refused action', () => {
    // Every organization Bitbucket connect is a billing-role procedure.
    queryState.status = { connected: false };
    const renderer = mount('bitbucket', 'org-1');
    expect(renderer.root.findByType('EmptyState').props.title).toBe('Bitbucket not connected');
    expect(renderedText(renderer)).toContain(
      'Only organization owners, admins, and billing managers can connect it.'
    );
    // The title states the absence, so the line below names only the roles and
    // never repeats it.
    expect(renderedText(renderer)).not.toContain("Bitbucket isn't connected");
    expect(renderer.root.findAllByType('Button')).toHaveLength(0);
  });

  it('keeps the Connect action for a billing role', () => {
    permissionState.value = { status: 'ready', canEdit: true, canManage: true };
    queryState.status = { connected: false };
    const renderer = mount('bitbucket', 'org-1');
    expect(renderedText(renderer)).toContain('Connect Bitbucket');
    expect(renderer.root.findAllByType('Button')).toHaveLength(1);
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
