import type { WorkerDb } from '@kilocode/db';
import {
  agent_environment_profiles,
  agent_environment_profile_vars,
  agent_environment_profile_commands,
  agent_environment_profile_mcp_servers,
  agent_environment_profile_skills,
  agent_environment_profile_agents,
  agent_environment_profile_kilo_commands,
  agent_environment_profile_instructions,
  type AgentEnvironmentProfile,
} from '@kilocode/db/schema';
import { eq, and, sql, count, inArray } from 'drizzle-orm';
import type { ProfileDatabase, ProfileOwner, ProfileSummary, ProfileResponse } from './types';
import {
  buildOwnershipCondition,
  lockProfileOwnership,
  verifyProfileOwnership,
} from './profile-utils';
import { withProfileTransaction } from './database';
import { listMcpServersForProfile } from './profile-mcp-service';
import { listSkillsForProfile } from './profile-skills-service';
import { listAgentsForProfile } from './profile-agents-service';
import { listKiloCommandsForProfile } from './profile-kilo-commands-service';
import { listInstructionsForProfile } from './profile-instructions-service';

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
 * Delete a profile and cascade to vars and commands. Callers authorize
 * organization-owned profile deletion themselves (organization managers only,
 * enforced in the agent-profiles router).
 */
export async function deleteProfile(
  db: ProfileDatabase,
  profileId: string,
  owner: ProfileOwner
): Promise<void> {
  await withProfileTransaction(db, async tx => {
    await lockProfileOwnership(tx, profileId, owner);
    await tx.delete(agent_environment_profiles).where(eq(agent_environment_profiles.id, profileId));
  });
}

/** The metadata and collection counts a list row and the Overview screen render. */
type ProfileSummaryRow = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

type ProfileCounts = Omit<
  ProfileSummary,
  'id' | 'name' | 'description' | 'isDefault' | 'createdAt' | 'updatedAt'
>;

const NO_COLLECTIONS: ProfileCounts = {
  varCount: 0,
  commandCount: 0,
  mcpServerCount: 0,
  skillCount: 0,
  agentCount: 0,
  kiloCommandCount: 0,
  instructionCount: 0,
};

/**
 * Collection counts per profile, in one grouped query per collection. Counting
 * rows never transfers their contents, so this stays bounded however large a
 * profile's skills or instructions are.
 */
async function countsByProfileId(
  db: WorkerDb,
  profileIds: string[]
): Promise<Map<string, ProfileCounts>> {
  const [
    varCounts,
    commandCounts,
    mcpServerCounts,
    skillCounts,
    agentCounts,
    kiloCommandCounts,
    instructionCounts,
  ] = await Promise.all([
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
    db
      .select({
        profileId: agent_environment_profile_instructions.profile_id,
        count: count(),
      })
      .from(agent_environment_profile_instructions)
      .where(inArray(agent_environment_profile_instructions.profile_id, profileIds))
      .groupBy(agent_environment_profile_instructions.profile_id),
  ]);

  const varCountMap = new Map(varCounts.map(v => [v.profileId, Number(v.count)]));
  const commandCountMap = new Map(commandCounts.map(c => [c.profileId, Number(c.count)]));
  const mcpServerCountMap = new Map(mcpServerCounts.map(m => [m.profileId, Number(m.count)]));
  const skillCountMap = new Map(skillCounts.map(s => [s.profileId, Number(s.count)]));
  const agentCountMap = new Map(agentCounts.map(a => [a.profileId, Number(a.count)]));
  const kiloCommandCountMap = new Map(kiloCommandCounts.map(k => [k.profileId, Number(k.count)]));
  const instructionCountMap = new Map(instructionCounts.map(i => [i.profileId, Number(i.count)]));

  const counts = new Map<string, ProfileCounts>();
  for (const profileId of profileIds) {
    counts.set(profileId, {
      varCount: varCountMap.get(profileId) ?? 0,
      commandCount: commandCountMap.get(profileId) ?? 0,
      mcpServerCount: mcpServerCountMap.get(profileId) ?? 0,
      skillCount: skillCountMap.get(profileId) ?? 0,
      agentCount: agentCountMap.get(profileId) ?? 0,
      kiloCommandCount: kiloCommandCountMap.get(profileId) ?? 0,
      instructionCount: instructionCountMap.get(profileId) ?? 0,
    });
  }
  return counts;
}

/** One summary row: the profile's metadata plus its collection counts. */
function toProfileSummary(
  profile: ProfileSummaryRow,
  counts: ProfileCounts | undefined
): ProfileSummary {
  return { ...profile, ...(counts ?? NO_COLLECTIONS) };
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

  if (profiles.length === 0) {
    return [];
  }

  const counts = await countsByProfileId(
    db,
    profiles.map(profile => profile.id)
  );
  return profiles.map(profile => toProfileSummary(profile, counts.get(profile.id)));
}

/**
 * One profile's metadata and collection counts.
 *
 * The profile editor's Overview renders metadata and six counts and nothing
 * else, so it reads this instead of {@link getProfile}: a profile may carry
 * every skill's markdown and companion files (bounded per profile by the skill
 * caps), and transferring all of it to render counts alone spends the client's
 * request budget on bytes the screen never uses.
 */
export async function getProfileOverview(
  db: WorkerDb,
  profileId: string,
  owner: ProfileOwner
): Promise<ProfileSummary> {
  const profile = await verifyProfileOwnership(db, profileId, owner);
  const counts = await countsByProfileId(db, [profile.id]);
  return toProfileSummary(
    {
      id: profile.id,
      name: profile.name,
      description: profile.description,
      isDefault: profile.is_default,
      createdAt: profile.created_at,
      updatedAt: profile.updated_at,
    },
    counts.get(profile.id)
  );
}

/**
 * Get a single profile with all of its collections.
 * Secret values are masked.
 */
export async function getProfile(
  db: WorkerDb,
  profileId: string,
  owner: ProfileOwner
): Promise<ProfileResponse> {
  const profile = await verifyProfileOwnership(db, profileId, owner);

  const [vars, commands, mcpServers, skills, agents, kiloCommands, instructions] =
    await Promise.all([
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
      listInstructionsForProfile(db, profileId),
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
    instructions,
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
    await tx
      .update(agent_environment_profiles)
      .set({ is_default: false })
      .where(and(buildOwnershipCondition(owner), eq(agent_environment_profiles.is_default, true)));

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
