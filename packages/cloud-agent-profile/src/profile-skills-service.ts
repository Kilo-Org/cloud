import type { WorkerDb } from '@kilocode/db';
import {
  agent_environment_profile_skills,
  type AgentEnvironmentProfileSkill,
} from '@kilocode/db/schema';
import { and, eq, count } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { ProfileOwner, ProfileSkillResponse } from './types';
import { verifyProfileOwnership } from './profile-utils';
import {
  MAX_PROFILE_SKILLS,
  MAX_SKILL_NAME_LENGTH,
  MAX_SKILL_MARKDOWN_LENGTH,
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_COMPANION_FILES,
  MAX_SKILL_COMPANION_FILE_SIZE,
  MAX_SKILL_COMPANION_FILES_TOTAL,
  MAX_SKILL_COMPANION_PATH_LENGTH,
  skillNameSchema,
  skillFilesSchema,
  skillCustomInputSchema,
  skillUpdateInputSchema,
  parseSkillFrontmatter,
  type SkillCustomInput,
  type SkillUpdateInput,
} from './contracts/skills';

export {
  MAX_PROFILE_SKILLS,
  MAX_SKILL_NAME_LENGTH,
  MAX_SKILL_MARKDOWN_LENGTH,
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_COMPANION_FILES,
  MAX_SKILL_COMPANION_FILE_SIZE,
  MAX_SKILL_COMPANION_FILES_TOTAL,
  MAX_SKILL_COMPANION_PATH_LENGTH,
  skillNameSchema,
  skillFilesSchema,
  skillCustomInputSchema,
  skillUpdateInputSchema,
  parseSkillFrontmatter,
};
export type { SkillCustomInput, SkillUpdateInput };

function toResponse(skill: AgentEnvironmentProfileSkill): ProfileSkillResponse {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    sourceType: skill.source_type,
    sourceUrl: skill.source_url,
    rawMarkdown: skill.raw_markdown,
    files: skill.files ?? {},
    enabled: skill.enabled,
    createdAt: skill.created_at,
    updatedAt: skill.updated_at,
  };
}

async function assertSkillLimit(db: WorkerDb, profileId: string): Promise<void> {
  const [row] = await db
    .select({ n: count() })
    .from(agent_environment_profile_skills)
    .where(eq(agent_environment_profile_skills.profile_id, profileId));
  if (Number(row.n) >= MAX_PROFILE_SKILLS) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Profiles are limited to ${MAX_PROFILE_SKILLS} skills`,
    });
  }
}

async function fetchSkill(
  db: WorkerDb,
  skillId: string,
  profileId: string
): Promise<AgentEnvironmentProfileSkill> {
  const [skill] = await db
    .select()
    .from(agent_environment_profile_skills)
    .where(
      and(
        eq(agent_environment_profile_skills.id, skillId),
        eq(agent_environment_profile_skills.profile_id, profileId)
      )
    )
    .limit(1);
  if (!skill) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Skill not found' });
  }
  return skill;
}

/**
 * List all skills for a profile in name order.
 * Internal: no ownership check; used by `profile-service.getProfile`.
 */
export async function listSkillsForProfile(
  db: WorkerDb,
  profileId: string
): Promise<ProfileSkillResponse[]> {
  const skills = await db
    .select()
    .from(agent_environment_profile_skills)
    .where(eq(agent_environment_profile_skills.profile_id, profileId))
    .orderBy(agent_environment_profile_skills.name);
  return skills.map(toResponse);
}

export async function createCustomSkill(
  db: WorkerDb,
  profileId: string,
  input: SkillCustomInput,
  owner: ProfileOwner
): Promise<{ id: string }> {
  await verifyProfileOwnership(db, profileId, owner);
  await assertSkillLimit(db, profileId);

  const [row] = await db
    .insert(agent_environment_profile_skills)
    .values({
      profile_id: profileId,
      name: input.name,
      description: input.description ?? null,
      source_type: 'custom',
      source_url: null,
      raw_markdown: input.rawMarkdown,
      files: input.files ?? {},
      enabled: input.enabled ?? true,
    })
    .returning({ id: agent_environment_profile_skills.id });

  return { id: row.id };
}

export async function updateSkill(
  db: WorkerDb,
  profileId: string,
  skillId: string,
  input: SkillUpdateInput,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);
  await fetchSkill(db, skillId, profileId);

  const updates: Partial<AgentEnvironmentProfileSkill> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.rawMarkdown !== undefined) updates.raw_markdown = input.rawMarkdown;
  if (input.files !== undefined) updates.files = input.files;
  if (input.enabled !== undefined) updates.enabled = input.enabled;

  if (Object.keys(updates).length === 0) {
    return;
  }

  await db
    .update(agent_environment_profile_skills)
    .set(updates)
    .where(eq(agent_environment_profile_skills.id, skillId));
}

export async function deleteSkill(
  db: WorkerDb,
  profileId: string,
  skillId: string,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);
  await fetchSkill(db, skillId, profileId);
  await db
    .delete(agent_environment_profile_skills)
    .where(eq(agent_environment_profile_skills.id, skillId));
}

export async function setSkillEnabled(
  db: WorkerDb,
  profileId: string,
  skillId: string,
  enabled: boolean,
  owner: ProfileOwner
): Promise<void> {
  await verifyProfileOwnership(db, profileId, owner);
  await fetchSkill(db, skillId, profileId);
  await db
    .update(agent_environment_profile_skills)
    .set({ enabled })
    .where(eq(agent_environment_profile_skills.id, skillId));
}

/**
 * Shape used for session materialization. Only enabled skills are returned.
 * Internal: no ownership check.
 */
export type SkillForSession = {
  name: string;
  rawMarkdown: string;
  files: Record<string, string>;
};

export async function getSkillsForSession(
  db: WorkerDb,
  profileId: string
): Promise<SkillForSession[]> {
  const skills = await db
    .select({
      name: agent_environment_profile_skills.name,
      rawMarkdown: agent_environment_profile_skills.raw_markdown,
      files: agent_environment_profile_skills.files,
    })
    .from(agent_environment_profile_skills)
    .where(
      and(
        eq(agent_environment_profile_skills.profile_id, profileId),
        eq(agent_environment_profile_skills.enabled, true)
      )
    )
    .orderBy(agent_environment_profile_skills.name);
  return skills.map(s => ({ ...s, files: s.files ?? {} }));
}
