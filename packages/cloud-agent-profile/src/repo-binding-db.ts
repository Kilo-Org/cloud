import {
  agent_environment_profiles,
  agent_environment_profile_repo_bindings,
} from '@kilocode/db/schema';
import { eq, and, sql, isNotNull } from 'drizzle-orm';
import type { ProfileDatabase, ProfileOwner, RepositoryPlatform } from './types';

export function canonicalRepoFullName(repoFullName: string): string {
  return repoFullName.trim().toLowerCase();
}

function buildBindingOwnerCondition(owner: ProfileOwner) {
  return owner.type === 'user'
    ? and(
        eq(agent_environment_profile_repo_bindings.owned_by_user_id, owner.id),
        sql`${agent_environment_profile_repo_bindings.owned_by_organization_id} IS NULL`
      )
    : and(
        eq(agent_environment_profile_repo_bindings.owned_by_organization_id, owner.id),
        sql`${agent_environment_profile_repo_bindings.owned_by_user_id} IS NULL`
      );
}

function ownerColumns(owner: ProfileOwner) {
  return owner.type === 'user'
    ? { owned_by_user_id: owner.id, owned_by_organization_id: null }
    : { owned_by_organization_id: owner.id, owned_by_user_id: null };
}

/**
 * Upsert a repo binding: insert or update the profile for this owner+repo+platform.
 * Uses ON CONFLICT on the partial unique index to atomically resolve races.
 */
export async function upsertBinding(
  db: ProfileDatabase,
  owner: ProfileOwner,
  repoFullName: string,
  platform: RepositoryPlatform,
  profileId: string
): Promise<void> {
  const b = agent_environment_profile_repo_bindings;

  if (owner.type === 'user') {
    await db
      .insert(b)
      .values({
        repo_full_name: repoFullName,
        platform,
        profile_id: profileId,
        ...ownerColumns(owner),
      })
      .onConflictDoUpdate({
        target: [b.repo_full_name, b.platform, b.owned_by_user_id],
        targetWhere: isNotNull(b.owned_by_user_id),
        set: { profile_id: profileId },
      });
  } else {
    await db
      .insert(b)
      .values({
        repo_full_name: repoFullName,
        platform,
        profile_id: profileId,
        ...ownerColumns(owner),
      })
      .onConflictDoUpdate({
        target: [b.repo_full_name, b.platform, b.owned_by_organization_id],
        targetWhere: isNotNull(b.owned_by_organization_id),
        set: { profile_id: profileId },
      });
  }
}

/**
 * Find a binding by repo+platform+owner.
 */
export async function findBinding(
  db: ProfileDatabase,
  owner: ProfileOwner,
  repoFullName: string,
  platform: RepositoryPlatform
) {
  const [row] = await db
    .select({
      bindingId: agent_environment_profile_repo_bindings.id,
      profileId: agent_environment_profile_repo_bindings.profile_id,
    })
    .from(agent_environment_profile_repo_bindings)
    .where(
      and(
        eq(agent_environment_profile_repo_bindings.repo_full_name, repoFullName),
        eq(agent_environment_profile_repo_bindings.platform, platform),
        buildBindingOwnerCondition(owner)
      )
    )
    .limit(1);

  return row;
}

/**
 * Delete a binding by ID.
 */
export async function deleteBinding(db: ProfileDatabase, bindingId: string): Promise<void> {
  await db
    .delete(agent_environment_profile_repo_bindings)
    .where(eq(agent_environment_profile_repo_bindings.id, bindingId));
}

/**
 * Delete the binding for an owner+repo+platform if present. Idempotent: absent
 * bindings are a no-op so a combined remove can run without a prior read.
 */
export async function deleteBindingForRepo(
  db: ProfileDatabase,
  owner: ProfileOwner,
  repoFullName: string,
  platform: RepositoryPlatform
): Promise<void> {
  await db
    .delete(agent_environment_profile_repo_bindings)
    .where(
      and(
        eq(agent_environment_profile_repo_bindings.repo_full_name, repoFullName),
        eq(agent_environment_profile_repo_bindings.platform, platform),
        buildBindingOwnerCondition(owner)
      )
    );
}

/**
 * List all bindings for an owner, joined with profile names.
 */
export async function selectBindingsWithProfiles(db: ProfileDatabase, owner: ProfileOwner) {
  return db
    .select({
      repoFullName: agent_environment_profile_repo_bindings.repo_full_name,
      platform: agent_environment_profile_repo_bindings.platform,
      profileId: agent_environment_profile_repo_bindings.profile_id,
      profileName: agent_environment_profiles.name,
    })
    .from(agent_environment_profile_repo_bindings)
    .innerJoin(
      agent_environment_profiles,
      eq(agent_environment_profile_repo_bindings.profile_id, agent_environment_profiles.id)
    )
    .where(buildBindingOwnerCondition(owner))
    .orderBy(agent_environment_profile_repo_bindings.repo_full_name);
}
