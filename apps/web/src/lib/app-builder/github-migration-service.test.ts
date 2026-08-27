import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type * as migrationService from './github-migration-service';

type ProjectState = {
  id: string;
  title: string;
  session_id: string | null;
  deployment_id: string | null;
  git_repo_full_name: string | null;
  git_platform_integration_id: string | null;
  migrated_at: string | null;
};
type WorkerMigrationResult =
  | { success: true; platformIntegrationId: string }
  | { success: false; error: string };

const projectState: ProjectState = {
  id: 'project-1',
  title: 'Test project',
  session_id: 'session-1',
  deployment_id: null,
  git_repo_full_name: null,
  git_platform_integration_id: null,
  migrated_at: null,
};
const dialect = new PgDialect();
const migrationPredicates: SQL[] = [];
const mockMigrateToGithub = jest.fn<() => Promise<WorkerMigrationResult>>();
const mockGetProjectWithOwnershipCheck = jest.fn<() => Promise<ProjectState>>(async () => ({
  ...projectState,
}));

function compile(predicate: SQL) {
  return dialect.sqlToQuery(predicate);
}

function matchesClaimPredicate(predicate: SQL) {
  const { sql } = compile(predicate);
  return (
    projectState.migrated_at === null &&
    projectState.git_repo_full_name === null &&
    /"migrated_at" is null/i.test(sql) &&
    /"git_repo_full_name" is null/i.test(sql)
  );
}

function matchesOwnedClaim(predicate: SQL) {
  if (!projectState.migrated_at || projectState.git_repo_full_name !== null) return false;
  const { sql, params } = compile(predicate);
  return (
    /"migrated_at"\s*=\s*\$\d+/i.test(sql) &&
    /"git_repo_full_name" is null/i.test(sql) &&
    params.includes(projectState.migrated_at)
  );
}

function update() {
  return {
    set(values: Partial<ProjectState>) {
      return {
        where(predicate: SQL) {
          migrationPredicates.push(predicate);

          const returning = async () => {
            if (values.migrated_at && matchesClaimPredicate(predicate)) {
              projectState.migrated_at = values.migrated_at;
              return [{ ...projectState }];
            }
            if (values.git_repo_full_name && matchesOwnedClaim(predicate)) {
              projectState.git_repo_full_name = values.git_repo_full_name;
              projectState.git_platform_integration_id = values.git_platform_integration_id ?? null;
              return [{ id: projectState.id }];
            }
            return [];
          };

          if (values.migrated_at === null && matchesOwnedClaim(predicate)) {
            projectState.migrated_at = null;
          }

          return Object.assign(Promise.resolve([]), { returning });
        },
      };
    },
  };
}

jest.mock('@/lib/drizzle', () => ({
  db: {
    update,
    transaction: async (callback: (tx: { update: typeof update }) => Promise<unknown>) =>
      callback({ update }),
  },
}));

jest.mock('@/lib/app-builder/app-builder-client', () => ({
  migrateToGithub: () => mockMigrateToGithub(),
}));

jest.mock('@/lib/app-builder/project-ownership', () => ({
  getProjectWithOwnershipCheck: () => mockGetProjectWithOwnershipCheck(),
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: jest.fn(),
}));

let migrateProjectToGitHub: typeof migrationService.migrateProjectToGitHub;

const owner = { type: 'user', id: 'user-1' } as const;
const resolvedIntegrationId = '123e4567-e89b-12d3-a456-426614174003';

function migrate(repoFullName = 'acme/app', expectedPlatformIntegrationId?: string) {
  return migrateProjectToGitHub({
    projectId: projectState.id,
    owner,
    userId: owner.id,
    repoFullName,
    expectedPlatformIntegrationId,
  });
}

beforeAll(async () => {
  ({ migrateProjectToGitHub } = await import('./github-migration-service'));
});

beforeEach(() => {
  projectState.session_id = 'session-1';
  projectState.deployment_id = null;
  projectState.git_repo_full_name = null;
  projectState.git_platform_integration_id = null;
  projectState.migrated_at = null;
  migrationPredicates.length = 0;
  jest.clearAllMocks();
  mockMigrateToGithub.mockResolvedValue({
    success: true,
    platformIntegrationId: resolvedIntegrationId,
  });
});

describe('GitHub migration claim', () => {
  it('allows only one concurrent request to call the Worker', async () => {
    const worker = Promise.withResolvers<WorkerMigrationResult>();
    const started = Promise.withResolvers<void>();
    mockMigrateToGithub.mockImplementationOnce(() => {
      started.resolve();
      return worker.promise;
    });

    const winner = migrate();
    await started.promise;
    const loser = await migrate();

    expect(loser).toEqual({ success: false, error: 'already_migrated' });
    expect(mockMigrateToGithub).toHaveBeenCalledTimes(1);

    worker.resolve({ success: true, platformIntegrationId: resolvedIntegrationId });
    await expect(winner).resolves.toMatchObject({ success: true });

    const claimSql = compile(migrationPredicates[0]).sql;
    expect(claimSql).toMatch(/"migrated_at" is null/i);
    expect(claimSql).toMatch(/"git_repo_full_name" is null/i);
  });

  it('returns the completed result when the same migration is retried', async () => {
    await expect(migrate()).resolves.toMatchObject({ success: true });
    await expect(migrate()).resolves.toEqual({
      success: true,
      githubRepoUrl: 'https://github.com/acme/app',
      newSessionId: 'session-1',
    });

    expect(mockMigrateToGithub).toHaveBeenCalledTimes(1);
  });

  it('rejects a conflicting migration without calling the Worker again', async () => {
    await expect(migrate()).resolves.toMatchObject({ success: true });
    await expect(migrate('acme/other-app')).resolves.toEqual({
      success: false,
      error: 'already_migrated',
    });

    expect(mockMigrateToGithub).toHaveBeenCalledTimes(1);
  });

  it('rejects a same-repository retry fenced to a different integration', async () => {
    await expect(migrate()).resolves.toMatchObject({ success: true });
    await expect(migrate('acme/app', '123e4567-e89b-12d3-a456-426614174099')).resolves.toEqual({
      success: false,
      error: 'already_migrated',
    });

    expect(mockMigrateToGithub).toHaveBeenCalledTimes(1);
  });

  it('releases only its own claim when the Worker fails before pushing', async () => {
    mockMigrateToGithub.mockResolvedValueOnce({ success: false, error: 'repo_not_empty' });

    await expect(migrate()).resolves.toEqual({ success: false, error: 'repo_not_empty' });
    expect(projectState.migrated_at).toBeNull();

    const releasePredicate = migrationPredicates.at(-1);
    if (!releasePredicate) throw new Error('Claim release predicate was not recorded');
    const { sql, params } = compile(releasePredicate);
    expect(sql).toMatch(/"migrated_at"\s*=\s*\$\d+/i);
    expect(sql).toMatch(/"git_repo_full_name" is null/i);
    expect(params).toContainEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));

    await expect(migrate()).resolves.toMatchObject({ success: true });
    expect(mockMigrateToGithub).toHaveBeenCalledTimes(2);
  });

  it('does not release a claim token it no longer owns', async () => {
    const worker = Promise.withResolvers<WorkerMigrationResult>();
    const started = Promise.withResolvers<void>();
    mockMigrateToGithub.mockImplementationOnce(() => {
      started.resolve();
      return worker.promise;
    });

    const migration = migrate();
    await started.promise;
    projectState.migrated_at = '2026-08-27T15:00:00.000Z';
    worker.resolve({ success: false, error: 'repo_not_empty' });

    await expect(migration).resolves.toEqual({ success: false, error: 'repo_not_empty' });
    expect(projectState.migrated_at).toBe('2026-08-27T15:00:00.000Z');
  });

  it('retains the claim after an ambiguous Worker failure', async () => {
    mockMigrateToGithub.mockRejectedValueOnce(new Error('Response was lost'));

    await expect(migrate()).resolves.toEqual({ success: false, error: 'push_failed' });
    expect(projectState.migrated_at).not.toBeNull();

    await expect(migrate()).resolves.toEqual({ success: false, error: 'already_migrated' });
    expect(mockMigrateToGithub).toHaveBeenCalledTimes(1);
  });
});
