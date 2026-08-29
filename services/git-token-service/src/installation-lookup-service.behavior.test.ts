import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkerDb } from '@kilocode/db/client';
import { InstallationLookupService } from './installation-lookup-service.js';

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(),
}));

const integrationId = '00000000-0000-4000-8000-000000000002';
const otherIntegrationId = '00000000-0000-4000-8000-000000000003';
const orgId = '00000000-0000-4000-8000-000000000001';

type InstallationRow = {
  id: string;
  platform_installation_id: string;
  platform_account_login: string | null;
  github_app_type: 'standard' | 'lite' | null;
  owned_by_organization_id: string | null;
  owned_by_user_id: string | null;
  integration_status?: string;
  repository_access?: string | null;
  repositories?: { full_name: string }[] | null;
  permissions?: Record<string, unknown> | null;
};

function createDb(rows: InstallationRow[], updatedRows = [{ id: 'integration-1' }]) {
  const query = {
    from: vi.fn(() => query),
    leftJoin: vi.fn(() => query),
    innerJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn((limit: number) => Promise.resolve(rows.slice(0, limit))),
    then: vi.fn((resolve: (value: InstallationRow[]) => unknown) => resolve(rows)),
  };
  const updateQuery = {
    set: vi.fn(() => updateQuery),
    where: vi.fn(() => updateQuery),
    returning: vi.fn(async () => updatedRows),
  };

  return {
    select: vi.fn(() => query),
    update: vi.fn(() => updateQuery),
    updateQuery,
  };
}

function createService(rows: InstallationRow[]) {
  vi.mocked(getWorkerDb).mockReturnValue(createDb(rows) as never);
  return new InstallationLookupService({
    HYPERDRIVE: { connectionString: 'postgres://test' },
  } as CloudflareEnv);
}

describe('InstallationLookupService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('fails closed when multiple active personal installations match the requested owner', async () => {
    const service = createService([
      {
        id: integrationId,
        platform_installation_id: '100',
        platform_account_login: 'old-owner',
        github_app_type: 'standard',
        owned_by_organization_id: null,
        owned_by_user_id: 'user-1',
      },
      {
        id: otherIntegrationId,
        platform_installation_id: '200',
        platform_account_login: 'other-owner',
        github_app_type: 'lite',
        owned_by_organization_id: null,
        owned_by_user_id: 'user-1',
      },
    ]);

    const result = await service.findInstallationId({
      githubRepo: 'renamed-owner/repository',
      userId: 'user-1',
    });

    expect(result).toEqual({ success: false, reason: 'ambiguous_installation' });
  });

  it('returns stale authorized installations as login refresh candidates', async () => {
    const service = createService([
      {
        id: 'integration-1',
        platform_installation_id: '100',
        platform_account_login: 'pre-rename-owner',
        github_app_type: null,
        owned_by_organization_id: null,
        owned_by_user_id: 'user-1',
      },
    ]);

    const result = await service.findRefreshCandidates({
      githubRepo: 'renamed-owner/repository',
      userId: 'user-1',
    });

    expect(result).toEqual({
      success: true,
      candidates: [
        {
          integrationId: 'integration-1',
          installationId: '100',
          accountLogin: 'pre-rename-owner',
          githubAppType: 'standard',
        },
      ],
    });
  });

  it('reports when refreshed account login metadata is persisted', async () => {
    const db = createDb([]);
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const service = new InstallationLookupService({
      HYPERDRIVE: { connectionString: 'postgres://test' },
    } as CloudflareEnv);

    const wasUpdated = await service.updateAccountLogin('integration-1', 'renamed-owner');

    expect(wasUpdated).toBe(true);
    expect(db.updateQuery.set).toHaveBeenCalledWith(
      expect.objectContaining({ platform_account_login: 'renamed-owner' })
    );
    expect(db.updateQuery.where).toHaveBeenCalled();
  });

  it('reports when refreshed account login metadata no longer has a target row', async () => {
    const db = createDb([], []);
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const service = new InstallationLookupService({
      HYPERDRIVE: { connectionString: 'postgres://test' },
    } as CloudflareEnv);

    const wasUpdated = await service.updateAccountLogin('integration-1', 'renamed-owner');

    expect(wasUpdated).toBe(false);
    expect(db.updateQuery.returning).toHaveBeenCalled();
  });

  it('resolves an exact-login integration using the legacy standard app type', async () => {
    const service = createService([
      {
        id: integrationId,
        platform_installation_id: '100',
        platform_account_login: 'renamed-owner',
        github_app_type: null,
        owned_by_organization_id: null,
        owned_by_user_id: 'user-1',
      },
    ]);

    const result = await service.findInstallationId({
      githubRepo: 'renamed-owner/repository',
      userId: 'user-1',
    });

    expect(result).toEqual({
      success: true,
      integrationId,
      integrationOwner: { type: 'user', id: 'user-1' },
      installationId: '100',
      accountLogin: 'renamed-owner',
      githubAppType: 'standard',
    });
  });

  it('rejects selected repository metadata for a different owner', async () => {
    const service = createService([
      {
        id: integrationId,
        platform_installation_id: '100',
        platform_account_login: 'renamed-owner',
        github_app_type: 'standard',
        owned_by_organization_id: null,
        owned_by_user_id: 'user-1',
        repository_access: 'selected',
        repositories: [{ full_name: 'other-owner/repository' }],
        permissions: { contents: 'write', pull_requests: 'write' },
      },
    ]);

    const result = await service.findManagedInstallationForRepo({
      githubRepo: 'renamed-owner/repository',
      userId: 'user-1',
    });

    expect(result).toEqual({ success: false, reason: 'repository_not_installed' });
  });

  it('fails closed when organization and personal installations both match the requested owner', async () => {
    const service = createService([
      {
        id: integrationId,
        platform_installation_id: 'org-installation',
        platform_account_login: 'organization-owner',
        github_app_type: 'standard',
        owned_by_organization_id: orgId,
        owned_by_user_id: null,
      },
      {
        id: otherIntegrationId,
        platform_installation_id: 'personal-installation',
        platform_account_login: 'personal-owner',
        github_app_type: 'lite',
        owned_by_organization_id: null,
        owned_by_user_id: 'user-1',
      },
    ]);

    const result = await service.findInstallationId({
      githubRepo: 'renamed-owner/repository',
      userId: 'user-1',
      orgId,
    });

    expect(result).toEqual({ success: false, reason: 'ambiguous_installation' });
  });

  it('fails closed when multiple active organization installations match the requested owner', async () => {
    const service = createService([
      {
        id: integrationId,
        platform_installation_id: 'org-installation-1',
        platform_account_login: 'organization-owner',
        github_app_type: 'standard',
        owned_by_organization_id: orgId,
        owned_by_user_id: null,
      },
      {
        id: otherIntegrationId,
        platform_installation_id: 'org-installation-2',
        platform_account_login: 'organization-owner',
        github_app_type: 'standard',
        owned_by_organization_id: orgId,
        owned_by_user_id: null,
      },
    ]);

    const result = await service.findInstallationId({
      githubRepo: 'renamed-owner/repository',
      userId: 'user-1',
      orgId,
    });

    expect(result).toEqual({ success: false, reason: 'ambiguous_installation' });
  });

  describe.each(['findInstallationId', 'findManagedInstallationForRepo'] as const)('%s', method => {
    describe.each([undefined, orgId])('owner scope %s', requestedOrgId => {
      const params = {
        githubRepo: 'renamed-owner/repository',
        userId: 'oauth/personal-owner',
        ...(requestedOrgId === undefined ? {} : { orgId: requestedOrgId }),
      };
      const row: InstallationRow = {
        id: integrationId,
        platform_installation_id: '100',
        platform_account_login: 'renamed-owner',
        github_app_type: 'lite',
        integration_status: 'active',
        owned_by_organization_id: requestedOrgId ?? null,
        owned_by_user_id: requestedOrgId === undefined ? params.userId : null,
        repository_access: 'selected',
        repositories: [{ full_name: 'Renamed-Owner/Repository' }],
        permissions: { contents: 'read' },
      };
      const integrationOwner =
        requestedOrgId === undefined
          ? { type: 'user' as const, id: params.userId }
          : { type: 'org' as const, id: requestedOrgId };
      const expectedSuccess = {
        success: true,
        integrationId,
        integrationOwner,
        installationId: '100',
        accountLogin: 'renamed-owner',
        githubAppType: 'lite',
        ...(method === 'findManagedInstallationForRepo'
          ? { repoName: 'repository', permissions: { contents: 'read' } }
          : {}),
      };

      it('returns the resolved identity for a legacy unpinned request', async () => {
        await expect(createService([row])[method](params)).resolves.toEqual(expectedSuccess);
      });

      it.each(['selected', 'all'])(
        'resolves an exact active integration with %s access',
        async repositoryAccess => {
          const service = createService([{ ...row, repository_access: repositoryAccess }]);
          await expect(
            service[method]({ ...params, expectedIntegrationId: integrationId })
          ).resolves.toEqual(expectedSuccess);
        }
      );

      it('returns the database owner for a legacy organization session and its explicit retry', async () => {
        const service = createService([row]);
        await expect(service[method]({ ...params, orgId })).resolves.toEqual(expectedSuccess);
        await expect(
          service[method]({
            ...params,
            orgId,
            expectedIntegrationId: integrationId,
            expectedIntegrationOwner: integrationOwner,
          })
        ).resolves.toEqual(expectedSuccess);
      });

      it('requires an integration pin with an explicit owner', async () => {
        await expect(
          createService([row])[method]({
            ...params,
            expectedIntegrationOwner: integrationOwner,
          })
        ).resolves.toEqual({ success: false, reason: 'integration_mismatch' });
      });

      it('rejects an explicit owner outside the caller or session context', async () => {
        await expect(
          createService([row])[method]({
            ...params,
            ...(integrationOwner.type === 'user'
              ? { userId: 'oauth/another-user' }
              : { orgId: undefined }),
            expectedIntegrationId: integrationId,
            expectedIntegrationOwner: integrationOwner,
          })
        ).resolves.toEqual({ success: false, reason: 'integration_mismatch' });
      });

      it('rejects an explicit organization owner from another session organization', async () => {
        const otherOrgId = '00000000-0000-4000-8000-000000000099';
        await expect(
          createService([
            {
              ...row,
              owned_by_organization_id: otherOrgId,
              owned_by_user_id: null,
            },
          ])[method]({
            ...params,
            orgId,
            expectedIntegrationId: integrationId,
            expectedIntegrationOwner: { type: 'org', id: otherOrgId },
          })
        ).resolves.toEqual({ success: false, reason: 'integration_mismatch' });
      });

      it('rejects unrecognized fields in an explicit owner', async () => {
        const expectedIntegrationOwner = { ...integrationOwner, unknown: true };
        await expect(
          createService([row])[method]({
            ...params,
            expectedIntegrationId: integrationId,
            expectedIntegrationOwner,
          })
        ).resolves.toEqual({ success: false, reason: 'integration_mismatch' });
      });

      it.each<[string, Partial<InstallationRow>]>([
        ['different integration', { id: otherIntegrationId }],
        [
          'wrong organization',
          { owned_by_organization_id: '00000000-0000-4000-8000-000000000099' },
        ],
        ['wrong personal owner', { owned_by_user_id: 'oauth/another-user' }],
        ['suspended row', { integration_status: 'suspended' }],
        ['repository owner mismatch', { platform_account_login: 'other-owner' }],
        [
          'selected repository mismatch',
          { repositories: [{ full_name: 'renamed-owner/other-repository' }] },
        ],
        ['missing repository access', { repository_access: null }],
      ])('rejects an expected integration with %s', async (_reason, override) => {
        for (const expectedIntegrationOwner of [undefined, integrationOwner]) {
          await expect(
            createService([{ ...row, ...override }])[method]({
              ...params,
              ...(expectedIntegrationOwner === undefined ? {} : { orgId }),
              expectedIntegrationId: integrationId,
              expectedIntegrationOwner,
            })
          ).resolves.toEqual({ success: false, reason: 'integration_mismatch' });
        }
      });

      it('excludes the other owner scope even when the integration ID matches', async () => {
        const otherOwner =
          requestedOrgId === undefined
            ? { owned_by_organization_id: orgId, owned_by_user_id: null }
            : { owned_by_organization_id: null, owned_by_user_id: params.userId };
        await expect(
          createService([{ ...row, ...otherOwner }])[method]({
            ...params,
            expectedIntegrationId: integrationId,
          })
        ).resolves.toEqual({ success: false, reason: 'integration_mismatch' });
      });

      it('returns integration_mismatch when the expected row is not visible to the authorized query', async () => {
        await expect(
          createService([])[method]({ ...params, expectedIntegrationId: integrationId })
        ).resolves.toEqual({ success: false, reason: 'integration_mismatch' });
      });

      it('preserves the missing-installation error for legacy requests', async () => {
        await expect(createService([])[method](params)).resolves.toEqual({
          success: false,
          reason: 'no_installation_found',
        });
      });

      it('rejects ambiguous legacy integration selection', async () => {
        await expect(
          createService([row, { ...row, id: otherIntegrationId }])[method](params)
        ).resolves.toEqual({ success: false, reason: 'ambiguous_installation' });
      });

      it('rejects an invalid integration pin before querying', async () => {
        await expect(
          createService([row])[method]({ ...params, expectedIntegrationId: 'not-a-uuid' })
        ).resolves.toEqual({ success: false, reason: 'integration_mismatch' });
        expect(getWorkerDb).not.toHaveBeenCalled();
      });
    });
  });

  it.each(['owner/repository/extra', 'owner/', '/repository', 'owner//repository', 'owner'])(
    'rejects invalid repository path %s before querying integrations',
    async githubRepo => {
      const service = createService([]);

      const result = await service.findInstallationId({ githubRepo, userId: 'user-1' });

      expect(result).toEqual({ success: false, reason: 'invalid_repo_format' });
      expect(getWorkerDb).not.toHaveBeenCalled();
    }
  );
});
