import 'server-only';
import { db } from '@/lib/drizzle';
import {
  agent_environment_profiles,
  agent_environment_profile_vars,
  agent_environment_profile_commands,
  type AgentEnvironmentProfile,
} from '@kilocode/db/schema';
import { eq, and, sql, count, inArray } from 'drizzle-orm';
import type { ProfileOwner, ProfileSummary, ProfileResponse } from './types';
import { buildOwnershipCondition, verifyProfileOwnership } from './profile-utils';

/**
 * Create a new environment profile.
 */
export async function createProfile(
  owner: ProfileOwner,
  name: string,
  description?: string
): Promise<{ id: string }> {
  const [profile] = await db
    .insert(agent_environment_profiles)
    .values({
      owned_by_organization_id: owner.type === 'organization' ? owner.id : null,
      owned_by_user_id: owner.type === 'user' ? owner.id : null,
      name,
      description: description ?? null,
    })
    .returning({ id: agent_environment_profiles.id });

  return { id: profile.id };
}

/**
 * Update profile metadata (name, description).
 */
export async function updateProfile(
  profileId: string,
  owner: ProfileOwner,
  updates: { name?: string; description?: string }
): Promise<void> {
  await verifyProfileOwnership(profileId, owner);

  const updateData: Partial<Pick<AgentEnvironmentProfile, 'name' | 'description'>> = {};
  if (updates.name !== undefined) {
    updateData.name = updates.name;
  }
  if (updates.description !== undefined) {
    updateData.description = updates.description;
  }

  if (Object.keys(updateData).length === 0) {
    return;
  }

  await db
    .update(agent_environment_profiles)
    .set(updateData)
    .where(eq(agent_environment_profiles.id, profileId));
}

/**
 * Delete a profile and cascade to vars and commands.
 */
export async function deleteProfile(profileId: string, owner: ProfileOwner): Promise<void> {
  await verifyProfileOwnership(profileId, owner);

  await db.delete(agent_environment_profiles).where(eq(agent_environment_profiles.id, profileId));
}

/**
 * List all profiles for an owner with summary info.
 */
export async function listProfiles(owner: ProfileOwner): Promise<ProfileSummary[]> {
  const profiles = await db
    .select({
      id: agent_environment_profiles.id,
      name: agent_environment_profiles.name,
      description: agent_environment_profiles.description,
      isDefault: agent_environment_profiles.is_default,
      createdAt: agent_environment_profiles.created_at,
      updatedAt: agent_environment_profiles.updated_at,
    })
    .from(agent_environment_profiles)
    .where(buildOwnershipCondition(owner))
    .orderBy(agent_environment_profiles.name);

  // Get var and command counts for each profile
  const profileIds = profiles.map(p => p.id);

  if (profileIds.length === 0) {
    return [];
  }

  const [varCounts, commandCounts] = await Promise.all([
    db
      .select({
        profileId: agent_environment_profile_vars.profile_id,
        count: count(),
      })
      .from(agent_environment_profile_vars)
      .where(inArray(agent_environment_profile_vars.profile_id, profileIds))
      .groupBy(agent_environment_profile_vars.profile_id),
    db
      .select({
        profileId: agent_environment_profile_commands.profile_id,
        count: count(),
      })
      .from(agent_environment_profile_commands)
      .where(inArray(agent_environment_profile_commands.profile_id, profileIds))
      .groupBy(agent_environment_profile_commands.profile_id),
  ]);

  const varCountMap = new Map(varCounts.map(v => [v.profileId, Number(v.count)]));
  const commandCountMap = new Map(commandCounts.map(c => [c.profileId, Number(c.count)]));

  return profiles.map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    isDefault: p.isDefault,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    varCount: varCountMap.get(p.id) ?? 0,
    commandCount: commandCountMap.get(p.id) ?? 0,
  }));
}

/**
 * Get a single profile with vars and commands.
 * Secret values are masked.
 */
export async function getProfile(profileId: string, owner: ProfileOwner): Promise<ProfileResponse> {
  const profile = await verifyProfileOwnership(profileId, owner);

  // Get vars with masked secret values
  const vars = await db
    .select({
      key: agent_environment_profile_vars.key,
      value: sql<string>`
        CASE
          WHEN ${agent_environment_profile_vars.is_secret} = true
          THEN '***'
          ELSE ${agent_environment_profile_vars.value}
        END
      `.as('value'),
      isSecret: agent_environment_profile_vars.is_secret,
      createdAt: agent_environment_profile_vars.created_at,
      updatedAt: agent_environment_profile_vars.updated_at,
    })
    .from(agent_environment_profile_vars)
    .where(eq(agent_environment_profile_vars.profile_id, profileId))
    .orderBy(agent_environment_profile_vars.key);

  // Get commands in order
  const commands = await db
    .select({
      sequence: agent_environment_profile_commands.sequence,
      command: agent_environment_profile_commands.command,
    })
    .from(agent_environment_profile_commands)
    .where(eq(agent_environment_profile_commands.profile_id, profileId))
    .orderBy(agent_environment_profile_commands.sequence);

  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    isDefault: profile.is_default,
    createdAt: profile.created_at,
    updatedAt: profile.updated_at,
    vars,
    commands,
  };
}

/**
 * Set a profile as the default for an owner.
 * Clears any existing default first.
 */
export async function setDefaultProfile(profileId: string, owner: ProfileOwner): Promise<void> {
  await verifyProfileOwnership(profileId, owner);

  await db.transaction(async tx => {
    // Clear existing default
    await tx
      .update(agent_environment_profiles)
      .set({ is_default: false })
      .where(and(buildOwnershipCondition(owner), eq(agent_environment_profiles.is_default, true)));

    // Set new default
    await tx
      .update(agent_environment_profiles)
      .set({ is_default: true })
      .where(eq(agent_environment_profiles.id, profileId));
  });
}

/**
 * Clear the default profile for an owner.
 */
export async function clearDefaultProfile(profileId: string, owner: ProfileOwner): Promise<void> {
  await verifyProfileOwnership(profileId, owner);

  await db
    .update(agent_environment_profiles)
    .set({ is_default: false })
    .where(eq(agent_environment_profiles.id, profileId));
}

/**
 * Get the default profile for an owner.
 * Returns null if no default is set.
 */
export async function getDefaultProfile(owner: ProfileOwner): Promise<ProfileResponse | null> {
  const [profile] = await db
    .select()
    .from(agent_environment_profiles)
    .where(and(buildOwnershipCondition(owner), eq(agent_environment_profiles.is_default, true)))
    .limit(1);

  if (!profile) {
    return null;
  }

  return getProfile(profile.id, owner);
}

/**
 * Get a profile by name for an owner.
 * Used for profile resolution in the prepare session API.
 */
export async function getProfileByName(
  name: string,
  owner: ProfileOwner
): Promise<ProfileResponse | null> {
  const [profile] = await db
    .select()
    .from(agent_environment_profiles)
    .where(and(buildOwnershipCondition(owner), eq(agent_environment_profiles.name, name)))
    .limit(1);

  if (!profile) {
    return null;
  }

  return getProfile(profile.id, owner);
}

/**
 * Get profile ID by name for an owner.
 * Returns null if not found.
 */
export async function getProfileIdByName(
  name: string,
  owner: ProfileOwner
): Promise<string | null> {
  const [profile] = await db
    .select({ id: agent_environment_profiles.id })
    .from(agent_environment_profiles)
    .where(and(buildOwnershipCondition(owner), eq(agent_environment_profiles.name, name)))
    .limit(1);

  return profile?.id ?? null;
}

/**
 * Get the effective default profile ID for a user in org context.
 * Org default takes precedence over personal default.
 */
export async function getEffectiveDefaultProfileId(
  userId: string,
  organizationId: string
): Promise<string | null> {
  // Try org default first
  const [orgDefault] = await db
    .select({ id: agent_environment_profiles.id })
    .from(agent_environment_profiles)
    .where(
      and(
        eq(agent_environment_profiles.owned_by_organization_id, organizationId),
        eq(agent_environment_profiles.is_default, true)
      )
    )
    .limit(1);

  if (orgDefault) {
    return orgDefault.id;
  }

  // Fall back to personal default
  const [userDefault] = await db
    .select({ id: agent_environment_profiles.id })
    .from(agent_environment_profiles)
    .where(
      and(
        eq(agent_environment_profiles.owned_by_user_id, userId),
        eq(agent_environment_profiles.is_default, true)
      )
    )
    .limit(1);

  return userDefault?.id ?? null;
}
