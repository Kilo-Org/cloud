import 'server-only';
import { db } from '@/lib/drizzle';
import {
  agent_environment_profiles,
  agent_environment_profile_repo_bindings,
} from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { ProfileOwner } from './types';
import { buildOwnershipCondition, verifyProfileOwnership } from './profile-utils';

type RepoBinding = {
  repoFullName: string;
  platform: string;
  profileId: string;
  profileName: string;
};

/**
 * Bind an environment profile to a repository.
 * If the owner already has a binding for this repo+platform, updates it to the new profile.
 */
export async function bindProfileToRepo(
  owner: ProfileOwner,
  repoFullName: string,
  platform: 'github' | 'gitlab',
  profileId: string
): Promise<void> {
  // Verify the profile belongs to the owner
  await verifyProfileOwnership(profileId, owner);

  const repoLower = repoFullName.toLowerCase();

  // Check for an existing binding for this repo+platform owned by the same owner
  const [existing] = await db
    .select({ bindingId: agent_environment_profile_repo_bindings.id })
    .from(agent_environment_profile_repo_bindings)
    .innerJoin(
      agent_environment_profiles,
      eq(agent_environment_profile_repo_bindings.profile_id, agent_environment_profiles.id)
    )
    .where(
      and(
        eq(agent_environment_profile_repo_bindings.repo_full_name, repoLower),
        eq(agent_environment_profile_repo_bindings.platform, platform),
        buildOwnershipCondition(owner)
      )
    )
    .limit(1);

  if (existing) {
    await db
      .update(agent_environment_profile_repo_bindings)
      .set({ profile_id: profileId })
      .where(eq(agent_environment_profile_repo_bindings.id, existing.bindingId));
  } else {
    await db.insert(agent_environment_profile_repo_bindings).values({
      repo_full_name: repoLower,
      platform,
      profile_id: profileId,
    });
  }
}

/**
 * Remove the profile binding for a repository.
 * Verifies ownership by joining through the profile before deleting.
 */
export async function unbindRepo(
  owner: ProfileOwner,
  repoFullName: string,
  platform: 'github' | 'gitlab'
): Promise<void> {
  const repoLower = repoFullName.toLowerCase();

  const [binding] = await db
    .select({ bindingId: agent_environment_profile_repo_bindings.id })
    .from(agent_environment_profile_repo_bindings)
    .innerJoin(
      agent_environment_profiles,
      eq(agent_environment_profile_repo_bindings.profile_id, agent_environment_profiles.id)
    )
    .where(
      and(
        eq(agent_environment_profile_repo_bindings.repo_full_name, repoLower),
        eq(agent_environment_profile_repo_bindings.platform, platform),
        buildOwnershipCondition(owner)
      )
    )
    .limit(1);

  if (!binding) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Repo binding not found',
    });
  }

  await db
    .delete(agent_environment_profile_repo_bindings)
    .where(eq(agent_environment_profile_repo_bindings.id, binding.bindingId));
}

/**
 * Look up which profile is bound to a repo for the given owner.
 * Returns the profile_id if found, null otherwise.
 */
export async function getBindingForRepo(
  owner: ProfileOwner,
  repoFullName: string,
  platform: 'github' | 'gitlab'
): Promise<string | null> {
  const repoLower = repoFullName.toLowerCase();

  const [binding] = await db
    .select({ profileId: agent_environment_profile_repo_bindings.profile_id })
    .from(agent_environment_profile_repo_bindings)
    .innerJoin(
      agent_environment_profiles,
      eq(agent_environment_profile_repo_bindings.profile_id, agent_environment_profiles.id)
    )
    .where(
      and(
        eq(agent_environment_profile_repo_bindings.repo_full_name, repoLower),
        eq(agent_environment_profile_repo_bindings.platform, platform),
        buildOwnershipCondition(owner)
      )
    )
    .limit(1);

  return binding?.profileId ?? null;
}

/**
 * List all repo-profile bindings for the given owner.
 */
export async function listBindings(owner: ProfileOwner): Promise<RepoBinding[]> {
  const bindings = await db
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

  return bindings;
}
