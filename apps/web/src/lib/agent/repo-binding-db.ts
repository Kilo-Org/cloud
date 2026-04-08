import 'server-only';
import { db } from '@/lib/drizzle';
import {
  agent_environment_profiles,
  agent_environment_profile_repo_bindings,
} from '@kilocode/db/schema';
import { eq, and, sql, isNotNull } from 'drizzle-orm';
import type { ProfileOwner } from './types';

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
  owner: ProfileOwner,
  repoFullName: string,
  platform: 'github' | 'gitlab',
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
  owner: ProfileOwner,
  repoFullName: string,
  platform: 'github' | 'gitlab'
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
export async function deleteBinding(bindingId: string): Promise<void> {
  await db
    .delete(agent_environment_profile_repo_bindings)
    .where(eq(agent_environment_profile_repo_bindings.id, bindingId));
}

/**
 * List all bindings for an owner, joined with profile names.
 */
export async function selectBindingsWithProfiles(owner: ProfileOwner) {
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
