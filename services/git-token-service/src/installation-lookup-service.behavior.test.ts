import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkerDb } from '@kilocode/db/client';
import { InstallationLookupService } from './installation-lookup-service.js';

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(),
}));

type InstallationRow = {
  id?: string;
  platform_installation_id: string;
  platform_account_login: string | null;
  github_app_type: 'standard' | 'lite' | null;
  owned_by_organization_id: string | null;
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
        platform_installation_id: '100',
        platform_account_login: 'old-owner',
        github_app_type: 'standard',
        owned_by_organization_id: null,
      },
      {
        platform_installation_id: '200',
        platform_account_login: 'other-owner',
        github_app_type: 'lite',
        owned_by_organization_id: null,
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
      },
    ]) as unknown as {
      findRefreshCandidates(params: { githubRepo: string; userId: string }): Promise<unknown>;
    };

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
        platform_installation_id: '100',
        platform_account_login: 'renamed-owner',
        github_app_type: null,
        owned_by_organization_id: null,
      },
    ]);

    const result = await service.findInstallationId({
      githubRepo: 'renamed-owner/repository',
      userId: 'user-1',
    });

    expect(result).toEqual({
      success: true,
      installationId: '100',
      accountLogin: 'renamed-owner',
      githubAppType: 'standard',
    });
  });

  it('accepts selected repository metadata with a stale owner after account rename', async () => {
    const service = createService([
      {
        platform_installation_id: '100',
        platform_account_login: 'renamed-owner',
        github_app_type: 'standard',
        owned_by_organization_id: null,
        repository_access: 'selected',
        repositories: [{ full_name: 'pre-rename-owner/repository' }],
        permissions: { contents: 'write', pull_requests: 'write' },
      },
    ]);

    const result = await service.findManagedInstallationForRepo({
      githubRepo: 'renamed-owner/repository',
      userId: 'user-1',
    });

    expect(result).toEqual({
      success: true,
      installationId: '100',
      accountLogin: 'renamed-owner',
      githubAppType: 'standard',
      repoName: 'repository',
      permissions: { contents: 'write', pull_requests: 'write' },
    });
  });

  it('fails closed when organization and personal installations both match the requested owner', async () => {
    const service = createService([
      {
        platform_installation_id: 'org-installation',
        platform_account_login: 'organization-owner',
        github_app_type: 'standard',
        owned_by_organization_id: '00000000-0000-4000-8000-000000000001',
      },
      {
        platform_installation_id: 'personal-installation',
        platform_account_login: 'personal-owner',
        github_app_type: 'lite',
        owned_by_organization_id: null,
      },
    ]);

    const result = await service.findInstallationId({
      githubRepo: 'renamed-owner/repository',
      userId: 'user-1',
      orgId: '00000000-0000-4000-8000-000000000001',
    });

    expect(result).toEqual({ success: false, reason: 'ambiguous_installation' });
  });

  it('fails closed when multiple active organization installations match the requested owner', async () => {
    const service = createService([
      {
        platform_installation_id: 'org-installation-1',
        platform_account_login: 'organization-owner',
        github_app_type: 'standard',
        owned_by_organization_id: '00000000-0000-4000-8000-000000000001',
      },
      {
        platform_installation_id: 'org-installation-2',
        platform_account_login: 'organization-owner',
        github_app_type: 'standard',
        owned_by_organization_id: '00000000-0000-4000-8000-000000000001',
      },
    ]);

    const result = await service.findInstallationId({
      githubRepo: 'renamed-owner/repository',
      userId: 'user-1',
      orgId: '00000000-0000-4000-8000-000000000001',
    });

    expect(result).toEqual({ success: false, reason: 'ambiguous_installation' });
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
