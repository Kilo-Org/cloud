/* eslint-disable max-lines -- cohesive mounted suite for the integrations hub state, the shared owner note, the header subtitle, and the deep-link scope contract */

// The integrations hub serves both scopes: the personal one shows every
// connection the account owns, and the organization one hides the actions the
// viewer's role cannot take. The states below are the ones the screen owns —
// connected, empty, retryable failure, permission loss and an unresolved scope.

import { type ComponentType, createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import IntegrationsRoute from '@/app/(app)/(tabs)/(3_profile)/integrations';
import { blockedNoteKey, IntegrationsScreen } from './integrations-screen';

type SetupStatusRow = { platform: string; installed: boolean; installation?: unknown };

/** The catalog values, so a copy edit does not need a test edit. */
const OWNER_NOTE = i18n.t('integrations.managedByOwner');
const OWNER_ADMIN_NOTE = i18n.t('integrations.managedByOwnerOrAdmin');
const OWNER_BILLING_NOTE = i18n.t('integrations.managedByOwnerOrBilling');
const OWNER_ADMIN_BILLING_NOTE = i18n.t('integrations.managedByOwnerAdminOrBilling');

const GITHUB_CONNECTION = {
  id: 'gh-1',
  integration_status: 'active',
  suspended_at: null,
  canUninstallNatively: true,
};

const state = vi.hoisted(() => ({
  statuses: {
    data: [] as SetupStatusRow[] | undefined,
    isPending: false,
    isError: false,
    isFetching: false,
    error: undefined as unknown,
  },
  githubConnections: { data: [] as unknown[] | undefined, isPending: false },
  bitbucket: { data: undefined as { integrationId: string | null } | undefined, isPending: false },
  role: undefined as string | undefined,
  orgResolved: true,
  orgs: [] as { organizationId: string; organizationName?: string; role?: string }[],
  permissionDenied: false,
}));
const calls = vi.hoisted(() => ({
  connect: vi.fn<(provider: string) => void>(),
  disconnect: vi.fn<(variables: { provider: string; integrationId: string | null }) => void>(),
  confirm: vi.fn<(request: { title: string; onConfirm: () => void }) => void>(),
  refetch: vi.fn<() => void>(),
  openExternal: vi.fn<(url: string) => void>(),
  handoff: vi.fn<(target: unknown) => void>(),
  push: vi.fn<(href: unknown) => void>(),
  bitbucketRefetch: vi.fn<() => void>(),
}));

function statusState(overrides: Partial<typeof state.statuses> = {}): typeof state.statuses {
  return {
    data: [],
    isPending: false,
    isError: false,
    isFetching: false,
    error: undefined,
    ...overrides,
  };
}

vi.mock('@/lib/hooks/use-integrations', () => ({
  useIntegrationStatuses: () => ({ ...state.statuses, refetch: calls.refetch }),
  useGitHubConnections: () => ({ ...state.githubConnections, refetch: calls.refetch }),
  useDisconnectIntegration: () => ({
    mutate: calls.disconnect,
    isPending: false,
    variables: undefined,
  }),
  useIntegrationConnect: () => ({ pendingProvider: null, connect: calls.connect }),
}));

vi.mock('@/lib/hooks/use-bitbucket', () => ({
  // The screen repeats a Bitbucket read that failed to name its connection, so
  // the row's Retry reaches this spy instead of a live client.
  useBitbucketIntegrationStatus: () => ({
    data: state.bitbucket.data,
    isPending: state.bitbucket.isPending,
    isFetching: false,
    refetch: calls.bitbucketRefetch,
  }),
}));

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: (override?: string) => {
    const id = override ?? account.organizationId;
    const org = state.orgs.find(entry => entry.organizationId === id);
    return {
      contextOrganizationId: account.organizationId,
      organizationId: id,
      role: state.role,
      org: state.orgResolved ? org : undefined,
      orgs: state.orgs,
      isLoading: false,
      isResolving: false,
      isError: false,
    };
  },
}));

// The account provider as the screen sees it: the persisted selection and the
// writer the deep-link scope uses.
const account = vi.hoisted(() => ({
  organizationId: 'org-1' as string | null,
  written: [] as (string | null)[],
  setOrganizationId: vi.fn(),
  reset() {
    account.organizationId = 'org-1';
    account.written = [];
    account.setOrganizationId.mockClear();
  },
}));

vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({
    organizationId: account.organizationId,
    isLoaded: true,
    setOrganizationId: account.setOrganizationId,
  }),
}));

vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({
  useRouteForegroundRefresh: () => undefined,
}));

vi.mock('@/lib/trpc-error', () => ({
  isPermissionDeniedError: () => state.permissionDenied,
  trpcErrorVariant: () => 'server',
}));

vi.mock('@/lib/app-shell-handoff', () => ({
  openAppShellHandoff: (target: unknown) => {
    calls.handoff(target);
    return Promise.resolve();
  },
}));
vi.mock('@/lib/external-link', () => ({
  openExternalUrl: (url: string) => {
    calls.openExternal(url);
  },
}));

vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: calls.confirm, dialog: null }),
}));

vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: (props: { title?: string }) =>
    createElement('OrganizationBoundaryMock', { title: props.title }),
}));

vi.mock('@/components/organization/permission-denied', () => ({
  PermissionDenied: (props: { description: string }) =>
    createElement('PermissionDeniedMock', props),
}));

vi.mock('@/components/query-error', () => ({
  QueryError: (props: { title?: string; variant?: string; onRetry?: () => void }) =>
    createElement('QueryErrorMock', props),
}));

vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: { title?: string; subtitle?: string }) =>
    createElement('ScreenHeaderMock', props),
}));

vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({
  Text: (props: { children?: ReactNode }) => createElement('TextMock', null, props.children),
}));
// Each row carries its action as a child, so a test can ask one row for its
// button instead of inspecting the trailing element it was handed. A row
// without a button carries a press instead, so the mock keeps both.
vi.mock('@/components/ui/configure-row', () => ({
  ConfigureRow: (props: {
    title?: string;
    subtitle?: string;
    trailing?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) =>
    createElement(
      'RowMock',
      {
        title: props.title,
        subtitle: props.subtitle,
        onPress: props.onPress,
        accessibilityLabel: props.accessibilityLabel,
      },
      props.trailing ?? null
    ),
}));
vi.mock('@/components/ui/icons', () => ({
  Bot: 'Bot',
  CircleDot: 'CircleDot',
  GitBranch: 'GitBranch',
  GitCommit: 'GitCommit',
  GitMerge: 'GitMerge',
  MessageSquare: 'MessageSquare',
}));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://app.kilo.ai' }));
vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'AnimatedView' },
  FadeOut: { duration: () => undefined },
}));

const Screen = IntegrationsScreen as ComponentType<{ organizationId?: string }>;

let mounted: TestRenderer.ReactTestRenderer | undefined = undefined;

function mount(organizationId?: string): TestRenderer.ReactTestRenderer {
  act(() => {
    mounted = TestRenderer.create(createElement(Screen, { organizationId }));
  });
  if (!mounted) {
    throw new Error('integrations hub did not render');
  }
  return mounted;
}

afterEach(() => {
  act(() => {
    mounted?.unmount();
    mountedRoute?.unmount();
  });
  mounted = undefined;
  mountedRoute = undefined;
});

function findOne(root: TestRenderer.ReactTestInstance, type: string) {
  return root.findAll(node => node.type === type);
}

function rowTitled(root: TestRenderer.ReactTestInstance, title: string) {
  const row = findOne(root, 'RowMock').find(candidate => candidate.props.title === title);
  if (!row) {
    throw new Error(`no row titled ${title}`);
  }
  return row;
}

function actionOf(row: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance | null {
  return row.findAllByType('Button')[0] ?? null;
}

function texts(root: TestRenderer.ReactTestInstance): ReactNode[] {
  return findOne(root, 'TextMock').map(node => node.props.children);
}

/** Every "who can change this" sentence the hub rendered, in one list. */
function sharedNotes(root: TestRenderer.ReactTestInstance): ReactNode[] {
  const notes = new Set<ReactNode>([
    OWNER_NOTE,
    OWNER_ADMIN_NOTE,
    OWNER_BILLING_NOTE,
    OWNER_ADMIN_BILLING_NOTE,
  ]);
  return texts(root).filter(text => notes.has(text));
}

/** Invokes a control the test found, matching the renderer's synchronous act. */
function press(node: TestRenderer.ReactTestInstance | null) {
  const onPress = node?.props.onPress as (() => void) | undefined;
  if (!onPress) {
    throw new Error('the control has no press handler');
  }
  act(() => {
    onPress();
  });
}

beforeEach(() => {
  account.reset();
  account.setOrganizationId.mockImplementation((next: string | null) => {
    account.written.push(next);
  });
  // Each entry is a membership row as `useOrgBoundary` returns it, so the
  // header can name the organization the scope belongs to.
  state.orgs = [
    { organizationId: 'org-1', organizationName: 'Acme' },
    { organizationId: 'org-b', organizationName: 'Acme Research' },
  ];
  routeParams.org = undefined;
  state.statuses = statusState();
  state.githubConnections = { data: [], isPending: false };
  state.bitbucket = { data: undefined, isPending: false };
  state.role = undefined;
  state.orgResolved = true;
  state.permissionDenied = false;
  for (const spy of Object.values(calls)) {
    spy.mockClear();
  }
});

describe('IntegrationsScreen', () => {
  it('lists the personal providers, states each status, and connects through the hand-off', () => {
    state.statuses.data = [
      { platform: 'slack', installed: true, installation: { teamName: 'Acme Slack' } },
    ];
    const renderer = mount();
    const root = renderer.root;

    expect(findOne(root, 'RowMock').map(row => row.props.title)).toEqual([
      'GitHub',
      'Slack',
      'GitLab',
      'Linear',
    ]);
    expect(rowTitled(root, 'Slack').props.subtitle).toBe('Connected to Acme Slack');
    expect(rowTitled(root, 'GitHub').props.subtitle).toBe('Not connected');

    const connect = actionOf(rowTitled(root, 'GitHub'));
    expect(connect?.props.accessibilityLabel).toBe('Connect. GitHub');
    press(connect);
    expect(calls.connect).toHaveBeenCalledWith('github');
  });

  it('states an empty scope once, through each row, with no page-level line', () => {
    const renderer = mount();

    // The rows carry the state, so the page adds no second line that says the
    // same thing for every row at once.
    expect(texts(renderer.root)).not.toContain('No integrations connected yet.');
    expect(rowTitled(renderer.root, 'GitHub').props.subtitle).toBe('Not connected');
    expect(rowTitled(renderer.root, 'Linear').props.subtitle).toBe('Not connected');
  });

  it('reports an ambiguous GitHub organization as web-managed', () => {
    state.role = 'owner';
    state.statuses.data = [
      { platform: 'github', installed: true, installation: { accountLogin: 'acme' } },
      { platform: 'bitbucket', installed: true, installation: { accountLogin: 'workspace' } },
    ];
    state.githubConnections.data = [
      { id: 'a', integration_status: 'active', suspended_at: null },
      { id: 'b', integration_status: 'active', suspended_at: null },
    ];
    state.bitbucket = { data: { integrationId: 'bitbucket-1' }, isPending: false };
    const renderer = mount('org-1');
    const root = renderer.root;

    expect(actionOf(rowTitled(root, 'GitHub'))?.props.accessibilityLabel).toBe(
      'Manage on the web. GitHub'
    );
    // The GitHub row's web management link is the shell's integration page,
    // reached through a one-time hand-off rather than a full-web URL.
    press(actionOf(rowTitled(root, 'GitHub')));
    expect(calls.handoff).toHaveBeenCalledWith({
      page: 'integration',
      platform: 'github',
      organizationId: 'org-1',
    });
    expect(calls.openExternal).not.toHaveBeenCalled();
    // Bitbucket's connection is changed in the app, so an owner's installed row
    // disconnects instead of opening the web page.
    const bitbucket = actionOf(rowTitled(root, 'Bitbucket'));
    expect(bitbucket?.props.accessibilityLabel).toBe('Disconnect. Bitbucket');
  });

  it('opens the Bitbucket connect sheet for an organization without a workspace', () => {
    state.role = 'owner';
    state.statuses.data = [{ platform: 'bitbucket', installed: false, installation: null }];
    const renderer = mount('org-1');

    const connect = actionOf(rowTitled(renderer.root, 'Bitbucket'));
    expect(connect?.props.accessibilityLabel).toBe('Connect. Bitbucket');
    press(connect);

    expect(calls.connect).not.toHaveBeenCalled();
    expect(calls.push).toHaveBeenCalledWith({
      pathname: '/(app)/bitbucket-connect',
      params: { scope: 'org-1' },
    });
  });

  it('disconnects the Bitbucket integration the status read names', () => {
    state.role = 'owner';
    state.statuses.data = [
      { platform: 'bitbucket', installed: true, installation: { accountLogin: 'workspace' } },
    ];
    state.bitbucket = { data: { integrationId: 'bitbucket-1' }, isPending: false };
    const renderer = mount('org-1');

    press(actionOf(rowTitled(renderer.root, 'Bitbucket')));
    const request = calls.confirm.mock.calls[0]?.[0];
    act(() => {
      request?.onConfirm();
    });

    expect(calls.disconnect).toHaveBeenCalledWith({
      provider: 'bitbucket',
      integrationId: 'bitbucket-1',
    });
  });

  it('offers the Bitbucket connection read again when it named no connection', () => {
    state.role = 'owner';
    state.statuses.data = [
      { platform: 'bitbucket', installed: true, installation: { accountLogin: 'workspace' } },
    ];
    // The integration read failed, so the row knows a workspace is installed but
    // not the connection its Disconnect would remove. Before the row offered the
    // read again, that state rendered no action at all.
    state.bitbucket = { data: undefined, isPending: false };
    const renderer = mount('org-1');

    const retry = actionOf(rowTitled(renderer.root, 'Bitbucket'));
    expect(retry?.props.accessibilityLabel).toBe('Retry. Bitbucket');
    press(retry);

    expect(calls.bitbucketRefetch).toHaveBeenCalledOnce();
    expect(calls.confirm).not.toHaveBeenCalled();
  });

  it('disconnects an organization connection after the destructive confirmation', () => {
    state.role = 'admin';
    state.statuses.data = [
      { platform: 'slack', installed: true, installation: { teamName: 'Acme' } },
    ];
    const renderer = mount('org-1');

    const disconnect = actionOf(rowTitled(renderer.root, 'Slack'));
    expect(disconnect?.props.accessibilityLabel).toBe('Disconnect. Slack');
    press(disconnect);

    expect(calls.confirm).toHaveBeenCalledTimes(1);
    const request = calls.confirm.mock.calls[0]?.[0];
    expect(request?.title).toBe('Disconnect Slack?');
    act(() => {
      request?.onConfirm();
    });
    expect(calls.disconnect).toHaveBeenCalledWith({ provider: 'slack', integrationId: null });
  });

  it('shows one shared note to a member and opens each blocked row on the web', () => {
    state.role = 'member';
    state.statuses.data = [
      { platform: 'github', installed: true, installation: { accountLogin: 'acme' } },
      { platform: 'slack', installed: true, installation: { teamName: 'Acme Slack' } },
      { platform: 'bitbucket', installed: true, installation: { accountLogin: 'workspace' } },
    ];
    const root = mount('org-1').root;

    // Every action a member's role cannot take leaves its row without a
    // control, and the hub names the roles that can change them once, above the
    // list, instead of under each row. GitLab belongs to that set: every
    // organization GitLab connect asks for a billing role, first connect too.
    // The row keeps a press that opens the provider's page, so the hub is a
    // list of destinations rather than a list of labels, and its name repeats
    // the state a sighted reader takes from the subtitle.
    for (const title of ['GitHub', 'Slack', 'GitLab', 'Bitbucket']) {
      const row = rowTitled(root, title);
      expect(actionOf(row)).toBeNull();
      // Bitbucket's press opens the app's own connect sheet, so its name claims
      // no browser trip; the other rows open the provider's web page.
      const expectedName =
        title === 'Bitbucket'
          ? `Bitbucket. ${row.props.subtitle}`
          : `Open in browser. ${title}. ${row.props.subtitle}`;
      expect(row.props.accessibilityLabel).toBe(expectedName);
    }
    // The blocked rows follow two role sets for a member: GitHub and Slack ask
    // for the manage set, and every billing-role connect (GitLab, Linear,
    // Discord, Bitbucket) adds the billing manager, so
    // the sentence names all three and nothing else is rendered.
    expect(sharedNotes(root)).toEqual([OWNER_ADMIN_BILLING_NOTE]);

    press(rowTitled(root, 'GitLab'));
    expect(calls.handoff).toHaveBeenCalledWith(
      expect.objectContaining({ page: 'integration', platform: 'gitlab', organizationId: 'org-1' })
    );

    // A blocked Bitbucket row's press opens the app's own connect sheet, which
    // states the connection's state and the roles that may change it.
    press(rowTitled(root, 'Bitbucket'));
    expect(calls.push).toHaveBeenCalledWith({
      pathname: '/(app)/bitbucket-connect',
      params: { scope: 'org-1' },
    });
  });

  it('shows no shared note to an owner, who is offered every row', () => {
    state.role = 'owner';
    state.statuses.data = [
      { platform: 'slack', installed: true, installation: { teamName: 'Acme' } },
      { platform: 'bitbucket', installed: true, installation: { accountLogin: 'workspace' } },
    ];
    state.bitbucket = { data: { integrationId: 'bitbucket-1' }, isPending: false };
    const root = mount('org-1').root;

    expect(findOne(root, 'RowMock').every(row => actionOf(row) != null)).toBe(true);
    // A row that offers its control does not also open the page on press: one
    // row, one action.
    expect(findOne(root, 'RowMock').every(row => row.props.onPress == null)).toBe(true);
    expect(sharedNotes(root)).toEqual([]);
  });

  it('names the manage roles for a billing manager, blocked on GitHub and Slack alone', () => {
    state.role = 'billing_manager';
    state.statuses.data = [
      { platform: 'github', installed: true, installation: { accountLogin: 'acme' } },
      { platform: 'slack', installed: true, installation: { teamName: 'Acme Slack' } },
    ];
    const root = mount('org-1').root;

    // GitHub and Slack both ask for ORGANIZATION_MANAGE_ROLES, and every other
    // row's rule admits a billing manager, so the sentence names the two manage
    // roles and stops there.
    for (const title of ['GitHub', 'Slack']) {
      expect(actionOf(rowTitled(root, title))).toBeNull();
    }
    expect(sharedNotes(root)).toEqual([OWNER_ADMIN_NOTE]);
  });

  it('shows no note to an admin, whom every provider rule admits', () => {
    state.role = 'admin';
    state.statuses.data = [
      { platform: 'bitbucket', installed: true, installation: { accountLogin: 'workspace' } },
    ];
    const root = mount('org-1').root;

    // Bitbucket's row calls the same organization procedures every other
    // provider follows, and their role sets all include the admin, so the row
    // keeps its action and the hub names no role.
    expect(actionOf(rowTitled(root, 'Bitbucket'))).not.toBeNull();
    expect(sharedNotes(root)).toEqual([]);
  });

  it('names one role with the owner-only sentence, and none for an empty union', () => {
    expect(blockedNoteKey(['owner'])).toBe('integrations.managedByOwner');
    expect(blockedNoteKey([])).toBeNull();
  });

  it('shows no shared note and no organization name in the personal scope', () => {
    state.role = 'member';
    state.statuses.data = [
      { platform: 'slack', installed: true, installation: { teamName: 'Acme' } },
    ];
    const root = mount().root;

    // The personal scope belongs to the viewer, so every row offers its action
    // and nothing needs explaining.
    expect(findOne(root, 'RowMock').every(row => actionOf(row) != null)).toBe(true);
    expect(sharedNotes(root)).toEqual([]);
    const header = findOne(root, 'ScreenHeaderMock')[0];
    expect(header?.props.title).toBe('Integrations');
    expect(header?.props.subtitle).toBeUndefined();
  });

  it('names the organization in the header of the organization scope', () => {
    state.role = 'member';
    const header = findOne(mount('org-1').root, 'ScreenHeaderMock')[0];

    expect(header?.props.title).toBe('Integrations');
    expect(header?.props.subtitle).toBe('Acme');
  });

  it('retries a failed read from the error state', () => {
    state.statuses = statusState({
      data: undefined,
      isError: true,
      error: { data: { code: 'INTERNAL_SERVER_ERROR' } },
    });
    const renderer = mount();

    const error = findOne(renderer.root, 'QueryErrorMock')[0];
    expect(error?.props.title).toBe('Could not load integrations');
    const retry = error?.props.onRetry as (() => void) | undefined;
    act(() => {
      retry?.();
    });
    expect(calls.refetch).toHaveBeenCalled();
  });

  it('reserves the screen for a viewer who lost access', () => {
    state.permissionDenied = true;
    state.statuses = statusState({
      data: undefined,
      isError: true,
      error: { data: { code: 'FORBIDDEN' } },
    });
    const renderer = mount('org-1');
    expect(findOne(renderer.root, 'PermissionDeniedMock')[0]?.props.description).toBe(
      'You do not have permission to manage these integrations.'
    );
  });

  it('waits for an installed GitHub row’s connection list before choosing its action', () => {
    state.statuses.data = [
      { platform: 'github', installed: true, installation: { accountLogin: 'acme' } },
    ];
    // The setup-status read lands first, as it does when the connections read is
    // slower: an unread list is not an empty one, so the row holds its action.
    state.githubConnections = { data: undefined, isPending: true };
    const pending = mount();
    expect(actionOf(rowTitled(pending.root, 'GitHub'))).toBeNull();
    expect(texts(pending.root)).not.toContain('Manage on the web');
    act(() => {
      pending.unmount();
    });

    state.githubConnections = { data: [GITHUB_CONNECTION], isPending: false };
    const settled = actionOf(rowTitled(mount().root, 'GitHub'));
    expect(settled?.props.accessibilityLabel).toBe('Disconnect. GitHub');
  });

  it('waits on the organization boundary before reading any connection', () => {
    state.orgResolved = false;
    const renderer = mount('org-unresolved');
    expect(findOne(renderer.root, 'OrganizationBoundaryMock')[0]?.props.title).toBe('Integrations');
    expect(findOne(renderer.root, 'RowMock')).toHaveLength(0);
  });
});

const routeParams = vi.hoisted(() => ({ org: undefined as string | string[] | undefined }));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ org: routeParams.org }),
  useRouter: () => ({ push: calls.push }),
}));

let mountedRoute: TestRenderer.ReactTestRenderer | undefined = undefined;

function mountRoute(): TestRenderer.ReactTestRenderer {
  act(() => {
    mountedRoute = TestRenderer.create(createElement(IntegrationsRoute));
  });
  if (!mountedRoute) {
    throw new Error('integrations route did not render');
  }
  return mountedRoute;
}

describe('integrations route deep-linked organization', () => {
  it('writes the linked member organization as the selection', () => {
    routeParams.org = 'org-b';
    mountRoute();

    expect(account.written).toEqual(['org-b']);
  });

  it('takes the first of a repeated org parameter', () => {
    routeParams.org = ['org-b', 'org-c'];
    mountRoute();

    expect(account.written).toEqual(['org-b']);
  });

  it('writes nothing for an organization the viewer is not a member of', () => {
    routeParams.org = 'org-foreign';
    const renderer = mountRoute();

    expect(account.written).toEqual([]);
    expect(findOne(renderer.root, 'OrganizationBoundaryMock')).toHaveLength(1);
    expect(findOne(renderer.root, 'RowMock')).toHaveLength(0);
  });

  it.each<string | string[] | undefined>([undefined, '', ['', 'org-b']])(
    'leaves the selection alone for %j',
    org => {
      routeParams.org = org;
      mountRoute();

      expect(account.written).toEqual([]);
    }
  );
});
