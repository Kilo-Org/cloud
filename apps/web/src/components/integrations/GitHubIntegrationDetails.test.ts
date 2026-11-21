import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildAppReturnOutcomeView } from './github-app-outcome';
import {
  buildGitHubManagementInput,
  getGitHubUserConnectionErrorMessage,
  GitHubIntegrationDetails,
} from './GitHubIntegrationDetails';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'synthetic-oauth-signing-secret',
}));

describe('GitHub user-connect recovery copy', () => {
  test.each([
    'invalid_state',
    'connection_failed',
    'account_mismatch',
    'authorization_cancelled',
    'missing_code',
  ])('provides an actionable recovery for user-connect error %s only', error => {
    expect(getGitHubUserConnectionErrorMessage(error, 'user-connect')).toMatch(/new connection/);
    expect(getGitHubUserConnectionErrorMessage(error, null)).toBeNull();
    expect(getGitHubUserConnectionErrorMessage(error, 'installation')).toBeNull();
  });

  test('acknowledges cancellation and provides a fresh-start path', () => {
    expect(getGitHubUserConnectionErrorMessage('authorization_cancelled', 'user-connect')).toBe(
      'GitHub account authorization was cancelled. Start a new connection when you are ready.'
    );
  });

  test('explains an incomplete provider response without exposing an internal status code', () => {
    expect(getGitHubUserConnectionErrorMessage('missing_code', 'user-connect')).toBe(
      'GitHub did not return a valid authorization code. Start a new connection.'
    );
  });

  test('does not claim missing verifier state necessarily expired', () => {
    expect(getGitHubUserConnectionErrorMessage('invalid_state', 'user-connect')).not.toMatch(
      /expired/i
    );
  });

  test('explains the account binding without naming an account', () => {
    expect(getGitHubUserConnectionErrorMessage('account_mismatch', 'user-connect')).toBe(
      'Sign in to the Kilo account that started this GitHub connection, then start a new connection.'
    );
  });

  test.each([
    undefined,
    'installation_failed',
    'install_state_user_mismatch',
    'not_installation_admin',
  ])('leaves unrelated error presentation unchanged: %s', error => {
    expect(getGitHubUserConnectionErrorMessage(error, 'user-connect')).toBeNull();
  });
});

describe('GitHub installation management input', () => {
  test('targets the displayed personal installation', () => {
    expect(buildGitHubManagementInput(undefined, 'displayed-integration')).toEqual({
      integrationId: 'displayed-integration',
    });
  });

  test('keeps the personal fallback when no installation is displayed', () => {
    expect(buildGitHubManagementInput(undefined, undefined)).toBeUndefined();
  });

  test('keeps organization targeting unchanged', () => {
    expect(buildGitHubManagementInput('organization-id', 'displayed-integration')).toEqual({
      organizationId: 'organization-id',
      integrationId: 'displayed-integration',
    });
  });
});

const mockMint = jest.fn();
const mockButtons: Array<{ children?: React.ReactNode; onClick?: () => Promise<void> }> = [];
// Installation row the component under test sees. Undefined means "no
// installation" and keeps every existing test in this file on its current path.
const mockInstallationData: { value: unknown } = { value: undefined };
// The requester's own pending row, which is the only place a blocked request
// is visible: the installation lookup returns the organization's live row.
const mockPendingCheck: { value: unknown } = { value: undefined };

jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    githubApps: Object.fromEntries(
      [
        'getAppType',
        'getInstallation',
        'checkUserPendingInstallation',
        'getUserAuthorization',
        'connectUserAuthorization',
        'disconnectUserAuthorization',
        'uninstallApp',
        'cancelPendingInstallation',
        'refreshInstallation',
        'updateModel',
        'mintInstallState',
      ].map(name => [name, { queryOptions: () => ({ name }), mutationOptions: () => ({}) }])
    ),
  }),
}));
jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQuery: ({ name }: { name?: string } = {}) => ({
    data:
      name === 'getInstallation'
        ? mockInstallationData.value
        : name === 'checkUserPendingInstallation'
          ? mockPendingCheck.value
          : undefined,
    isLoading: false,
    refetch: jest.fn(),
  }),
  useMutation: () => ({ mutateAsync: mockMint, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));
jest.mock('@/app/api/organizations/hooks', () => ({ useOrganizationWithMembers: () => ({}) }));
jest.mock('@/lib/hooks/use-openrouter-models', () => ({ useModelSelectorList: () => ({}) }));
jest.mock('@/components/shared/ModelCombobox', () => ({
  ModelCombobox: () => null,
}));
jest.mock('@/components/ui/confirm', () => ({ useConfirm: () => jest.fn() }));
jest.mock('./DevAddGitHubInstallationCard', () => ({ DevAddGitHubInstallationCard: () => null }));
jest.mock('./OrganizationGitHubInstallations', () => ({
  OrganizationGitHubInstallations: () => null,
}));
jest.mock('@/components/ui/button', () => ({
  Button: (props: { children?: React.ReactNode; onClick?: () => Promise<void> }) => {
    mockButtons.push(props);
    return jest.requireActual<typeof React>('react').createElement('button', null, props.children);
  },
}));

describe('GitHubIntegrationDetails installation setup recovery', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const open = jest.fn();
  const location = { href: '' };

  beforeEach(() => {
    mockButtons.length = 0;
    mockMint.mockReset().mockResolvedValue({ token: 'fresh-install-token' });
    open.mockReset();
    location.href = '';
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { open, location } });
  });

  afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  function action(label: string) {
    const button = mockButtons.find(button =>
      renderToStaticMarkup(React.createElement(React.Fragment, null, button.children)).includes(
        label
      )
    );
    if (!button?.onClick) throw new Error(`Missing action: ${label}`);
    return button.onClick;
  }

  test('uses pre-minted state once and sends repeated clicks to neutral recovery without reminting', async () => {
    renderToStaticMarkup(
      React.createElement(GitHubIntegrationDetails, {
        installState: 'original-install-token',
        fromApp: true,
        appReturnPath: '/cloud/sessions',
        organizationId: 'synthetic-organization',
      })
    );
    const setup = action('Open GitHub setup');
    await Promise.all([setup(), setup(), setup()]);
    expect(open).toHaveBeenCalledTimes(1);
    const opened = new URL(open.mock.calls[0][0]);
    expect(opened.searchParams.get('state')).toBe('original-install-token');
    expect(mockMint).not.toHaveBeenCalled();
    expect(location.href).toBe('/github-app?error=install_state_invalid&fromApp=1');
    expect(location.href).not.toContain('original-install-token');
    expect(location.href).not.toContain('synthetic-organization');
  });

  test('a retry carrying pre-minted state cannot silently mint for a changed browser account', async () => {
    renderToStaticMarkup(
      React.createElement(GitHubIntegrationDetails, {
        installState: 'original-install-token',
        fromApp: true,
        appReturnPath: '/cloud/sessions',
        error: 'installation_failed',
      })
    );
    await action('Try again')();
    expect(mockMint).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(location.href).toBe('/github-app?error=install_state_invalid&fromApp=1');
  });

  test('an explicit retry without pre-minted state mints a fresh token', async () => {
    renderToStaticMarkup(
      React.createElement(GitHubIntegrationDetails, {
        fromApp: true,
        appReturnPath: '/cloud/sessions',
        error: 'installation_failed',
      })
    );
    await action('Try again')();
    expect(mockMint).toHaveBeenCalledWith({
      organizationId: undefined,
      returnTo: '/cloud/sessions',
    });
    expect(new URL(open.mock.calls[0][0]).searchParams.get('state')).toBe('fresh-install-token');
  });

  test.each([true, false])(
    'invalid-state landing explains recovery without inferring an owner (fromApp: %s)',
    fromApp => {
      const html = renderToStaticMarkup(
        React.createElement(GitHubIntegrationDetails, {
          error: 'install_state_invalid',
          fromApp,
          organizationId: 'untrusted-organization',
        })
      );
      expect(html).toContain('Restart GitHub setup');
      expect(html).toContain('has expired, has already been used, or is invalid');
      expect(html).toContain(
        fromApp ? '/cloud/sessions?error=install_state_unusable' : '/integrations'
      );
      expect(html).not.toContain('untrusted-organization');
      expect(mockMint).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    }
  );

  test('an unavailable installation landing names the state and offers no retry', () => {
    const html = renderToStaticMarkup(
      React.createElement(GitHubIntegrationDetails, {
        error: 'installation_unavailable',
        fromApp: true,
        appReturnPath: '/github-app?organizationId=synthetic-organization&fromApp=1',
        organizationId: 'synthetic-organization',
      })
    );
    expect(html).toContain('Cannot complete installation');
    expect(html).toContain(
      'This GitHub App installation is suspended or no longer available. Restore or reinstall it in GitHub, then start again.'
    );
    expect(html).toContain('/cloud/sessions?error=installation_unavailable');
    expect(html).not.toContain('another Kilo account');
    expect(html).not.toContain('Try again');
  });
});

describe('GitHubIntegrationDetails pending approval state', () => {
  // An app return path keeps this on the installation card rather than the
  // identity card, whose client the other suites below already exercise.
  function render(props: { fromApp?: boolean } = {}) {
    return renderToStaticMarkup(
      React.createElement(GitHubIntegrationDetails, {
        organizationId: 'organization-1',
        appReturnPath: '/cloud/sessions',
        ...props,
      })
    );
  }

  function blockedPendingCheck() {
    mockPendingCheck.value = {
      hasPending: true,
      pendingOrganizationId: 'organization-1',
      pendingIntegrationId: 'pending-integration',
      pendingApprovalStatus: 'blocked_by_existing_installation',
    };
  }

  afterEach(() => {
    mockInstallationData.value = undefined;
    mockPendingCheck.value = undefined;
  });

  it('names the remedy from the requester pending row, not from the live installation row', () => {
    // The organization holds its live installation, so the installation lookup
    // reports that row; only the pending check carries the refusal.
    mockInstallationData.value = {
      installed: true,
      installation: { id: 'live-integration', status: null },
    };
    blockedPendingCheck();

    const html = render();

    expect(html).toContain('This organization already has a GitHub installation.');
    expect(html).toContain(
      'An owner or admin must remove that installation in Kilo (Disconnect, or Uninstall GitHub App) before this request can complete.'
    );
    expect(html).toContain('cancel this request and start the connection again');
    expect(html).toContain('Cancel Request');
    expect(html).toContain('Installation Pending Admin Approval');
    expect(html).not.toContain('Waiting for organization admin approval');
    expect(html).not.toContain('Install Kilo GitHub App');
  });

  it('keeps the admin approval copy for a request still awaiting installation', () => {
    mockInstallationData.value = {
      installed: false,
      installation: { id: 'pending-integration', status: 'awaiting_installation' },
    };
    mockPendingCheck.value = {
      hasPending: true,
      pendingOrganizationId: 'organization-1',
      pendingIntegrationId: 'pending-integration',
      pendingApprovalStatus: 'awaiting_installation',
    };

    const html = render();

    expect(html).toContain(
      'Your installation request has been submitted to the GitHub organization administrators.'
    );
    expect(html).toContain('Waiting for organization admin approval');
    expect(html).not.toContain('already has a GitHub installation');
    expect(html).not.toContain('Install Kilo GitHub App');
  });

  it('shows the blocked remedy in the app return card instead of the install card', () => {
    // The organization's live installation is the row this lookup returns, so
    // the outcome card must not report success for the blocked request.
    mockInstallationData.value = {
      installed: true,
      installation: { id: 'live-integration', status: null },
    };
    blockedPendingCheck();

    const html = render({ fromApp: true });

    expect(html).toContain('Existing installation blocks this request');
    expect(html).toContain('already has a GitHub installation');
    expect(html).not.toContain('GitHub App installed');
    expect(html).not.toContain('Awaiting admin approval');
    expect(html).not.toContain('Open GitHub setup');
  });
});

describe('GitHubIntegrationDetails fromApp outcome CTA behavior', () => {
  it('success: Continue back to /cloud/sessions with github_install=success', () => {
    expect(buildAppReturnOutcomeView({ success: true })).toEqual({
      kind: 'installed',
      title: 'GitHub App installed',
      description: 'Your repositories are now connected.',
      cta: 'Continue',
      href: '/cloud/sessions?github_install=success',
    });
  });

  it('pending: Done back to /cloud/sessions with github_pending_approval=true', () => {
    expect(buildAppReturnOutcomeView({ pendingApproval: true })).toEqual({
      kind: 'pending',
      title: 'Awaiting admin approval',
      description: 'An organization admin must approve the installation request.',
      cta: 'Done',
      href: '/cloud/sessions?github_pending_approval=true',
    });
  });

  it('retryable failure: Try again with a return href that carries the error', () => {
    expect(buildAppReturnOutcomeView({ error: 'installation_failed' })).toEqual({
      kind: 'retryable',
      title: 'Installation failed',
      description: 'The installation did not complete. Try again or return to the Kilo App.',
      cta: 'Try again',
      href: '/cloud/sessions?error=installation_failed',
    });
  });

  it('retryable unknown error: keeps the raw code in the return href', () => {
    const view = buildAppReturnOutcomeView({ error: 'github_authorization_required' });
    expect(view.kind).toBe('retryable');
    expect(view.cta).toBe('Try again');
    expect(view.href).toBe('/cloud/sessions?error=github_authorization_required');
  });

  it('non-retryable admin error: Back and no retry', () => {
    expect(buildAppReturnOutcomeView({ error: 'not_installation_admin' })).toEqual({
      kind: 'blocked',
      title: 'Cannot complete installation',
      description:
        'Only a GitHub admin of that account can connect it. Ask an organization admin to install Kilo.',
      cta: 'Back',
      href: '/cloud/sessions?error=not_installation_admin',
    });
  });

  it('non-retryable claimed error: Back and no retry', () => {
    const view = buildAppReturnOutcomeView({ error: 'installation_already_claimed' });
    expect(view.kind).toBe('blocked');
    expect(view.cta).toBe('Back');
    expect(view.href).toBe('/cloud/sessions?error=installation_already_claimed');
  });

  it('non-retryable unavailable installation: names the state instead of another account', () => {
    const view = buildAppReturnOutcomeView({ error: 'installation_unavailable' });
    expect(view.kind).toBe('blocked');
    expect(view.cta).toBe('Back');
    expect(view.description).toBe(
      'This GitHub App installation is suspended or no longer available. Restore or reinstall it in GitHub, then start again.'
    );
    expect(view.description).not.toContain('another Kilo account');
    expect(view.href).toBe('/cloud/sessions?error=installation_unavailable');
  });

  it('non-retryable multiple-installation error: Back and no retry', () => {
    const view = buildAppReturnOutcomeView({ error: 'multiple_installations_disabled' });
    expect(view.kind).toBe('blocked');
    expect(view.cta).toBe('Back');
    expect(view.description).toBe(
      'This Kilo organization can currently connect only one GitHub organization.'
    );
  });

  it('non-retryable user mismatch: Back, no retry, mismatch copy preserved', () => {
    const view = buildAppReturnOutcomeView({ error: 'install_state_user_mismatch' });
    expect(view.kind).toBe('blocked');
    expect(view.cta).toBe('Back');
    expect(view.description).toContain('different account');
  });

  it('non-retryable start refusal: Back, no retry, names who can start the install', () => {
    const view = buildAppReturnOutcomeView({ error: 'installation_start_refused' });
    expect(view.kind).toBe('blocked');
    expect(view.cta).toBe('Back');
    expect(view.title).toBe('Cannot complete installation');
    expect(view.description).toBe(
      'This installation could not be started from this account. An organization owner or admin can start it; if the organization already holds its installation, they must remove that installation in Kilo first.'
    );
    expect(view.description).not.toContain('Try again');
    expect(view.href).toBe('/cloud/sessions?error=installation_start_refused');
  });

  it('success takes precedence over error, and pending over error (callback ordering)', () => {
    expect(buildAppReturnOutcomeView({ success: true, error: 'installation_failed' }).kind).toBe(
      'installed'
    );
    expect(
      buildAppReturnOutcomeView({ pendingApproval: true, error: 'installation_failed' }).kind
    ).toBe('pending');
  });

  it('org-scoped retryable failure: return href carries organizationId for app retry', () => {
    expect(
      buildAppReturnOutcomeView({ error: 'installation_failed', organizationId: 'org-123' })
    ).toEqual({
      kind: 'retryable',
      title: 'Installation failed',
      description: 'The installation did not complete. Try again or return to the Kilo App.',
      cta: 'Try again',
      href: '/cloud/sessions?error=installation_failed&organizationId=org-123',
    });
  });

  it('org-scoped success: return href carries organizationId', () => {
    expect(buildAppReturnOutcomeView({ success: true, organizationId: 'org-123' }).href).toBe(
      '/cloud/sessions?github_install=success&organizationId=org-123'
    );
  });

  it('org-scoped pending: return href carries organizationId', () => {
    expect(
      buildAppReturnOutcomeView({ pendingApproval: true, organizationId: 'org-123' }).href
    ).toBe('/cloud/sessions?github_pending_approval=true&organizationId=org-123');
  });

  it('org-scoped blocked: Back href carries organizationId, still no retry', () => {
    expect(
      buildAppReturnOutcomeView({ error: 'not_installation_admin', organizationId: 'org-123' })
    ).toEqual({
      kind: 'blocked',
      title: 'Cannot complete installation',
      description:
        'Only a GitHub admin of that account can connect it. Ask an organization admin to install Kilo.',
      cta: 'Back',
      href: '/cloud/sessions?error=not_installation_admin&organizationId=org-123',
    });
  });

  it('user-scoped outcomes omit organizationId from the return href', () => {
    expect(buildAppReturnOutcomeView({ error: 'installation_failed' }).href).toBe(
      '/cloud/sessions?error=installation_failed'
    );
    expect(buildAppReturnOutcomeView({ success: true }).href).toBe(
      '/cloud/sessions?github_install=success'
    );
  });
});
