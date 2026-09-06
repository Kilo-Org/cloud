import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildAppReturnOutcomeView,
  getGitHubUserConnectionErrorMessage,
  GitHubIntegrationDetails,
} from './GitHubIntegrationDetails';

jest.mock('@/lib/config.server', () => ({ NEXTAUTH_SECRET: 'synthetic-oauth-signing-secret' }));

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

const mockMint = jest.fn();
const mockButtons: Array<{ children?: React.ReactNode; onClick?: () => Promise<void> }> = [];

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
      ].map(name => [name, { queryOptions: () => ({}), mutationOptions: () => ({}) }])
    ),
  }),
}));
jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQuery: () => ({ data: undefined, isLoading: false, refetch: jest.fn() }),
  useMutation: () => ({ mutateAsync: mockMint, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));
jest.mock('@/app/api/organizations/hooks', () => ({ useOrganizationWithMembers: () => ({}) }));
jest.mock('@/app/api/openrouter/hooks', () => ({ useModelSelectorList: () => ({}) }));
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
