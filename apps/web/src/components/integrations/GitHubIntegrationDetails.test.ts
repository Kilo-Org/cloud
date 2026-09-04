import {
  buildAppReturnOutcomeView,
  getGitHubUserConnectionErrorMessage,
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
