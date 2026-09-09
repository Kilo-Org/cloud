import { isGitHubRuntimeAssociationAuthorized } from './runtime-authorization';

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
