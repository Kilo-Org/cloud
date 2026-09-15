import {
  GitHubRuntimeAuthorizationError,
  getGitHubRuntimeAssociationDenialReason,
  isGitHubRuntimeAssociationAuthorized,
  isUnexpectedGitHubRuntimeAuthorizationDenial,
} from './runtime-authorization';

const association = {
  integration: {
    owned_by_user_id: 'user-1',
    owned_by_organization_id: null,
    integration_status: 'active',
    suspended_at: null,
    auth_invalid_at: null,
    github_disconnected_at: null,
    github_installation_id: null,
  },
  installation: null,
  organizationDeletedAt: null,
  userRecordId: 'user-1',
  userBlockedReason: null,
} as const;

describe('isGitHubRuntimeAssociationAuthorized', () => {
  it('allows a healthy legacy association while canonical data remains shadow state', () => {
    expect(isGitHubRuntimeAssociationAuthorized(association)).toBe(true);
  });

  it('denies a locally disconnected association', () => {
    expect(
      isGitHubRuntimeAssociationAuthorized({
        ...association,
        integration: {
          ...association.integration,
          github_disconnected_at: '2026-09-04T00:00:00.000Z',
        },
      })
    ).toBe(false);
  });

  it('denies a blocked personal owner', () => {
    expect(
      isGitHubRuntimeAssociationAuthorized({ ...association, userBlockedReason: 'blocked' })
    ).toBe(false);
  });

  it('denies deleted owners while canonical storage remains shadow data', () => {
    expect(
      isGitHubRuntimeAssociationAuthorized({
        ...association,
        integration: {
          ...association.integration,
          owned_by_user_id: null,
          owned_by_organization_id: 'org-1',
        },
        organizationDeletedAt: '2026-09-04T00:00:00.000Z',
      })
    ).toBe(false);
    expect(
      isGitHubRuntimeAssociationAuthorized({
        ...association,
        installation: {
          lifecycle_state: 'suspended',
          suspended_at: '2026-09-04T00:00:00.000Z',
          deleted_at: null,
          auth_invalid_at: null,
        },
      })
    ).toBe(true);
  });
});

describe('getGitHubRuntimeAssociationDenialReason', () => {
  it('returns no reason for an authorized association', () => {
    expect(getGitHubRuntimeAssociationDenialReason(association)).toBeNull();
  });

  it('reports a missing association', () => {
    expect(getGitHubRuntimeAssociationDenialReason(null)).toBe('missing_association');
    expect(getGitHubRuntimeAssociationDenialReason(undefined)).toBe('missing_association');
  });

  it('reports an invalid owner', () => {
    expect(
      getGitHubRuntimeAssociationDenialReason({ ...association, userRecordId: 'other-user' })
    ).toBe('invalid_owner');
    expect(
      getGitHubRuntimeAssociationDenialReason({ ...association, userBlockedReason: 'blocked' })
    ).toBe('invalid_owner');
    expect(
      getGitHubRuntimeAssociationDenialReason({
        ...association,
        integration: {
          ...association.integration,
          owned_by_user_id: null,
          owned_by_organization_id: 'org-1',
        },
        organizationDeletedAt: '2026-09-04T00:00:00.000Z',
      })
    ).toBe('invalid_owner');
  });

  it('reports an unhealthy integration for every health signal', () => {
    expect(
      getGitHubRuntimeAssociationDenialReason({
        ...association,
        integration: { ...association.integration, integration_status: 'suspended' },
      })
    ).toBe('unhealthy_integration');
    expect(
      getGitHubRuntimeAssociationDenialReason({
        ...association,
        integration: {
          ...association.integration,
          github_disconnected_at: '2026-09-04T00:00:00.000Z',
        },
      })
    ).toBe('unhealthy_integration');
    expect(
      getGitHubRuntimeAssociationDenialReason({
        ...association,
        integration: { ...association.integration, suspended_at: '2026-09-04T00:00:00.000Z' },
      })
    ).toBe('unhealthy_integration');
    expect(
      getGitHubRuntimeAssociationDenialReason({
        ...association,
        integration: { ...association.integration, auth_invalid_at: '2026-09-04T00:00:00.000Z' },
      })
    ).toBe('unhealthy_integration');
  });
});

describe('isUnexpectedGitHubRuntimeAuthorizationDenial', () => {
  it('flags denial reasons that need investigation', () => {
    expect(
      isUnexpectedGitHubRuntimeAuthorizationDenial(
        new GitHubRuntimeAuthorizationError('ambiguous_association')
      )
    ).toBe(true);
    expect(
      isUnexpectedGitHubRuntimeAuthorizationDenial(
        new GitHubRuntimeAuthorizationError('invalid_owner')
      )
    ).toBe(true);
    expect(
      isUnexpectedGitHubRuntimeAuthorizationDenial(
        new GitHubRuntimeAuthorizationError('unhealthy_integration')
      )
    ).toBe(true);
  });

  it('does not flag a missing association or unrelated errors', () => {
    expect(
      isUnexpectedGitHubRuntimeAuthorizationDenial(
        new GitHubRuntimeAuthorizationError('missing_association')
      )
    ).toBe(false);
    expect(isUnexpectedGitHubRuntimeAuthorizationDenial(new Error('other'))).toBe(false);
    expect(isUnexpectedGitHubRuntimeAuthorizationDenial(null)).toBe(false);
  });
});
