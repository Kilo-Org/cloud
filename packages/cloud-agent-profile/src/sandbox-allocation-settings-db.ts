import { cloud_agent_sandbox_allocation_settings } from '@kilocode/db/schema';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { ProfileDatabase, ProfileOwner, RepositoryPlatform } from './types';

export type SandboxAllocationSettingRow = {
  id: string;
  repositoryFullName: string | null;
  repositoryPlatform: RepositoryPlatform | null;
  allocation: string;
};

const t = cloud_agent_sandbox_allocation_settings;

function ownerCondition(owner: ProfileOwner) {
  return owner.type === 'user'
    ? and(eq(t.owned_by_user_id, owner.id), sql`${t.owned_by_organization_id} IS NULL`)
    : and(eq(t.owned_by_organization_id, owner.id), sql`${t.owned_by_user_id} IS NULL`);
}

function ownerColumns(owner: ProfileOwner) {
  return owner.type === 'user'
    ? { owned_by_user_id: owner.id, owned_by_organization_id: null }
    : { owned_by_organization_id: owner.id, owned_by_user_id: null };
}

export async function selectAllocationSettings(
  db: ProfileDatabase,
  owner: ProfileOwner
): Promise<SandboxAllocationSettingRow[]> {
  return db
    .select({
      id: t.id,
      repositoryFullName: t.repository_full_name,
      repositoryPlatform: t.repository_platform,
      allocation: t.allocation,
    })
    .from(t)
    .where(ownerCondition(owner));
}

export async function upsertContextAllocation(
  db: ProfileDatabase,
  owner: ProfileOwner,
  allocation: string
): Promise<void> {
  if (owner.type === 'user') {
    await db
      .insert(t)
      .values({ ...ownerColumns(owner), allocation })
      .onConflictDoUpdate({
        target: [t.owned_by_user_id],
        targetWhere: and(isNotNull(t.owned_by_user_id), isNull(t.repository_full_name)),
        set: { allocation },
      });
    return;
  }
  await db
    .insert(t)
    .values({ ...ownerColumns(owner), allocation })
    .onConflictDoUpdate({
      target: [t.owned_by_organization_id],
      targetWhere: and(isNotNull(t.owned_by_organization_id), isNull(t.repository_full_name)),
      set: { allocation },
    });
}

export async function upsertRepoAllocation(
  db: ProfileDatabase,
  owner: ProfileOwner,
  repositoryFullName: string,
  repositoryPlatform: RepositoryPlatform,
  allocation: string
): Promise<void> {
  const values = {
    ...ownerColumns(owner),
    repository_full_name: repositoryFullName,
    repository_platform: repositoryPlatform,
    allocation,
  };
  if (owner.type === 'user') {
    await db
      .insert(t)
      .values(values)
      .onConflictDoUpdate({
        target: [t.repository_full_name, t.repository_platform, t.owned_by_user_id],
        targetWhere: and(isNotNull(t.repository_full_name), isNotNull(t.owned_by_user_id)),
        set: { allocation },
      });
    return;
  }
  await db
    .insert(t)
    .values(values)
    .onConflictDoUpdate({
      target: [t.repository_full_name, t.repository_platform, t.owned_by_organization_id],
      targetWhere: and(isNotNull(t.repository_full_name), isNotNull(t.owned_by_organization_id)),
      set: { allocation },
    });
}

export async function deleteContextAllocation(
  db: ProfileDatabase,
  owner: ProfileOwner
): Promise<void> {
  await db.delete(t).where(and(ownerCondition(owner), isNull(t.repository_full_name)));
}

export async function deleteRepoAllocation(
  db: ProfileDatabase,
  owner: ProfileOwner,
  repositoryFullName: string,
  repositoryPlatform: RepositoryPlatform
): Promise<void> {
  await db
    .delete(t)
    .where(
      and(
        ownerCondition(owner),
        eq(t.repository_full_name, repositoryFullName),
        eq(t.repository_platform, repositoryPlatform)
      )
    );
}
