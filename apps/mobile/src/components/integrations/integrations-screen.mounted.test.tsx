/* eslint-disable max-lines -- one mounted suite covers both scopes: the role-gated row actions, the role notes, and the header subtitle */
// The integrations hub serves both scopes: the personal one shows every
// connection the account owns, and the organization one hides the actions the
// viewer's role cannot take. The states below are the ones the screen owns —
// connected, empty, retryable failure, permission loss and an unresolved scope.

import { type ComponentType, createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { IntegrationsScreen } from './integrations-screen';

type SetupStatusRow = { platform: string; installed: boolean; installation?: unknown };

const ROW_NOTE = 'Ask an organization owner or admin to change this connection.';
// Bitbucket's page admits owners and billing managers, so its row cannot use
// the ask-form: the note names the set that can change it.
const BITBUCKET_NOTE = 'Only organization owners and billing managers can change this connection.';

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
  role: undefined as string | undefined,
  orgResolved: true,
  permissionDenied: false,
}));
const calls = vi.hoisted(() => ({
  connect: vi.fn<(provider: string) => void>(),
  disconnect:
    vi.fn<(variables: { provider: string; githubIntegrationId: string | null }) => void>(),
  confirm: vi.fn<(request: { title: string; onConfirm: () => void }) => void>(),
  refetch: vi.fn<() => void>(),
  openExternal: vi.fn<(url: string) => void>(),
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

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: () => ({
    role: state.role,
    org: state.orgResolved ? { organizationId: 'org-1', organizationName: 'Acme' } : undefined,
    isResolving: false,
  }),
}));

vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({
  useRouteForegroundRefresh: () => undefined,
}));

vi.mock('@/lib/trpc-error', () => ({
  isPermissionDeniedError: () => state.permissionDenied,
  trpcErrorVariant: () => 'server',
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
// button instead of inspecting the trailing element it was handed.
vi.mock('@/components/ui/configure-row', () => ({
  ConfigureRow: (props: {
    title?: string;
    subtitle?: string;
    note?: string;
    trailing?: ReactNode;
  }) =>
    createElement(
      'RowMock',
      { title: props.title, subtitle: props.subtitle, note: props.note },
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
vi.mock('react-native', () => ({ View: 'View' }));
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
  });
  mounted = undefined;
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
  state.statuses = statusState();
  state.githubConnections = { data: [], isPending: false };
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

  it('says nothing is connected yet when every status is empty', () => {
    const renderer = mount();
    expect(texts(renderer.root)).toContain('No integrations connected yet.');
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
    const renderer = mount('org-1');
    const root = renderer.root;

    expect(actionOf(rowTitled(root, 'GitHub'))?.props.accessibilityLabel).toBe(
      'Manage on the web. GitHub'
    );
    const bitbucket = actionOf(rowTitled(root, 'Bitbucket'));
    expect(bitbucket?.props.accessibilityLabel).toBe('Manage on the web. Bitbucket');
    press(bitbucket);
    expect(calls.openExternal).toHaveBeenCalledWith(
      expect.stringContaining('/organizations/org-1/integrations/bitbucket')
    );
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
    expect(calls.disconnect).toHaveBeenCalledWith({ provider: 'slack', githubIntegrationId: null });
  });

  it('gives every blocked row the ask-form note, and Bitbucket its own set', () => {
    state.role = 'member';
    state.statuses.data = [
      { platform: 'github', installed: true, installation: { accountLogin: 'acme' } },
      { platform: 'slack', installed: true, installation: { teamName: 'Acme Slack' } },
      { platform: 'gitlab', installed: true, installation: { accountLogin: 'acme' } },
      { platform: 'bitbucket', installed: true, installation: { accountLogin: 'workspace' } },
    ];
    const renderer = mount('org-1');
    const root = renderer.root;

    // The manage and billing sets both admit an owner or an admin, so their
    // rows ask for one; Bitbucket's page turns an admin away, so that row names
    // the narrower set. No sentence above the rows contradicts either.
    for (const title of ['GitHub', 'Slack', 'GitLab', 'Linear']) {
      expect(actionOf(rowTitled(root, title))).toBeNull();
      expect(rowTitled(root, title).props.note).toBe(ROW_NOTE);
    }
    expect(actionOf(rowTitled(root, 'Bitbucket'))).toBeNull();
    expect(rowTitled(root, 'Bitbucket').props.note).toBe(BITBUCKET_NOTE);
    expect(texts(root)).not.toContain(ROW_NOTE);
  });

  it('lets a member make the first GitLab connect without a note on that row', () => {
    state.role = 'member';
    state.statuses.data = [
      { platform: 'github', installed: true, installation: { accountLogin: 'acme' } },
      { platform: 'bitbucket', installed: true, installation: { accountLogin: 'workspace' } },
    ];
    const renderer = mount('org-1');
    const root = renderer.root;

    // `resolveGitLabOAuthOwner` only needs billing roles to replace an existing
    // integration, so a member's first connect is accepted and its row says
    // nothing: a note there would contradict the action it offers.
    expect(actionOf(rowTitled(root, 'GitLab'))?.props.accessibilityLabel).toBe('Connect. GitLab');
    expect(rowTitled(root, 'GitLab').props.note).toBeUndefined();
    expect(texts(root)).not.toContain(ROW_NOTE);
  });

  it('offers every row to an owner and leaves each row quiet', () => {
    state.role = 'owner';
    state.statuses.data = [
      { platform: 'slack', installed: true, installation: { teamName: 'Acme' } },
    ];
    const root = mount('org-1').root;

    expect(findOne(root, 'RowMock').every(row => actionOf(row) != null)).toBe(true);
    expect(findOne(root, 'RowMock').every(row => row.props.note === undefined)).toBe(true);
    expect(texts(root)).not.toContain(ROW_NOTE);
  });

  it('names the owners-and-billing set on the Bitbucket row an admin cannot change', () => {
    state.role = 'admin';
    state.statuses.data = [
      { platform: 'bitbucket', installed: true, installation: { accountLogin: 'workspace' } },
    ];
    const root = mount('org-1').root;

    // Bitbucket's page admits no admin, so the manage set's "owner or admin"
    // sentence would send one to a role that cannot change it.
    expect(actionOf(rowTitled(root, 'Bitbucket'))).toBeNull();
    expect(rowTitled(root, 'Bitbucket').props.note).toBe(BITBUCKET_NOTE);
  });

  it('leaves the Bitbucket row quiet for an owner, who is offered its action', () => {
    state.role = 'owner';
    state.statuses.data = [
      { platform: 'bitbucket', installed: true, installation: { accountLogin: 'workspace' } },
    ];
    const root = mount('org-1').root;

    expect(actionOf(rowTitled(root, 'Bitbucket'))).not.toBeNull();
    expect(rowTitled(root, 'Bitbucket').props.note).toBeUndefined();
  });

  it('never explains the rows in the personal scope', () => {
    state.role = 'member';
    state.statuses.data = [
      { platform: 'slack', installed: true, installation: { teamName: 'Acme' } },
    ];
    const root = mount().root;

    expect(findOne(root, 'RowMock').every(row => actionOf(row) != null)).toBe(true);
    expect(texts(root)).not.toContain(ROW_NOTE);
    // The personal scope belongs to the viewer, so no row is blocked.
    expect(findOne(root, 'RowMock').every(row => row.props.note === undefined)).toBe(true);
  });

  it('names the organization in the header of the organization scope', () => {
    state.role = 'member';
    const header = findOne(mount('org-1').root, 'ScreenHeaderMock')[0];

    expect(header?.props.title).toBe('Integrations');
    expect(header?.props.subtitle).toBe('Acme');
  });

  it('leaves the header subtitle empty in the personal scope', () => {
    const header = findOne(mount().root, 'ScreenHeaderMock')[0];

    expect(header?.props.title).toBe('Integrations');
    expect(header?.props.subtitle).toBeUndefined();
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
