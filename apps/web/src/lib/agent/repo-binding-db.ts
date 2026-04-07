import 'server-only';
import { db } from '@/lib/drizzle';
import {
  agent_environment_profiles,
  agent_environment_profile_repo_bindings,
} from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import type { ProfileOwner } from './types';
import { buildOwnershipCondition } from './profile-utils';

/**
 * Find a binding by repo+platform+owner.
 * Joins through the profile table to enforce ownership.
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
    .innerJoin(
      agent_environment_profiles,
      eq(agent_environment_profile_repo_bindings.profile_id, agent_environment_profiles.id)
    )
    .where(
      and(
        eq(agent_environment_profile_repo_bindings.repo_full_name, repoFullName),
        eq(agent_environment_profile_repo_bindings.platform, platform),
        buildOwnershipCondition(owner)
      )
    )
    .limit(1);

  return row;
}

/**
 * Update a binding to point to a different profile.
 */
export async function updateBindingProfile(bindingId: string, profileId: string): Promise<void> {
  await db
    .update(agent_environment_profile_repo_bindings)
    .set({ profile_id: profileId })
    .where(eq(agent_environment_profile_repo_bindings.id, bindingId));
}

/**
 * Insert a new repo binding.
 */
export async function insertBinding(
  repoFullName: string,
  platform: 'github' | 'gitlab',
  profileId: string
): Promise<void> {
  await db.insert(agent_environment_profile_repo_bindings).values({
    repo_full_name: repoFullName,
    platform,
    profile_id: profileId,
  });
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
    .where(buildOwnershipCondition(owner))
    .orderBy(agent_environment_profile_repo_bindings.repo_full_name);
}
