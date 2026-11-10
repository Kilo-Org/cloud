import { cloud_agent_repository_environment_defaults as table } from '@kilocode/db/schema';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { canonicalGitLabCloneUrl } from '@kilocode/worker-utils/git-url';
import type { ProfileDatabase, ProfileOwner, RepositoryPlatform } from './types';
import { normalizeGitlabCloneUrl } from './environment-contracts';
import { canonicalRepoFullName } from './repo-binding-db';

export type RepositoryEnvironmentDefaultSetting =
  | { mode: 'automatic' }
  | { mode: 'none' }
  | { mode: 'environment'; environmentId: string };

export type StoredRepositoryEnvironmentDefault = Exclude<
  RepositoryEnvironmentDefaultSetting,
  { mode: 'automatic' }
>;

export type RepositoryEnvironmentDefaultKey =
  | { platform: 'github'; repoFullName: string }
  | { platform: 'gitlab'; cloneUrl: string };

export type RepositoryEnvironmentIdentity =
  | { platform: 'github'; repoFullName: string }
  | { platform: 'gitlab'; repoFullName: string; cloneUrl: string };

export type RepositoryEnvironmentDefaultRow = {
  repositoryFullName: string;
  repositoryPlatform: RepositoryPlatform;
  repositoryKey: string;
  environment: StoredRepositoryEnvironmentDefault;
};

type ReadDatabase = Pick<ProfileDatabase, 'select'>;

function storedSetting(environmentId: string | null): StoredRepositoryEnvironmentDefault {
  return environmentId === null ? { mode: 'none' } : { mode: 'environment', environmentId };
}

function repositoryKey(key: RepositoryEnvironmentDefaultKey): string {
  switch (key.platform) {
    case 'github':
      return canonicalRepoFullName(key.repoFullName);
    case 'gitlab':
      return canonicalGitLabCloneUrl(key.cloneUrl) ?? normalizeGitlabCloneUrl(key.cloneUrl);
  }
}

function ownerCondition(owner: ProfileOwner) {
  return owner.type === 'user'
    ? and(eq(table.owned_by_user_id, owner.id), sql`${table.owned_by_organization_id} IS NULL`)
    : and(eq(table.owned_by_organization_id, owner.id), sql`${table.owned_by_user_id} IS NULL`);
}

function ownerColumns(owner: ProfileOwner) {
  return owner.type === 'user'
    ? { owned_by_user_id: owner.id, owned_by_organization_id: null }
    : { owned_by_organization_id: owner.id, owned_by_user_id: null };
}

export async function getRepositoryEnvironmentDefaults(
  db: ReadDatabase,
  owner: ProfileOwner
): Promise<RepositoryEnvironmentDefaultRow[]> {
  const rows = await db
    .select({
      repositoryFullName: table.repository_full_name,
      repositoryPlatform: table.repository_platform,
      repositoryKey: table.repository_key,
      environmentId: table.environment_id,
    })
    .from(table)
    .where(ownerCondition(owner));
  return rows.map(({ repositoryFullName, repositoryPlatform, repositoryKey, environmentId }) => ({
    repositoryFullName,
    repositoryPlatform,
    repositoryKey,
    environment: storedSetting(environmentId),
  }));
}

export async function getRepositoryEnvironmentDefault(
  db: ReadDatabase,
  owner: ProfileOwner,
  key: RepositoryEnvironmentDefaultKey
): Promise<RepositoryEnvironmentDefaultSetting> {
  const [row] = await db
    .select({ environmentId: table.environment_id })
    .from(table)
    .where(
      and(
        ownerCondition(owner),
        eq(table.repository_platform, key.platform),
        eq(table.repository_key, repositoryKey(key))
      )
    )
    .limit(1);
  return row ? storedSetting(row.environmentId) : { mode: 'automatic' };
}

export async function upsertRepositoryEnvironmentDefault(
  db: ProfileDatabase,
  owner: ProfileOwner,
  repository: RepositoryEnvironmentIdentity,
  setting: StoredRepositoryEnvironmentDefault
): Promise<void> {
  const environmentId = setting.mode === 'none' ? null : setting.environmentId;
  const key = repositoryKey(repository);
  const values = {
    ...ownerColumns(owner),
    repository_full_name: canonicalRepoFullName(repository.repoFullName),
    repository_platform: repository.platform,
    repository_key: key,
    environment_id: environmentId,
  };
  if (owner.type === 'user') {
    await db
      .insert(table)
      .values(values)
      .onConflictDoUpdate({
        target: [table.owned_by_user_id, table.repository_platform, table.repository_key],
        targetWhere: isNotNull(table.owned_by_user_id),
        set: { environment_id: environmentId },
      });
    return;
  }
  await db
    .insert(table)
    .values(values)
    .onConflictDoUpdate({
      target: [table.owned_by_organization_id, table.repository_platform, table.repository_key],
      targetWhere: isNotNull(table.owned_by_organization_id),
      set: { environment_id: environmentId },
    });
}

export async function deleteRepositoryEnvironmentDefault(
  db: ProfileDatabase,
  owner: ProfileOwner,
  key: RepositoryEnvironmentDefaultKey
): Promise<void> {
  await db
    .delete(table)
    .where(
      and(
        ownerCondition(owner),
        eq(table.repository_platform, key.platform),
        eq(table.repository_key, repositoryKey(key))
      )
    );
}
