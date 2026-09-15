import {
  assertGitHubInstallationRuntimeAuthorized,
  getGitHubRuntimeAssociationRejectionReason,
  GitHubRuntimeAuthorizationError,
  isGitHubRuntimeAssociationAuthorized,
  isUnexpectedGitHubRuntimeAuthorizationDenial,
} from './runtime-authorization';
import { db } from '@/lib/drizzle';

jest.mock('@/lib/drizzle', () => ({ db: { select: jest.fn() } }));

const association = {
  integration: {
    id: 'integration-1',
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

const rejectionCases = [
  ['missing_association', null],
  [
    'malformed_owner',
    { ...association, integration: { ...association.integration, owned_by_user_id: null } },
  ],
  [
    'malformed_owner',
    {
      ...association,
      integration: { ...association.integration, owned_by_organization_id: 'org-1' },
    },
  ],
  ['missing_personal_owner', { ...association, userRecordId: null }],
  ['missing_personal_owner', { ...association, userRecordId: 'different-user' }],
  ['blocked_personal_owner', { ...association, userBlockedReason: 'sensitive blocked reason' }],
  [
    'deleted_organization',
    {
      ...association,
      integration: {
        ...association.integration,
        owned_by_user_id: null,
        owned_by_organization_id: 'org-1',
      },
      organizationDeletedAt: '2026-09-04',
    },
  ],
  [
    'integration_status',
    { ...association, integration: { ...association.integration, integration_status: null } },
  ],
  [
    'integration_status',
    {
      ...association,
      integration: { ...association.integration, integration_status: 'suspended' },
    },
  ],
  [
    'suspended',
    { ...association, integration: { ...association.integration, suspended_at: '2026-09-04' } },
  ],
  [
    'auth_invalid',
    { ...association, integration: { ...association.integration, auth_invalid_at: '2026-09-04' } },
  ],
  [
    'disconnected',
    {
      ...association,
      integration: { ...association.integration, github_disconnected_at: '2026-09-04' },
    },
  ],
] as const;

describe('runtime rejection diagnostics', () => {
  it.each(rejectionCases)('explains %s without changing rejection', (reason, candidate) => {
    expect(getGitHubRuntimeAssociationRejectionReason(candidate)).toBe(reason);
    expect(isGitHubRuntimeAssociationAuthorized(candidate)).toBe(false);
  });

  it.each([
    ['suspended_at', false],
    ['auth_invalid_at', false],
    ['github_disconnected_at', true],
  ] as const)('preserves undefined semantics for %s', (field, accepted) => {
    const candidate = {
      ...association,
      integration: { ...association.integration, [field]: undefined },
    };
    expect(isGitHubRuntimeAssociationAuthorized(candidate)).toBe(accepted);
  });

  it('preserves org acceptance when the left join has no deletion timestamp', () => {
    expect(
      isGitHubRuntimeAssociationAuthorized({
        ...association,
        integration: {
          ...association.integration,
          owned_by_user_id: null,
          owned_by_organization_id: 'org-1',
        },
        userRecordId: null,
      })
    ).toBe(true);
  });

  it.each(['unknown', 'active', 'suspended', 'deleted'] as const)(
    'ignores canonical %s lifecycle and health markers',
    lifecycle_state => {
      expect(
        isGitHubRuntimeAssociationAuthorized({
          ...association,
          installation: {
            lifecycle_state,
            suspended_at: '2026-09-04',
            deleted_at: '2026-09-04',
            auth_invalid_at: '2026-09-04',
          },
        })
      ).toBe(true);
    }
  );

  it.each([
    ...rejectionCases.map(([reason, candidate]) => [reason, candidate ? [candidate] : []] as const),
    [
      'ambiguous_association',
      [
        association,
        { ...association, integration: { ...association.integration, id: 'integration-2' } },
      ],
    ] as const,
  ])('rejects %s with safe context using one bounded query', async (reason, rows) => {
    const limit = jest.fn().mockResolvedValue(rows);
    const query = {
      from: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit,
    };
    jest
      .mocked(db.select)
      .mockClear()
      .mockReturnValue(query as never);
    const result = assertGitHubInstallationRuntimeAuthorized('installation-1', 'lite');
    await expect(result).rejects.toBeInstanceOf(GitHubRuntimeAuthorizationError);
    await expect(result).rejects.toMatchObject({
      message: 'GitHub installation is unavailable for runtime use',
      reason,
      diagnostics: {
        installationId: 'installation-1',
        appType: 'lite',
        integrationIds: rows.map(row => row.integration.id),
      },
    });
    await result.catch(error => {
      expect(Object.keys(error.diagnostics).sort()).toEqual([
        'appType',
        'installationId',
        'integrationIds',
      ]);
      expect(JSON.stringify(error)).not.toContain('sensitive blocked reason');
    });
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledWith(2);
  });
});

describe('isUnexpectedGitHubRuntimeAuthorizationDenial', () => {
  it.each([
    'ambiguous_association',
    'malformed_owner',
    'missing_personal_owner',
    'blocked_personal_owner',
    'deleted_organization',
    'integration_status',
    'suspended',
    'auth_invalid',
    'disconnected',
  ] as const)('reports %s', reason => {
    expect(
      isUnexpectedGitHubRuntimeAuthorizationDenial(new GitHubRuntimeAuthorizationError(reason))
    ).toBe(true);
  });

  it('does not report a missing association, an unclassified denial, or unrelated errors', () => {
    expect(
      isUnexpectedGitHubRuntimeAuthorizationDenial(
        new GitHubRuntimeAuthorizationError('missing_association')
      )
    ).toBe(false);
    expect(
      isUnexpectedGitHubRuntimeAuthorizationDenial(new GitHubRuntimeAuthorizationError())
    ).toBe(false);
    expect(isUnexpectedGitHubRuntimeAuthorizationDenial(new Error('other'))).toBe(false);
    expect(isUnexpectedGitHubRuntimeAuthorizationDenial(null)).toBe(false);
  });
});
