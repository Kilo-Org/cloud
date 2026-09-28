import {
  assertGitHubInstallationRuntimeAuthorized,
  getGitHubRuntimeAssociationRejectionReason,
  GitHubRuntimeAuthorizationError,
  isGitHubRuntimeAssociationAuthorized,
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
    github_connection_role: 'workflow',
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

  it('preserves workflow authority regardless of legacy sharing mode', () => {
    expect(
      isGitHubRuntimeAssociationAuthorized({
        ...association,
        installation: { ...association.installation!, sharing_mode: 'web_cloud_agent' },
      })
    ).toBe(true);
  });

  it('rejects agent-only associations for workflow consumers', () => {
    const shared = {
      ...association,
      integration: { ...association.integration, github_connection_role: 'agent_only' as const },
      installation: { ...association.installation!, sharing_mode: 'web_cloud_agent' as const },
    };
    expect(isGitHubRuntimeAssociationAuthorized(shared)).toBe(false);
    expect(isGitHubRuntimeAssociationAuthorized(shared, { purpose: 'workflow' })).toBe(false);
    expect(getGitHubRuntimeAssociationRejectionReason(shared)).toBe('sharing_not_allowed');
  });

  it('allows agent-only associations for trusted agent and management purposes', () => {
    const shared = {
      ...association,
      integration: { ...association.integration, github_connection_role: 'agent_only' as const },
      installation: { ...association.installation!, sharing_mode: 'web_cloud_agent' as const },
    };
    expect(isGitHubRuntimeAssociationAuthorized(shared, { purpose: 'agent' })).toBe(true);
    expect(
      getGitHubRuntimeAssociationRejectionReason(shared, { purpose: 'management' })
    ).toBeNull();
  });

  it('still enforces lifecycle health for agent consumers', () => {
    expect(isGitHubRuntimeAssociationAuthorized(association, { purpose: 'agent' })).toBe(true);
    expect(
      isGitHubRuntimeAssociationAuthorized(
        {
          ...association,
          installation: { ...association.installation!, suspended_at: '2026-09-04' },
        },
        { purpose: 'agent' }
      )
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
  ['installation_unavailable', { ...association, installation: null }],
  [
    'installation_unavailable',
    {
      ...association,
      installation: { ...association.installation, lifecycle_state: 'suspended' },
    },
  ],
  [
    'sharing_not_allowed',
    {
      ...association,
      integration: { ...association.integration, github_connection_role: 'agent_only' },
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
    'rejects an unhealthy canonical installation regardless of %s lifecycle state',
    lifecycle_state => {
      expect(
        isGitHubRuntimeAssociationAuthorized({
          ...association,
          installation: {
            lifecycle_state,
            sharing_mode: 'exclusive',
            suspended_at: '2026-09-04',
            deleted_at: '2026-09-04',
            auth_invalid_at: '2026-09-04',
          },
        })
      ).toBe(false);
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
  ])('rejects %s with safe context using a bounded query', async (reason, rows) => {
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
    // Called twice: once for the outer association query, once for the notExists
    // canonical-installation subquery that guards unbound associations against shadowing an
    // already-canonicalized installation.
    expect(db.select).toHaveBeenCalledTimes(2);
    expect(limit).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledWith(2);
  });

  it('narrows to a single candidate row when an exact expectedIntegrationId is supplied', async () => {
    const limit = jest.fn().mockResolvedValue([association]);
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

    await assertGitHubInstallationRuntimeAuthorized('installation-1', 'lite', 'integration-1');

    expect(limit).toHaveBeenCalledWith(1);
  });

  it('treats an empty-string expectedIntegrationId as the generic, non-exact path', async () => {
    const limit = jest.fn().mockResolvedValue([association]);
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

    await assertGitHubInstallationRuntimeAuthorized('installation-1', 'lite', '');

    // An empty string is falsy, so it must behave exactly like "no expectedIntegrationId"
    // (the generic, exclusive-only path) rather than being treated as an exact id to match.
    expect(limit).toHaveBeenCalledWith(2);
  });

  it('requires both an exact association and trusted purpose for secondary runtime access', async () => {
    const sharedAssociation = {
      ...association,
      integration: { ...association.integration, github_connection_role: 'agent_only' as const },
      installation: { ...association.installation!, sharing_mode: 'web_cloud_agent' as const },
    };
    const query = {
      from: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([sharedAssociation]),
    };
    jest
      .mocked(db.select)
      .mockClear()
      .mockReturnValue(query as never);

    await expect(
      assertGitHubInstallationRuntimeAuthorized('installation-1', 'lite', 'integration-1', 'agent')
    ).resolves.toBeUndefined();
    await expect(
      assertGitHubInstallationRuntimeAuthorized('installation-1', 'lite', 'integration-1')
    ).rejects.toMatchObject({ reason: 'sharing_not_allowed' });
    await expect(
      assertGitHubInstallationRuntimeAuthorized('installation-1', 'lite', undefined, 'agent')
    ).rejects.toMatchObject({ reason: 'sharing_not_allowed' });
  });

  it('rejects a shared canonical installation on the generic (no exact id) path', async () => {
    const sharedAssociation = {
      ...association,
      integration: { ...association.integration, github_connection_role: 'agent_only' as const },
      installation: { ...association.installation!, sharing_mode: 'web_cloud_agent' as const },
    };
    const query = {
      from: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([sharedAssociation]),
    };
    jest
      .mocked(db.select)
      .mockClear()
      .mockReturnValue(query as never);

    await expect(
      assertGitHubInstallationRuntimeAuthorized('installation-1', 'lite')
    ).rejects.toMatchObject({ reason: 'sharing_not_allowed' });
  });
});
