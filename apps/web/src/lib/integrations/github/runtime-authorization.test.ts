import { isGitHubRuntimeAssociationAuthorized } from './runtime-authorization';

const association = {
  integration: {
    owned_by_user_id: 'user-1',
    owned_by_organization_id: null,
    integration_status: 'active',
    suspended_at: null,
    auth_invalid_at: null,
    github_disconnected_at: null,
    github_installation_id: '00000000-0000-4000-8000-000000000001',
  },
  installation: {
    lifecycle_state: 'active',
    sharing_mode: 'exclusive',
    suspended_at: null,
    deleted_at: null,
    auth_invalid_at: null,
  },
  organizationDeletedAt: null,
  userRecordId: 'user-1',
  userBlockedReason: null,
} as const;

describe('isGitHubRuntimeAssociationAuthorized', () => {
  it('allows a healthy association with an active canonical installation', () => {
    expect(isGitHubRuntimeAssociationAuthorized(association)).toBe(true);
  });

  it('rejects a shared canonical installation on generic runtime paths', () => {
    expect(
      isGitHubRuntimeAssociationAuthorized({
        ...association,
        installation: { ...association.installation!, sharing_mode: 'web_cloud_agent' },
      })
    ).toBe(false);
  });

  it('preserves an unbound healthy legacy association without accepting a broken canonical link', () => {
    expect(
      isGitHubRuntimeAssociationAuthorized({
        ...association,
        integration: { ...association.integration, github_installation_id: null },
        installation: null,
      })
    ).toBe(true);
    expect(isGitHubRuntimeAssociationAuthorized({ ...association, installation: null })).toBe(
      false
    );
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

  it('denies deleted owners and unhealthy canonical installations', () => {
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
          sharing_mode: 'exclusive',
          suspended_at: '2026-09-04T00:00:00.000Z',
          deleted_at: null,
          auth_invalid_at: null,
        },
      })
    ).toBe(false);
  });
});
