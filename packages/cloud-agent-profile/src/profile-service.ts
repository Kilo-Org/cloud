import type { WorkerDb } from '@kilocode/db';
import {
  agent_environment_profiles,
  agent_environment_profile_vars,
  agent_environment_profile_commands,
  agent_environment_profile_mcp_servers,
  agent_environment_profile_skills,
  agent_environment_profile_agents,
  agent_environment_profile_kilo_commands,
  type AgentEnvironmentProfile,
} from '@kilocode/db/schema';
import { eq, and, sql, count, inArray } from 'drizzle-orm';
import type { ProfileOwner, ProfileSummary, ProfileResponse } from './types';
import { buildOwnershipCondition, verifyProfileOwnership } from './profile-utils';
import { listMcpServersForProfile } from './profile-mcp-service';
import { listSkillsForProfile } from './profile-skills-service';
import { listAgentsForProfile } from './profile-agents-service';
import { listKiloCommandsForProfile } from './profile-kilo-commands-service';

/**
 * Create a new environment profile.
 *
 * `createdByUserId` records the user who initiated the creation. For
 * user-owned profiles this matches `owner.id`; for org-owned profiles it
 * identifies the member who authored the shared profile.
 */
export async function createProfile(
  db: WorkerDb,
  owner: ProfileOwner,
  createdByUserId: string,
  name: string,
  description?: string
): Promise<{ id: string }> {
  const [profile] = await db
    .insert(agent_environment_profiles)
    .values({
      owned_by_organization_id: owner.type === 'organization' ? owner.id : null,
      owned_by_user_id: owner.type === 'user' ? owner.id : null,
      created_by_user_id: createdByUserId,
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
  db: WorkerDb,
  profileId: string,
  owner: ProfileOwner,
  updates: { name?: string; description?: string }
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);

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
export async function deleteProfile(
  db: WorkerDb,
  profileId: string,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);

  await db.delete(agent_environment_profiles).where(eq(agent_environment_profiles.id, profileId));
}

/**
 * List all profiles for an owner with summary info.
 */
export async function listProfiles(db: WorkerDb, owner: ProfileOwner): Promise<ProfileSummary[]> {
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

  const [varCounts, commandCounts, mcpServerCounts, skillCounts, agentCounts, kiloCommandCounts] =
    await Promise.all([
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
      db
        .select({
          profileId: agent_environment_profile_mcp_servers.profile_id,
          count: count(),
        })
        .from(agent_environment_profile_mcp_servers)
        .where(inArray(agent_environment_profile_mcp_servers.profile_id, profileIds))
        .groupBy(agent_environment_profile_mcp_servers.profile_id),
      db
        .select({
          profileId: agent_environment_profile_skills.profile_id,
          count: count(),
        })
        .from(agent_environment_profile_skills)
        .where(inArray(agent_environment_profile_skills.profile_id, profileIds))
        .groupBy(agent_environment_profile_skills.profile_id),
      db
        .select({
          profileId: agent_environment_profile_agents.profile_id,
          count: count(),
        })
        .from(agent_environment_profile_agents)
        .where(inArray(agent_environment_profile_agents.profile_id, profileIds))
        .groupBy(agent_environment_profile_agents.profile_id),
      db
        .select({
          profileId: agent_environment_profile_kilo_commands.profile_id,
          count: count(),
        })
        .from(agent_environment_profile_kilo_commands)
        .where(inArray(agent_environment_profile_kilo_commands.profile_id, profileIds))
        .groupBy(agent_environment_profile_kilo_commands.profile_id),
    ]);

  const varCountMap = new Map(varCounts.map(v => [v.profileId, Number(v.count)]));
  const commandCountMap = new Map(commandCounts.map(c => [c.profileId, Number(c.count)]));
  const mcpServerCountMap = new Map(mcpServerCounts.map(m => [m.profileId, Number(m.count)]));
  const skillCountMap = new Map(skillCounts.map(s => [s.profileId, Number(s.count)]));
  const agentCountMap = new Map(agentCounts.map(a => [a.profileId, Number(a.count)]));
  const kiloCommandCountMap = new Map(kiloCommandCounts.map(k => [k.profileId, Number(k.count)]));

  return profiles.map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    isDefault: p.isDefault,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    varCount: varCountMap.get(p.id) ?? 0,
    commandCount: commandCountMap.get(p.id) ?? 0,
    mcpServerCount: mcpServerCountMap.get(p.id) ?? 0,
    skillCount: skillCountMap.get(p.id) ?? 0,
    agentCount: agentCountMap.get(p.id) ?? 0,
    kiloCommandCount: kiloCommandCountMap.get(p.id) ?? 0,
  }));
}

/**
 * Get a single profile with vars and commands.
 * Secret values are masked.
 */
export async function getProfile(
  db: WorkerDb,
  profileId: string,
  owner: ProfileOwner
): Promise<ProfileResponse> {
  const profile = await verifyProfileOwnership(db, profileId, owner);

  const [vars, commands, mcpServers, skills, agents, kiloCommands] = await Promise.all([
    db
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
      .orderBy(agent_environment_profile_vars.key),
    db
      .select({
        sequence: agent_environment_profile_commands.sequence,
        command: agent_environment_profile_commands.command,
      })
      .from(agent_environment_profile_commands)
      .where(eq(agent_environment_profile_commands.profile_id, profileId))
      .orderBy(agent_environment_profile_commands.sequence),
    listMcpServersForProfile(db, profileId),
    listSkillsForProfile(db, profileId),
    listAgentsForProfile(db, profileId),
    listKiloCommandsForProfile(db, profileId),
  ]);

  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    isDefault: profile.is_default,
    createdAt: profile.created_at,
    updatedAt: profile.updated_at,
    vars,
    commands,
    mcpServers,
    skills,
    agents,
    kiloCommands,
  };
}

/**
 * Set a profile as the default for an owner.
 * Clears any existing default first.
 */
export async function setDefaultProfile(
  db: WorkerDb,
  profileId: string,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);

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
export async function clearDefaultProfile(
  db: WorkerDb,
  profileId: string,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);

  await db
    .update(agent_environment_profiles)
    .set({ is_default: false })
    .where(eq(agent_environment_profiles.id, profileId));
}

/**
 * Get the default profile for an owner.
 * Returns null if no default is set.
 */
export async function getDefaultProfile(
  db: WorkerDb,
  owner: ProfileOwner
): Promise<ProfileResponse | null> {
  const [profile] = await db
    .select()
    .from(agent_environment_profiles)
    .where(and(buildOwnershipCondition(owner), eq(agent_environment_profiles.is_default, true)))
    .limit(1);

  if (!profile) {
    return null;
  }

  return getProfile(db, profile.id, owner);
}

/**
 * Get a profile by name for an owner.
 * Used for profile resolution in the prepare session API.
 */
export async function getProfileByName(
  db: WorkerDb,
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

  return getProfile(db, profile.id, owner);
}

/**
 * Get profile ID by name for an owner.
 * Returns null if not found.
 */
export async function getProfileIdByName(
  db: WorkerDb,
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
 * Personal default takes precedence over org default — a user-specific
 * preference overrides the org-wide baseline.
 */
export async function getEffectiveDefaultProfileId(
  db: WorkerDb,
  userId: string,
  organizationId: string
): Promise<string | null> {
  // Try personal default first
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

  if (userDefault) {
    return userDefault.id;
  }

  // Fall back to org default
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

  return orgDefault?.id ?? null;
}
